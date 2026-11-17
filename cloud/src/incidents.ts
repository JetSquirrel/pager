import { rearm, startEscalation, stopEscalation } from "./escalation";
import { enqueue } from "./notify/dispatch";
import type { AlertEvent, Env, Incident, IncidentStatus, NotifyEvent } from "./types";
import { newId, now, parseJson } from "./util";

/** The part of ExecutionContext we use (Hono and the runtime type it differently). */
export type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

type Row = Record<string, unknown>;

export function rowToIncident(r: Row): Incident {
  return {
    ...(r as unknown as Incident),
    details: parseJson(r.details as string, {}),
    assignees: parseJson(r.assignees as string, []),
  };
}

const SELECT = `SELECT i.*, s.name AS service_name FROM incidents i JOIN services s ON s.id = i.service_id`;

export async function getIncident(env: Env, id: string): Promise<Incident | null> {
  const r = await env.DB.prepare(`${SELECT} WHERE i.id = ?1 OR i.number = ?1`).bind(id).first<Row>();
  return r ? rowToIncident(r) : null;
}

export async function listIncidents(
  env: Env,
  opts: { statuses: IncidentStatus[]; limit: number; before?: number },
): Promise<Incident[]> {
  const marks = opts.statuses.map((_, i) => `?${i + 3}`).join(",");
  const { results } = await env.DB.prepare(
    `${SELECT} WHERE i.status IN (${marks}) AND i.created_at < ?1 ORDER BY i.created_at DESC LIMIT ?2`,
  )
    .bind(opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit, ...opts.statuses)
    .all<Row>();
  return results.map(rowToIncident);
}

export async function listEvents(env: Env, incidentId: string) {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.at, e.kind, e.actor, u.name AS actor_name, e.message, e.data
       FROM incident_events e LEFT JOIN users u ON u.id = e.actor
      WHERE e.incident_id = ? ORDER BY e.at, e.id`,
  )
    .bind(incidentId)
    .all<Row>();
  return results.map((e) => ({ ...e, data: parseJson(e.data as string, {}) }));
}

export function addEvent(
  env: Env,
  incidentId: string,
  kind: string,
  opts: { actor?: string | null; message?: string; data?: unknown; at?: number } = {},
) {
  return env.DB.prepare(
    `INSERT INTO incident_events (incident_id, at, kind, actor, message, data) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(incidentId, opts.at ?? now(), kind, opts.actor ?? null, opts.message ?? "", JSON.stringify(opts.data ?? {}));
}

async function findOpen(env: Env, serviceId: string, dedupKey: string): Promise<Incident | null> {
  const r = await env.DB.prepare(`${SELECT} WHERE i.service_id = ? AND i.dedup_key = ? AND i.status != 'resolved'`)
    .bind(serviceId, dedupKey)
    .first<Row>();
  return r ? rowToIncident(r) : null;
}

/** Applies one alert event from an integration. Returns the incident it landed on, if any. */
export async function processAlert(
  env: Env,
  ctx: WaitUntil,
  service: { id: string; name: string },
  ev: AlertEvent,
): Promise<{ incident: Incident | null; result: "created" | "deduplicated" | "acknowledged" | "resolved" | "ignored" }> {
  const open = await findOpen(env, service.id, ev.dedup_key);

  if (ev.action === "acknowledge") {
    if (!open || open.status !== "triggered") return { incident: open, result: "ignored" };
    return { incident: await acknowledge(env, ctx, open, null, `Acknowledged by ${ev.source || "integration"}`), result: "acknowledged" };
  }
  if (ev.action === "resolve") {
    if (!open) return { incident: null, result: "ignored" };
    return { incident: await resolve(env, ctx, open, null, `Resolved by ${ev.source || "integration"}`), result: "resolved" };
  }

  if (open) {
    const t = now();
    await env.DB.batch([
      env.DB.prepare(`UPDATE incidents SET alert_count = alert_count + 1, updated_at = ? WHERE id = ?`).bind(t, open.id),
      // An alert storm must not eat the day's write budget: the count is enough once the budget is tight.
      ...(env.pressure() === "ok" ? [addEvent(env, open.id, "alert_repeated", { message: ev.title, at: t })] : []),
    ]);
    const updated = { ...open, alert_count: open.alert_count + 1, updated_at: t };
    ctx.waitUntil(broadcast(env, "incident.updated", updated));
    return { incident: updated, result: "deduplicated" };
  }

  const t = now();
  const counter = await env.DB.prepare(
    `UPDATE counters SET value = value + 1 WHERE name = 'incident_number' RETURNING value`,
  ).first<{ value: number }>();
  const id = newId("inc");
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO incidents (id, number, service_id, dedup_key, title, severity, source, details, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, counter!.value, service.id, ev.dedup_key, ev.title, ev.severity, ev.source, JSON.stringify(ev.details), t, t),
      addEvent(env, id, "triggered", { message: ev.title, at: t, data: { source: ev.source } }),
    ]);
  } catch (e) {
    // Another request opened the same (service, dedup_key) between our lookup and insert: fold into it.
    if (String(e).includes("UNIQUE")) return processAlert(env, ctx, service, ev);
    throw e;
  }
  await startEscalation(env, id);
  const incident = (await getIncident(env, id))!;
  ctx.waitUntil(broadcast(env, "incident.triggered", incident));
  return { incident, result: "created" };
}

