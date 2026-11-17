// The outbox: every page is a row, written in the same turn as the state that caused it, and delivered by the alarm.
// A row is one contact method, so a siren that failed is retried without paging the phone that already rang.
import type { Db } from "../db";
import { addEvent, getIncident } from "../incidents";
import { deliverNotice } from "./customers";
import type { Env, Incident, NotifyEvent } from "../types";
import { now, parseJson, severityRank } from "../util";
import { sendNtfy, sendSlack, sendWebhook, type NtfyConfig, type SlackConfig, type WebhookConfig } from "./channels";
import { sendTuya, type TuyaConfig } from "./tuya";
import { sendWebPush, SubscriptionGone, type WebPushConfig } from "./webpush";

export interface ContactMethodRow {
  id: string;
  user_id: string;
  type: string;
  label: string;
  config: string;
  min_severity: string;
  enabled: number;
  delay_min: number;
  last_error: string | null;
}

export interface OutboxRow {
  id: number;
  incident_id: string;
  user_id: string;
  contact_method_id: string;
  /** "customer": user_id holds the notice and contact_method_id the customer (src/notify/customers.ts). */
  event: NotifyEvent | "customer";
  attempts: number;
}

/** Seconds to wait after the nth failure; after the last one the page is given up on. */
export const BACKOFF_S = [5, 10, 20, 40, 60];
/** Free-plan Workers may make 50 subrequests per invocation, and a Tuya page can take four. The next pass starts at once. */
const BATCH = 12;
const TEST_CLEAR_AFTER_MS = 15_000;

export async function deliver(env: Env, cm: ContactMethodRow, incident: Incident, event: NotifyEvent): Promise<void> {
  const cfg = parseJson<Record<string, unknown>>(cm.config, {});
  switch (cm.type) {
    case "tuya":
      return sendTuya(env, cfg as unknown as TuyaConfig, incident, event);
    case "ntfy":
      return sendNtfy(env, cfg as unknown as NtfyConfig, incident, cm.user_id, event);
    case "webhook":
      return sendWebhook(env, cfg as unknown as WebhookConfig, incident, cm.user_id, event);
    case "slack":
      return sendSlack(env, cfg as unknown as SlackConfig, incident, cm.user_id, event);
    case "webpush":
      return sendWebPush(env, cfg as unknown as WebPushConfig, incident, cm.user_id, event);
    default:
      throw new Error(`unknown contact method type ${cm.type}`);
  }
}

/** Whether a method gets this event: paging honours min_severity; clears always go out so sirens stop. */
export function wants(cm: Pick<ContactMethodRow, "enabled" | "min_severity">, incident: Incident, event: NotifyEvent): boolean {
  if (!cm.enabled) return false;
  if (event === "trigger") return severityRank(incident.severity) >= severityRank(cm.min_severity);
  return true;
}

const insertRow = (env: Env, incidentId: string, userId: string, cmId: string, event: NotifyEvent, dueAt: number) =>
  env.DB.prepare(`INSERT INTO outbox (incident_id, user_id, contact_method_id, event, due_at) VALUES (?, ?, ?, ?, ?)`).bind(incidentId, userId, cmId, event, dueAt);

/**
 * Queues `event` to every contact method of these users. A paged user nothing can reach is written on the timeline.
 * Returns how many of them something can reach: a hardware pager counts, it asks for its state on its own.
 */
export async function enqueue(env: Env, incident: Incident, userIds: string[], event: NotifyEvent): Promise<number> {
  if (userIds.length === 0) return 0;
  const { results } = await env.DB.prepare(`SELECT * FROM contact_methods WHERE user_id IN (${userIds.map(() => "?").join(",")})`)
    .bind(...userIds)
    .all<ContactMethodRow>();
  const methods = results.filter((cm) => wants(cm, incident, event));
  const t = now();
  let unreachable = event === "trigger" ? userIds.filter((u) => !methods.some((m) => m.user_id === u)) : [];
  if (unreachable.length) {
    const { results: boards } = await env.DB.prepare(`SELECT DISTINCT user_id FROM devices WHERE user_id IN (${unreachable.map(() => "?").join(",")})`)
      .bind(...unreachable)
      .all<{ user_id: string }>();
    unreachable = unreachable.filter((u) => !boards.some((b) => b.user_id === u));
  }
  await env.DB.batch([
    ...methods.map((cm) => insertRow(env, incident.id, cm.user_id, cm.id, event, event === "trigger" ? t + cm.delay_min * 60_000 : t)),
    ...unreachable.map((u) => addEvent(env, incident.id, "notify_failed", { actor: u, message: "No contact method reaches this person for this severity", at: t })),
  ]);
  env.wake();
  return userIds.length - unreachable.length;
}

