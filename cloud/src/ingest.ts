// Parsers that turn monitoring tools' payloads into AlertEvents. Pure functions, tested in test/ingest.test.ts.
import type { AlertEvent } from "./types";
import { HttpError, normalizeSeverity } from "./util";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Generic events, shaped like PagerDuty's Events API v2 so existing senders work unchanged:
 *   { event_action: "trigger"|"acknowledge"|"resolve", dedup_key, payload: { summary, severity, source, custom_details } }
 * A flat form is accepted too: { title, severity, source, dedup_key, action, details }.
 */
export function parseGeneric(body: unknown): AlertEvent[] {
  const b = obj(body);
  const p = obj(b.payload);
  const action = str(b.event_action || b.action || "trigger").toLowerCase();
  if (action !== "trigger" && action !== "acknowledge" && action !== "resolve") {
    throw new HttpError(400, `unknown event_action "${action}"`);
  }
  const title = str(p.summary || b.title || b.summary);
  const dedup_key = str(b.dedup_key || b.incident_key || "");
  if (action === "trigger" && !title) throw new HttpError(400, "payload.summary (or title) is required");
  if (action !== "trigger" && !dedup_key) throw new HttpError(400, "dedup_key is required to acknowledge or resolve");
  return [
    {
      action,
      dedup_key: dedup_key || crypto.randomUUID(),
      title: title.slice(0, 1024),
      severity: normalizeSeverity(p.severity ?? b.severity),
      source: str(p.source || b.source).slice(0, 256),
      details: { ...obj(p.custom_details), ...obj(b.details), ...(b.links ? { links: b.links } : {}) },
    },
  ];
}

/**
 * Prometheus Alertmanager webhook (also what Grafana unified alerting sends).
 * One AlertEvent per alert; the alert's fingerprint keeps repeats in the same incident.
 */
export function parseAlertmanager(body: unknown): AlertEvent[] {
  const b = obj(body);
  if (!Array.isArray(b.alerts)) throw new HttpError(400, "expected an Alertmanager webhook with alerts[]");
  const common = obj(b.commonLabels);
  return b.alerts.map((raw): AlertEvent => {
    const a = obj(raw);
    const labels = { ...common, ...obj(a.labels) };
    const ann = obj(a.annotations);
    const name = str(labels.alertname) || "Alert";
    const where = str(labels.instance || labels.job || labels.service || "");
    const fingerprint = str(a.fingerprint) || stableLabelKey(labels);
    return {
      action: str(a.status) === "resolved" ? "resolve" : "trigger",
      dedup_key: `am:${fingerprint}`,
      title: (str(ann.summary) || (where ? `${name} on ${where}` : name)).slice(0, 1024),
      severity: normalizeSeverity(labels.severity, "error"),
      source: where || str(b.receiver),
      details: {
        labels,
        annotations: ann,
        starts_at: a.startsAt,
        generator_url: a.generatorURL,
        dashboard_url: a.dashboardURL,
        silence_url: a.silenceURL,
        external_url: b.externalURL,
      },
    };
  });
}

function stableLabelKey(labels: Record<string, unknown>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${str(labels[k])}`)
    .join(",");
}