export async function acknowledge(
  env: Env,
  ctx: WaitUntil,
  incident: Incident,
  actor: string | null,
  message = "Acknowledged",
): Promise<Incident> {
  if (incident.status !== "triggered") return incident;
  const t = now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE incidents SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ?
        WHERE id = ? AND status = 'triggered'`,
    ).bind(t, actor, t, incident.id),
    addEvent(env, incident.id, "acknowledged", { actor, message, at: t }),
  ]);
  if (!res[0].meta.changes) return (await getIncident(env, incident.id))!;
  await stopEscalation(env, incident.id);
  const updated = (await getIncident(env, incident.id))!;
  await notifyUsers(env, updated, updated.assignees, "acknowledge");
  env.wake();
  ctx.waitUntil(broadcast(env, "incident.updated", updated));
  return updated;
}

export async function resolve(
  env: Env,
  ctx: WaitUntil,
  incident: Incident,
  actor: string | null,
  message = "Resolved",
): Promise<Incident> {
  if (incident.status === "resolved") return incident;
  const t = now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE incidents SET status = 'resolved', resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND status != 'resolved'`,
    ).bind(t, actor, t, incident.id),
    addEvent(env, incident.id, "resolved", { actor, message, at: t }),
  ]);
  if (!res[0].meta.changes) return (await getIncident(env, incident.id))!;
  await stopEscalation(env, incident.id);
  const updated = (await getIncident(env, incident.id))!;
  await notifyUsers(env, updated, updated.assignees, "resolve");
  env.wake();
  ctx.waitUntil(broadcast(env, "incident.updated", updated));
  return updated;
}

/** Silences an open incident for a while: its pages stop, and the policy starts over when the time is up. */
export async function snooze(env: Env, ctx: WaitUntil, incident: Incident, actor: string, minutes: number): Promise<Incident> {
  const t = now();
  const until = t + minutes * 60_000;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE incidents SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, ?), acknowledged_by = COALESCE(acknowledged_by, ?), snoozed_until = ?, updated_at = ? WHERE id = ?`,
    ).bind(t, actor, until, t, incident.id),
    env.DB.prepare(`UPDATE escalations SET stopped = 0, step = -1, next_at = ? WHERE incident_id = ?`).bind(until, incident.id),
    addEvent(env, incident.id, "snoozed", { actor, message: `For ${minutes} min`, at: t, data: { until } }),
  ]);
  const updated = (await getIncident(env, incident.id))!;
  if (incident.status === "triggered") await notifyUsers(env, updated, updated.assignees, "acknowledge");
  env.wake();
  ctx.waitUntil(broadcast(env, "incident.updated", updated));
  return updated;
}

/** Hands an open incident to one person: it pages them now, and the people it left stop ringing. */
export async function reassign(env: Env, ctx: WaitUntil, incident: Incident, actor: string, user: { id: string; name: string }): Promise<Incident> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE incidents SET status = 'triggered', assignees = ?, acknowledged_at = NULL, acknowledged_by = NULL, snoozed_until = NULL, updated_at = ? WHERE id = ?`,
    ).bind(JSON.stringify([user.id]), t, incident.id),
    addEvent(env, incident.id, "reassigned", { actor, message: `To ${user.name}`, at: t, data: { user: user.id } }),
  ]);
  await rearm(env, incident.id);
  const updated = (await getIncident(env, incident.id))!;
  await notifyUsers(env, updated, incident.assignees.filter((u) => u !== user.id), "reassign");
  await notifyUsers(env, updated, [user.id], "trigger");
  env.wake();
  ctx.waitUntil(broadcast(env, "incident.updated", updated));
  return updated;
}

export async function addNote(env: Env, incident: Incident, actor: string, message: string) {
  await addEvent(env, incident.id, "note", { actor, message }).run();
  await broadcast(env, "incident.updated", incident);
}

/** Returns how many of these people something can reach. */
export async function notifyUsers(env: Env, incident: Incident, userIds: string[], event: NotifyEvent): Promise<number> {
  return enqueue(env, incident, userIds, event);
}

export async function broadcast(env: Env, type: string, incident: Incident) {
  env.publish(JSON.stringify({ type, incident }));
}