/** A test page now, and the all-clear that silences a siren a little later. */
export async function enqueueTest(env: Env, incidentId: string, userId: string, cmId: string): Promise<void> {
  const t = now();
  await env.DB.batch([insertRow(env, incidentId, userId, cmId, "test", t), insertRow(env, incidentId, userId, cmId, "resolve", t + TEST_CLEAR_AFTER_MS)]);
  env.wake();
}

export function nextDelivery(db: Db): number | null {
  return (db.execute("SELECT MIN(due_at) AS at FROM outbox", []).rows[0]?.at as number | null) ?? null;
}

export async function drainOutbox(env: Env, at: number): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT id, incident_id, user_id, contact_method_id, event, attempts FROM outbox WHERE due_at <= ? ORDER BY due_at, id LIMIT ?`)
    .bind(at, BATCH)
    .all<OutboxRow>();
  await Promise.all(results.map((row) => deliverRow(env, row)));
}

const done = (env: Env, id: number) => env.DB.prepare(`DELETE FROM outbox WHERE id = ?`).bind(id).run();

async function deliverRow(env: Env, row: OutboxRow): Promise<void> {
  if (row.event === "customer") return deliverNotice(env, row);
  // Rows with no incident behind them: a test page, or word that a paging device has dropped off the network.
  const isTest = row.incident_id.startsWith("test_") || row.incident_id.startsWith("hw_");
  const incident = isTest ? syntheticIncident(row.incident_id) : await getIncident(env, row.incident_id);
  // A page that comes due after the incident was acknowledged must not ring the siren again.
  // Nor one held back by a delay that belongs to someone the incident has since left.
  const stale = row.event === "trigger" && (incident?.status !== "triggered" || !incident.assignees.includes(row.user_id));
  if (!incident || stale) return void (await done(env, row.id));
  const cm = await env.DB.prepare(`SELECT * FROM contact_methods WHERE id = ?`).bind(row.contact_method_id).first<ContactMethodRow>();
  if (!cm) return void (await done(env, row.id));

  const name = `${cm.type}${cm.label ? ` (${cm.label})` : ""}`;
  try {
    await deliver(env, cm, incident, row.event as NotifyEvent);
  } catch (e) {
    if (e instanceof SubscriptionGone) {
      await env.DB.batch([env.DB.prepare(`DELETE FROM contact_methods WHERE id = ?`).bind(cm.id), env.DB.prepare(`DELETE FROM outbox WHERE contact_method_id = ?`).bind(cm.id)]);
      if (!isTest) await addEvent(env, incident.id, "notify_failed", { actor: cm.user_id, message: `${name}: this device is no longer subscribed, removed it` }).run();
      return;
    }
    console.error("delivery failed", row, e);
    const backoff = BACKOFF_S[row.attempts];
    const message = `${name}: ${e}`.slice(0, 1000);
    if (row.attempts === 0) await env.DB.prepare(`UPDATE contact_methods SET last_error = ?, last_error_at = ? WHERE id = ?`).bind(String(e).slice(0, 300), now(), cm.id).run();
    if (backoff === undefined) {
      await done(env, row.id);
      if (!isTest) await addEvent(env, incident.id, "notify_gave_up", { actor: cm.user_id, message, data: { event: row.event } }).run();
      return;
    }
    await env.DB.prepare(`UPDATE outbox SET attempts = attempts + 1, due_at = ? WHERE id = ?`).bind(now() + backoff * 1000, row.id).run();
    // One line for the first failure; the rest would only repeat it.
    if (!isTest && row.attempts === 0) await addEvent(env, incident.id, "notify_failed", { actor: cm.user_id, message, data: { event: row.event } }).run();
    return;
  }
  await done(env, row.id);
  // Written only when it tells the alarm check something new: a delivery is otherwise one row and not two.
  if (cm.last_error !== null || isTest) await env.DB.prepare(`UPDATE contact_methods SET last_error = NULL, last_error_at = NULL, last_ok_at = ? WHERE id = ?`).bind(now(), cm.id).run();
  if (!isTest && env.pressure() !== "shed") {
    await addEvent(env, incident.id, "notify_sent", { actor: cm.user_id, message: `${row.event}: ${name}`, data: { event: row.event } }).run();
  }
}

function syntheticIncident(id: string): Incident {
  const t = Date.now();
  return {
    id,
    number: 0,
    service_id: "",
    service_name: "Pager",
    dedup_key: "test",
    title: id.startsWith("hw_") ? "A Tuya paging device has gone offline. See Alarm check in Settings." : "This is a test page",
    severity: id.startsWith("hw_") ? "warning" : "critical",
    status: "triggered",
    source: "pager",
    details: {},
    alert_count: 1,
    escalation_step: 0,
    assignees: [],
    created_at: t,
    updated_at: t,
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    resolved_by: null,
    snoozed_until: null,
  };
}
