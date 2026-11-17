// Customer notices: a person on the team tells people outside it what is happening. Never automatic, and never carrying
// anything from the alert itself: only the words the sender wrote and the service's name leave. See docs/alarm-permissions.md.
import { addEvent, getIncident } from "../incidents";
import type { Env, Incident, User } from "../types";
import { HttpError, newId, now, parseJson } from "../util";
import { BACKOFF_S, type OutboxRow } from "./dispatch";

const DAY = 86_400_000;
/** One notice per incident in this long: a slip of the thumb must not message every customer twice. */
export const NOTICE_GAP_MS = 5 * 60_000;
export const NOTICES_PER_DAY = 20;

export const mayNotify = (u: Pick<User, "role" | "can_notify_customers">) => u.role === "admin" || !!u.can_notify_customers;
export const isEmergency = (i: Pick<Incident, "severity" | "status">) => i.status !== "resolved" && (i.severity === "critical" || i.severity === "error");
export const isLive = (env: Env) => env.CUSTOMER_NOTIFY === "on";

type CustomerRow = { id: string; name: string; type: string; config: string };

const AUDIENCE = `SELECT id, name, type, config FROM customers WHERE enabled = 1 AND (service_id IS NULL OR service_id = ?)`;

export async function audienceFor(env: Env, serviceId: string): Promise<CustomerRow[]> {
  return (await env.DB.prepare(AUDIENCE).bind(serviceId).all<CustomerRow>()).results;
}

export async function sendNotice(env: Env, incident: Incident, actor: User, message: string) {
  if (!mayNotify(actor)) throw new HttpError(403, "you may not notify customers");
  if (!isEmergency(incident)) throw new HttpError(409, "only open critical or error incidents can notify customers");
  const text = message.trim();
  if (!text || text.length > 1000) throw new HttpError(400, "message must be 1 to 1000 characters");
  const t = now();
  const last = await env.DB.prepare(`SELECT created_at FROM customer_notices WHERE incident_id = ? ORDER BY created_at DESC LIMIT 1`).bind(incident.id).first<{ created_at: number }>();
  if (last && t - last.created_at < NOTICE_GAP_MS) throw new HttpError(429, "customers were told about this incident less than 5 minutes ago");
  const today = await env.DB.prepare(`SELECT COUNT(*) AS n FROM customer_notices WHERE created_at > ?`).bind(t - DAY).first<{ n: number }>();
  if (today!.n >= NOTICES_PER_DAY) throw new HttpError(429, "the daily limit of customer notices is reached");
  const audience = await audienceFor(env, incident.service_id);
  if (audience.length === 0) throw new HttpError(409, "no customers are listed for this service");

  const id = newId("ntc");
  const dryRun = !isLive(env);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO customer_notices (id, incident_id, actor, message, audience, dry_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, incident.id, actor.id, text, audience.length, dryRun ? 1 : 0, t),
    ...(dryRun
      ? []
      : audience.map((c) =>
          env.DB.prepare(`INSERT INTO outbox (incident_id, user_id, contact_method_id, event, due_at) VALUES (?, ?, ?, 'customer', ?)`).bind(incident.id, id, c.id, t),
        )),
    addEvent(env, incident.id, dryRun ? "customer_notice_dry_run" : "customer_notice", { actor: actor.id, message: text, at: t, data: { audience: audience.length } }),
  ]);
  env.wake();
  return { id, audience: audience.length, dry_run: dryRun };
}

async function post(cfg: Record<string, string>, type: string, service: string, message: string, noticeId: string): Promise<void> {
  const signal = AbortSignal.timeout(15_000);
  let res: Response;
  if (type === "webhook") {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.authorization) headers.Authorization = cfg.authorization;
    res = await fetch(cfg.url, { method: "POST", headers, body: JSON.stringify({ event: "customer_notice", notice_id: noticeId, service, message }), signal });
  } else if (type === "slack") {
    res = await fetch(cfg.webhook_url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `*${service}*: ${message}` }), signal });
  } else if (type === "ntfy") {
    const headers: Record<string, string> = { Title: `${service} service notice`, Priority: "4" };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    res = await fetch(`${(cfg.server || "https://ntfy.sh").replace(/\/$/, "")}/${encodeURIComponent(cfg.topic)}`, { method: "POST", headers, body: message, signal });
  } else throw new Error(`unknown customer channel ${type}`);
  if (!res.ok) throw new Error(`${type}: HTTP ${res.status}`);
}

/** One outbox row: retried like a page, and written on the timeline if it is given up on. */
export async function deliverNotice(env: Env, row: OutboxRow): Promise<void> {
  const done = () => env.DB.prepare(`DELETE FROM outbox WHERE id = ?`).bind(row.id).run();
  const [customer, notice, incident] = await Promise.all([
    env.DB.prepare(`SELECT id, name, type, config FROM customers WHERE id = ?`).bind(row.contact_method_id).first<CustomerRow>(),
    env.DB.prepare(`SELECT id, message FROM customer_notices WHERE id = ?`).bind(row.user_id).first<{ id: string; message: string }>(),
    getIncident(env, row.incident_id),
  ]);
  if (!customer || !notice || !incident) return void (await done());
  try {
    await post(parseJson(customer.config, {}), customer.type, incident.service_name ?? "Service", notice.message, notice.id);
    await done();
  } catch (e) {
    console.error("customer notice failed", customer.id, e);
    const backoff = BACKOFF_S[row.attempts];
    if (backoff === undefined) {
      await done();
      await addEvent(env, incident.id, "customer_notice_failed", { message: `${customer.name}: ${e}`.slice(0, 500) }).run();
      return;
    }
    await env.DB.prepare(`UPDATE outbox SET attempts = attempts + 1, due_at = ? WHERE id = ?`).bind(now() + backoff * 1000, row.id).run();
  }
}
