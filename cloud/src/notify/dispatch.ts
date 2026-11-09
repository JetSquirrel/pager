// Queue consumer: one message = page one user about one incident (or tell them it was acked/resolved).
// Each contact method is tried independently; a failure on one is logged on the timeline and retried by the queue.
import { addEvent, getIncident } from "../incidents";
import type { Env, Incident, NotifyEvent, NotifyMessage } from "../types";
import { parseJson, severityRank } from "../util";
import { sendNtfy, sendSlack, sendWebhook, type NtfyConfig, type SlackConfig, type WebhookConfig } from "./channels";
import { sendTuya, type TuyaConfig } from "./tuya";

export interface ContactMethodRow {
  id: string;
  user_id: string;
  type: string;
  label: string;
  config: string;
  min_severity: string;
  enabled: number;
}

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

export async function handleNotify(env: Env, msg: NotifyMessage): Promise<void> {
  // Test pages carry a synthetic incident id ("test_..."); the API follows each with a delayed "resolve" to silence devices.
  const isTest = msg.incident_id.startsWith("test_");
  const incident = isTest ? testIncident(msg.incident_id) : await getIncident(env, msg.incident_id);
  if (!incident) return;
  // A page that arrives after the incident was acknowledged must not ring the siren again.
  if (msg.event === "trigger" && incident.status !== "triggered") return;

  const { results } = await env.DB.prepare(
    msg.contact_method_id
      ? `SELECT * FROM contact_methods WHERE user_id = ?1 AND id = ?2`
      : `SELECT * FROM contact_methods WHERE user_id = ?1`,
  )
    .bind(msg.user_id, ...(msg.contact_method_id ? [msg.contact_method_id] : []))
    .all<ContactMethodRow>();

  const methods = results.filter((cm) => msg.contact_method_id || wants(cm, incident, msg.event));
  const outcomes = await Promise.allSettled(methods.map((cm) => deliver(env, cm, incident, msg.event)));
  const failures = outcomes
    .map((o, i) => (o.status === "rejected" ? `${methods[i].type}${methods[i].label ? ` (${methods[i].label})` : ""}: ${o.reason}` : null))
    .filter((x): x is string => !!x);

  if (!isTest && methods.length > 0) {
    await addEvent(env, incident.id, failures.length ? "notify_failed" : "notify_sent", {
      actor: null,
      message: failures.length ? failures.join("; ").slice(0, 1000) : `${msg.event}: ${methods.map((m) => m.type).join(", ")}`,
      data: { user_id: msg.user_id, event: msg.event },
    }).run();
  }
  // Retry only when every method failed: re-sending would double-page through the ones that worked.
  if (methods.length > 0 && failures.length === methods.length) throw new Error(failures.join("; "));
}

function testIncident(id: string): Incident {
  const t = Date.now();
  return {
    id,
    number: 0,
    service_id: "",
    service_name: "Pager",
    dedup_key: "test",
    title: "This is a test page",
    severity: "critical",
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
  };
}
