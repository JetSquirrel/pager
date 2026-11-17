// Delivery to the channels that are plain HTTP: ntfy (mobile/desktop push), Slack, generic webhooks.
import { actionUrl } from "../actions";
import type { Env, Incident, NotifyEvent } from "../types";

export interface NtfyConfig {
  /** Default https://ntfy.sh. Self-hosted servers work the same. */
  server?: string;
  topic: string;
  /** Access token for protected topics. */
  token?: string;
}

export interface WebhookConfig {
  url: string;
  /** Sent as Authorization header when set. */
  authorization?: string;
}

export interface SlackConfig {
  webhook_url: string;
}

const verb: Record<NotifyEvent, string> = {
  trigger: "TRIGGERED",
  acknowledge: "Acknowledged",
  resolve: "Resolved",
  reassign: "Reassigned",
  notice: "Notice",
  test: "Test page",
};

export function headline(incident: Incident, event: NotifyEvent): string {
  return `[${verb[event]}] ${incident.number ? `#${incident.number} ` : ""}${incident.title}`;
}

/** A hung endpoint must not hold up the other pages in this pass. */
const timeout = () => AbortSignal.timeout(15_000);

async function check(res: Response, what: string) {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export async function sendNtfy(env: Env, cfg: NtfyConfig, incident: Incident, userId: string, event: NotifyEvent) {
  const paging = event === "trigger" || event === "test";
  const headers: Record<string, string> = {
    Title: headline(incident, event),
    // 5 = "max": long vibration bursts and a pop-over notification on Android, and a time-sensitive alert on iOS.
    Priority: paging ? (incident.severity === "critical" || event === "test" ? "5" : "4") : "2",
    Tags: paging ? (incident.severity === "critical" ? "rotating_light" : "warning") : "white_check_mark",
    Click: `${env.PUBLIC_URL}/app/#/incidents/${incident.id}`,
  };
  if (paging && event !== "test") {
    headers.Actions = [
      `http, Acknowledge, ${await actionUrl(env, incident.id, userId, "ack")}, method=POST, clear=true`,
      `http, Resolve, ${await actionUrl(env, incident.id, userId, "resolve")}, method=POST, clear=true`,
    ].join("; ");
  }
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const body = [incident.service_name, incident.source, `severity: ${incident.severity}`].filter(Boolean).join("  ");
  const res = await fetch(`${(cfg.server || "https://ntfy.sh").replace(/\/$/, "")}/${encodeURIComponent(cfg.topic)}`, {
    method: "POST",
    headers,
    body,
    signal: timeout(),
  });
  await check(res, "ntfy");
}

export async function sendWebhook(env: Env, cfg: WebhookConfig, incident: Incident, userId: string, event: NotifyEvent) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.authorization) headers.Authorization = cfg.authorization;
  const res = await fetch(cfg.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      event,
      user_id: userId,
      incident,
      links: {
        incident: `${env.PUBLIC_URL}/app/#/incidents/${incident.id}`,
        acknowledge: event === "trigger" ? await actionUrl(env, incident.id, userId, "ack") : undefined,
        resolve: event !== "resolve" && event !== "notice" ? await actionUrl(env, incident.id, userId, "resolve") : undefined,
      },
    }),
    signal: timeout(),
  });
  await check(res, "webhook");
}

export async function sendSlack(env: Env, cfg: SlackConfig, incident: Incident, userId: string, event: NotifyEvent) {
  const icon = event === "trigger" ? (incident.severity === "critical" ? ":rotating_light:" : ":warning:") : ":white_check_mark:";
  const ack = event === "trigger" ? `  <${await actionUrl(env, incident.id, userId, "ack")}|Acknowledge>` : "";
  const res = await fetch(cfg.webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${icon} *${headline(incident, event)}*\n${incident.service_name ?? ""}  ${incident.severity}` +
        `  <${env.PUBLIC_URL}/app/#/incidents/${incident.id}|Open>${ack}`,
    }),
    signal: timeout(),
  });
  await check(res, "slack");
}
