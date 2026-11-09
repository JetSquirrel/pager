import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyActionToken } from "./actions";
import { deviceApi, devicesAdmin } from "./devices";
import { requireAdmin, requireUser, type AppEnv } from "./auth";
import { FREE, TARGET, pressure } from "./budget";
import { escalateNow, escalationStatus, planStep, repage, resolveTargets } from "./escalation";
import {
  acknowledge,
  addNote,
  getIncident,
  listEvents,
  listIncidents,
  processAlert,
  reassign,
  resolve,
  snooze,
} from "./incidents";
import { parseAlertmanager, parseGeneric } from "./ingest";
import { audienceFor, isEmergency, isLive, mayNotify, sendNotice } from "./notify/customers";
import { enqueueTest } from "./notify/dispatch";
import { TUYA_PRESETS, TuyaClient } from "./notify/tuya";
import { onCallAt, upcomingShifts } from "./oncall";
import type {
  AlertEvent,
  EscalationStep,
  IncidentStatus,
  Override,
  Rotation,
} from "./types";
import { SEVERITIES } from "./types";
import { HttpError, newId, newSecret, now, parseJson, sha256Hex } from "./util";

export const app = new Hono<AppEnv>();

app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "X-Firmware"], maxAge: 86400 }));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

async function body<T = Record<string, unknown>>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined || v === "") throw new HttpError(400, `${what} is required`);
  return v;
}

/** `budget` is "ok", "lean" or "shed": point an uptime check at it, a pager that has run out of quota pages nobody. */
app.get("/v1/health", (c) => c.json({ name: "pager", ok: true, budget: c.env.pressure() }));

// ---------------------------------------------------------------- setup

/** Creates the first admin. Needs BOOTSTRAP_TOKEN and works only while there are no users. */
app.post("/v1/setup", async (c) => {
  const expected = c.env.BOOTSTRAP_TOKEN;
  if (!expected || c.req.header("authorization") !== `Bearer ${expected}`) throw new HttpError(401, "bad bootstrap token");
  const existing = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  if (existing!.n > 0) throw new HttpError(409, "already set up");
  const b = await body<{ email: string; name: string }>(c);
  const token = newSecret();
  const id = newId("usr");
  await c.env.DB.prepare(`INSERT INTO users (id, email, name, role, token_hash, created_at) VALUES (?, ?, ?, 'admin', ?, ?)`)
    .bind(id, need(b.email, "email"), b.name || b.email, await sha256Hex(token), now())
    .run();
  return c.json({ user_id: id, token }, 201);
});

/**
 * Issues a new token for an admin who has lost theirs. A Cloudflare login can always reset BOOTSTRAP_TOKEN
 * (wrangler secret put), so this is the way back in from any machine. The old token stops working.
 */
app.post("/v1/recover", async (c) => {
  const expected = c.env.BOOTSTRAP_TOKEN;
  if (!expected || c.req.header("authorization") !== `Bearer ${expected}`) throw new HttpError(401, "bad bootstrap token");
  const { email } = await body<{ email: string }>(c);
  const token = newSecret();
  const r = await c.env.DB.prepare(`UPDATE users SET token_hash = ? WHERE email = ? AND role = 'admin' RETURNING id`).bind(await sha256Hex(token), need(email, "email")).first<{ id: string }>();
  if (!r) throw new HttpError(404, "no admin with that email");
  return c.json({ user_id: r.id, token });
});

// ---------------------------------------------------------------- ingest

async function ingest(c: any, parse: (b: unknown) => AlertEvent[]) {
  const service = await c.env.DB.prepare(`SELECT id, name FROM services WHERE integration_key = ?`)
    .bind(c.req.param("key"))
    .first();
  if (!service) throw new HttpError(404, "unknown integration key");
  const events = parse(await body(c));
  const results = [];
  for (const ev of events) {
    const r = await processAlert(c.env, c.executionCtx, service, ev);
    results.push({ result: r.result, dedup_key: ev.dedup_key, incident_id: r.incident?.id ?? null, number: r.incident?.number ?? null });
  }
  return c.json({ status: "success", results }, 202);
}

app.post("/v1/integrations/:key/events", (c) => ingest(c, parseGeneric));
app.post("/v1/integrations/:key/alertmanager", (c) => ingest(c, parseAlertmanager));
app.post("/v1/integrations/:key/grafana", (c) => ingest(c, parseAlertmanager));

// ---------------------------------------------------------------- one-tap actions (signed links)

const actionPage = (title: string, inner: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:16px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">${inner}</body>`;

// GET only confirms: link unfurlers and mail scanners fetch links, and must not acknowledge anything.
app.get("/v1/actions/:token", async (c) => {
  const a = await verifyActionToken(c.env, c.req.param("token"));
  if (!a) return c.html(actionPage("Link expired", "<h2>This link has expired.</h2>"), 410);
  const incident = await getIncident(c.env, a.incidentId);
  if (!incident) return c.html(actionPage("Not found", "<h2>Incident not found.</h2>"), 404);
  const label = a.kind === "ack" ? "Acknowledge" : "Resolve";
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return c.html(
    actionPage(
      label,
      `<p>#${incident.number} ${incident.status}</p><h2>${esc(incident.title)}</h2>` +
        `<form method="post"><button style="font-size:1.2rem;padding:.8rem 1.6rem">${label}</button></form>`,
    ),
  );
});

app.post("/v1/actions/:token", async (c) => {
  const a = await verifyActionToken(c.env, c.req.param("token"));
  if (!a) throw new HttpError(410, "link expired");
  const incident = await getIncident(c.env, a.incidentId);
  if (!incident) throw new HttpError(404, "incident not found");
  const updated =
    a.kind === "ack"
      ? await acknowledge(c.env, c.executionCtx, incident, a.userId, "Acknowledged from notification")
      : await resolve(c.env, c.executionCtx, incident, a.userId, "Resolved from notification");
  if ((c.req.header("accept") ?? "").includes("text/html")) {
    return c.html(actionPage("Done", `<h2>#${updated.number} is ${updated.status}.</h2>`));
  }
  return c.json({ incident: updated });
});

// ---------------------------------------------------------------- authenticated API

const api = new Hono<AppEnv>();
api.use("*", requireUser);

api.get("/me", (c) => c.json({ user: c.get("user") }));

api.post("/me/rotate-token", async (c) => {
  const token = newSecret();
  await c.env.DB.prepare(`UPDATE users SET token_hash = ? WHERE id = ?`).bind(await sha256Hex(token), c.get("user").id).run();
  return c.json({ token });
});

/** Live updates. Messages: {type: "hello"|"pong"|"incident.triggered"|"incident.updated", incident?}. */
api.get("/stream", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "expected a WebSocket upgrade");
  return c.env.acceptClient(c.get("user").id);
});

// ---- incidents

const STATUS_SETS: Record<string, IncidentStatus[]> = {
  open: ["triggered", "acknowledged"],
  triggered: ["triggered"],
  acknowledged: ["acknowledged"],
  resolved: ["resolved"],
  all: ["triggered", "acknowledged", "resolved"],
};

api.get("/incidents", async (c) => {
  const statuses = STATUS_SETS[c.req.query("status") ?? "open"];
  if (!statuses) throw new HttpError(400, "status must be open, triggered, acknowledged, resolved or all");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
  return c.json({ incidents: await listIncidents(c.env, { statuses, limit, before }) });
});

async function incidentOr404(c: any) {
  const incident = await getIncident(c.env, c.req.param("id"));
  if (!incident) throw new HttpError(404, "incident not found");
  return incident;
}

api.get("/incidents/:id", async (c) => {
  const incident = await incidentOr404(c);
  const [events, escalation, users] = await Promise.all([
    listEvents(c.env, incident.id),
    escalationStatus(c.env, incident.id),
    incident.assignees.length
      ? c.env.DB.prepare(`SELECT id, name, email FROM users WHERE id IN (${incident.assignees.map(() => "?").join(",")})`)
          .bind(...incident.assignees)
          .all()
          .then((r) => r.results)
      : [],
  ]);
  return c.json({ incident, events, escalation, assignees: users });
});

api.post("/incidents/:id/acknowledge", async (c) =>
  c.json({ incident: await acknowledge(c.env, c.executionCtx, await incidentOr404(c), c.get("user").id) }),
);

api.post("/incidents/:id/resolve", async (c) =>
  c.json({ incident: await resolve(c.env, c.executionCtx, await incidentOr404(c), c.get("user").id) }),
);

api.post("/incidents/:id/notes", async (c) => {
  const incident = await incidentOr404(c);
  const { message } = await body<{ message: string }>(c);
  await addNote(c.env, incident, c.get("user").id, need(message, "message").slice(0, 4000));
  return c.json({ ok: true }, 201);
});

/** Page the current escalation step again (still-triggered incidents only). */
api.post("/incidents/:id/repage", async (c) => {
  const incident = await incidentOr404(c);
  if (incident.status !== "triggered") throw new HttpError(409, "only triggered incidents can be re-paged");
  await repage(c.env, incident.id);
  c.env.wake();
  return c.json({ ok: true });
});

/** Silence an open incident for a while; the policy starts over when the time is up. */
api.post("/incidents/:id/snooze", async (c) => {
  const incident = await incidentOr404(c);
  if (incident.status === "resolved") throw new HttpError(409, "this incident is resolved");
  const { minutes } = await body<{ minutes: number }>(c);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new HttpError(400, "minutes must be a whole number from 1 to 1440");
  return c.json({ incident: await snooze(c.env, c.executionCtx, incident, c.get("user").id, minutes) });
});

/** Hand an open incident to one person, who is paged at once. */
api.post("/incidents/:id/reassign", async (c) => {
  const incident = await incidentOr404(c);
  if (incident.status === "resolved") throw new HttpError(409, "this incident is resolved");
  const { user_id } = await body<{ user_id: string }>(c);
  const user = await c.env.DB.prepare(`SELECT id, name FROM users WHERE id = ?`).bind(need(user_id, "user_id")).first<{ id: string; name: string }>();
  if (!user) throw new HttpError(404, "user not found");
  return c.json({ incident: await reassign(c.env, c.executionCtx, incident, c.get("user").id, user) });
});

/** Go to the next escalation step now. */
api.post("/incidents/:id/escalate", async (c) => {
  const incident = await incidentOr404(c);
  if (incident.status !== "triggered") throw new HttpError(409, "only triggered incidents can be escalated");
  if (!(await escalateNow(c.env, incident.id))) throw new HttpError(409, "this is the last escalation step");
  c.env.wake();
  return c.json({ incident: await getIncident(c.env, incident.id) });
});

/** Acknowledge or resolve several incidents in one request. */
api.post("/incidents/bulk", async (c) => {
  const { action, ids } = await body<{ action: string; ids: string[] }>(c);
  if (action !== "acknowledge" && action !== "resolve") throw new HttpError(400, "action must be acknowledge or resolve");
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50) throw new HttpError(400, "ids must list 1 to 50 incidents");
  const out = [];
  for (const id of ids) {
    const incident = await getIncident(c.env, String(id));
    if (incident) out.push(await (action === "acknowledge" ? acknowledge : resolve)(c.env, c.executionCtx, incident, c.get("user").id));
  }
  return c.json({ incidents: out });
});

/** Who a customer notice for this incident would reach, whether it would really be sent, and what has been said so far. */
api.get("/incidents/:id/customer-notices", async (c) => {
  const incident = await incidentOr404(c);
  const [audience, { results }] = await Promise.all([
    audienceFor(c.env, incident.service_id),
    c.env.DB.prepare(`SELECT id, message, audience, dry_run, created_at FROM customer_notices WHERE incident_id = ? ORDER BY created_at DESC LIMIT 20`).bind(incident.id).all(),
  ]);
  return c.json({ audience: audience.length, live: isLive(c.env), allowed: mayNotify(c.get("user")) && isEmergency(incident), notices: results });
});

api.post("/incidents/:id/customer-notices", async (c) => {
  const incident = await incidentOr404(c);
  const { message } = await body<{ message: string }>(c);
  return c.json(await sendNotice(c.env, incident, c.get("user"), String(message ?? "")), 201);
});

/** Manually open an incident on a service (e.g. a customer report). */
api.post("/incidents", async (c) => {
  const b = await body<{ service_id: string; title: string; severity?: string; details?: Record<string, unknown> }>(c);
  const service = await c.env.DB.prepare(`SELECT id, name FROM services WHERE id = ?`).bind(need(b.service_id, "service_id")).first<{ id: string; name: string }>();
  if (!service) throw new HttpError(404, "service not found");
  const [ev] = parseGeneric({ title: b.title, severity: b.severity, source: `manual:${c.get("user").name}`, details: b.details });
  const r = await processAlert(c.env, c.executionCtx, service, ev);
  return c.json({ incident: r.incident }, 201);
});

// ---- on-call

api.get("/oncall", async (c) => {
  const t = Number(c.req.query("at") ?? now());
  const [{ results: schedules }, { results: overrides }, { results: users }] = await Promise.all([
    c.env.DB.prepare(`SELECT id, name, rotation FROM schedules ORDER BY name`).all<{ id: string; name: string; rotation: string }>(),
    c.env.DB.prepare(`SELECT schedule_id, user_id, starts_at, ends_at FROM schedule_overrides WHERE ends_at > ?`).bind(t).all<Override & { schedule_id: string }>(),
    c.env.DB.prepare(`SELECT id, name, email FROM users`).all<{ id: string; name: string; email: string }>(),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  return c.json({
    at: t,
    schedules: schedules.map((s) => {
      const rotation = parseJson<Rotation>(s.rotation, { start: 0, shift_hours: 0, users: [] });
      const current = onCallAt(rotation, overrides.filter((o) => o.schedule_id === s.id), t);
      const next = upcomingShifts(rotation, current?.ends_at ?? t, t + 14 * 86_400_000, 6);
      return {
        id: s.id,
        name: s.name,
        current: current && { ...current, user: byId.get(current.user_id) ?? null },
        next: next.map((n) => ({ ...n, user: byId.get(n.user_id) ?? null })),
      };
    }),
  });
});

// ---- users (admin manages; everyone can list)

api.get("/users", async (c) =>
  c.json({ users: (await c.env.DB.prepare(`SELECT id, email, name, role, can_notify_customers, timezone, created_at FROM users ORDER BY name`).all()).results }),
);

api.post("/users", requireAdmin, async (c) => {
  const b = await body<{ email: string; name?: string; role?: string; timezone?: string }>(c);
  const token = newSecret();
  const id = newId("usr");
  await c.env.DB.prepare(`INSERT INTO users (id, email, name, role, timezone, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, need(b.email, "email"), b.name || b.email, b.role === "admin" ? "admin" : "responder", b.timezone || "UTC", await sha256Hex(token), now())
    .run();
  return c.json({ user_id: id, token }, 201);
});

api.patch("/users/:id", requireAdmin, async (c) => {
  const b = await body<{ role?: string; can_notify_customers?: boolean }>(c);
  const id = c.req.param("id");
  if (b.role !== undefined && b.role !== "admin" && b.role !== "responder") throw new HttpError(400, "role must be admin or responder");
  if (b.role === "responder") {
    const admins = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?`).bind(id).first<{ n: number }>();
    if (admins!.n === 0) throw new HttpError(409, "this is the last admin");
  }
  if (b.role !== undefined) await c.env.DB.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(b.role, id).run();
  if (b.can_notify_customers !== undefined) await c.env.DB.prepare(`UPDATE users SET can_notify_customers = ? WHERE id = ?`).bind(b.can_notify_customers ? 1 : 0, id).run();
  return c.json({ ok: true });
});

api.delete("/users/:id", requireAdmin, async (c) => {
  await c.env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(c.req.param("id")).run();
  return c.body(null, 204);
});

// ---- customers (people outside the team, reached only by a notice someone chose to send)

const CUSTOMER_TYPES = ["webhook", "slack", "ntfy"];

function redactCustomer(r: any) {
  const cfg = parseJson<Record<string, unknown>>(r.config, {});
  for (const k of ["token", "authorization"]) if (cfg[k]) cfg[k] = "••••";
  return { ...r, enabled: !!r.enabled, config: cfg };
}

api.get("/customers", requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM customers ORDER BY name`).all();
  return c.json({ customers: results.map(redactCustomer), live: isLive(c.env) });
});

api.post("/customers", requireAdmin, async (c) => {
  const b = await body<{ name: string; type: string; config: unknown; service_id?: string | null }>(c);
  if (!CUSTOMER_TYPES.includes(b.type)) throw new HttpError(400, `type must be one of ${CUSTOMER_TYPES.join(", ")}`);
  const config = validateConfig(b.type, b.config);
  const id = newId("cst");
  await c.env.DB.prepare(`INSERT INTO customers (id, name, type, config, service_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, need(b.name, "name").slice(0, 120), b.type, JSON.stringify(config), b.service_id || null, now())
    .run();
  return c.json({ id }, 201);
});

api.delete("/customers/:id", requireAdmin, async (c) => {
  await c.env.DB.prepare(`DELETE FROM customers WHERE id = ?`).bind(c.req.param("id")).run();
  return c.body(null, 204);
});

// ---- escalation policies

function validateSteps(steps: unknown): EscalationStep[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new HttpError(400, "steps must be a non-empty array");
  return steps.map((s: any, i) => {
    if (!Array.isArray(s?.targets) || s.targets.length === 0) throw new HttpError(400, `steps[${i}].targets is required`);
    return {
      delay_min: Math.max(0, Number(s.delay_min ?? 0)),
      targets: s.targets.map((t: any) => {
        if ((t?.type !== "user" && t?.type !== "schedule") || !t.id) throw new HttpError(400, `steps[${i}]: target needs type user|schedule and id`);
        return { type: t.type, id: String(t.id) };
      }),
    };
  });
}

api.get("/escalation-policies", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM escalation_policies ORDER BY name`).all<any>();
  return c.json({ policies: results.map((p) => ({ ...p, steps: parseJson(p.steps, []) })) });
});

api.post("/escalation-policies", requireAdmin, async (c) => {
  const b = await body<{ name: string; steps: unknown; repeat?: number }>(c);
  const id = newId("pol");
  await c.env.DB.prepare(`INSERT INTO escalation_policies (id, name, steps, repeat, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, need(b.name, "name"), JSON.stringify(validateSteps(b.steps)), Math.min(9, Math.max(0, b.repeat ?? 0)), now())
    .run();
  return c.json({ id }, 201);
});

api.put("/escalation-policies/:id", requireAdmin, async (c) => {
  const b = await body<{ name: string; steps: unknown; repeat?: number }>(c);
  await c.env.DB.prepare(`UPDATE escalation_policies SET name = ?, steps = ?, repeat = ? WHERE id = ?`)
    .bind(need(b.name, "name"), JSON.stringify(validateSteps(b.steps)), Math.min(9, Math.max(0, b.repeat ?? 0)), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

/** Dry run: who would be paged at each step right now. */
api.get("/escalation-policies/:id/preview", async (c) => {
  const p = await c.env.DB.prepare(`SELECT * FROM escalation_policies WHERE id = ?`).bind(c.req.param("id")).first<any>();
  if (!p) throw new HttpError(404, "policy not found");
  const policy = { ...p, steps: parseJson<EscalationStep[]>(p.steps, []) };
  const steps = [];
  let at = 0;
  for (let i = 0; i < policy.steps.length; i++) {
    steps.push({ step: i, after_min: at, users: await resolveTargets(c.env, policy.steps[i].targets) });
    const { nextDelayMs } = planStep(policy, i);
    at += (nextDelayMs ?? 0) / 60_000;
  }
  return c.json({ steps });
});

// ---- services

api.get("/services", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM incidents i WHERE i.service_id = s.id AND i.status != 'resolved') AS open_incidents
       FROM services s ORDER BY s.name`,
  ).all<any>();
  const admin = c.get("user").role === "admin";
  return c.json({
    services: results.map((s) => ({
      ...s,
      integration_key: admin ? s.integration_key : undefined,
      endpoints: admin
        ? {
            events: `${c.env.PUBLIC_URL}/v1/integrations/${s.integration_key}/events`,
            alertmanager: `${c.env.PUBLIC_URL}/v1/integrations/${s.integration_key}/alertmanager`,
            grafana: `${c.env.PUBLIC_URL}/v1/integrations/${s.integration_key}/grafana`,
          }
        : undefined,
    })),
  });
});

api.post("/services", requireAdmin, async (c) => {
  const b = await body<{ name: string; description?: string; escalation_policy_id: string }>(c);
  const id = newId("svc");
  const key = newSecret(18);
  await c.env.DB.prepare(`INSERT INTO services (id, name, description, escalation_policy_id, integration_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, need(b.name, "name"), b.description ?? "", need(b.escalation_policy_id, "escalation_policy_id"), key, now())
    .run();
  return c.json({ id, integration_key: key }, 201);
});

// ---- schedules

function validateRotation(r: any): Rotation {
  if (!r || !Array.isArray(r.users) || r.users.length === 0) throw new HttpError(400, "rotation.users must be a non-empty array");
  const shift_hours = Number(r.shift_hours);
  if (!(shift_hours > 0)) throw new HttpError(400, "rotation.shift_hours must be > 0");
  return { start: Number(r.start ?? now()), shift_hours, users: r.users.map(String) };
}

api.get("/schedules", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM schedules ORDER BY name`).all<any>();
  return c.json({ schedules: results.map((s) => ({ ...s, rotation: parseJson(s.rotation, {}) })) });
});

api.post("/schedules", requireAdmin, async (c) => {
  const b = await body<{ name: string; rotation: unknown }>(c);
  const id = newId("sch");
  await c.env.DB.prepare(`INSERT INTO schedules (id, name, rotation, created_at) VALUES (?, ?, ?, ?)`)
    .bind(id, need(b.name, "name"), JSON.stringify(validateRotation(b.rotation)), now())
    .run();
  return c.json({ id }, 201);
});

api.put("/schedules/:id", requireAdmin, async (c) => {
  const b = await body<{ name: string; rotation: unknown }>(c);
  await c.env.DB.prepare(`UPDATE schedules SET name = ?, rotation = ? WHERE id = ?`)
    .bind(need(b.name, "name"), JSON.stringify(validateRotation(b.rotation)), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

/** Take over a shift. Responders may create overrides for themselves; admins for anyone. */
api.post("/schedules/:id/overrides", async (c) => {
  const b = await body<{ user_id?: string; starts_at: number; ends_at: number }>(c);
  const me = c.get("user");
  const userId = b.user_id ?? me.id;
  if (userId !== me.id && me.role !== "admin") throw new HttpError(403, "only admins can create overrides for others");
  if (!(b.ends_at > b.starts_at)) throw new HttpError(400, "ends_at must be after starts_at");
  const id = newId("ovr");
  await c.env.DB.prepare(`INSERT INTO schedule_overrides (id, schedule_id, user_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, c.req.param("id"), userId, b.starts_at, b.ends_at)
    .run();
  return c.json({ id }, 201);
});

api.delete("/schedules/:id/overrides/:oid", async (c) => {
  const me = c.get("user");
  await c.env.DB.prepare(`DELETE FROM schedule_overrides WHERE id = ? AND schedule_id = ? AND (user_id = ? OR ? = 'admin')`)
    .bind(c.req.param("oid"), c.req.param("id"), me.id, me.role)
    .run();
  return c.body(null, 204);
});

// ---- contact methods (each user manages their own)

const CM_TYPES = ["tuya", "ntfy", "webhook", "slack", "webpush"];

function delayMin(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 60) throw new HttpError(400, "delay_min must be a whole number from 0 to 60");
  return v as number;
}

function validateConfig(type: string, cfg: any): Record<string, unknown> {
  if (!cfg || typeof cfg !== "object") throw new HttpError(400, "config is required");
  switch (type) {
    case "tuya": {
      const preset = cfg.preset ? TUYA_PRESETS[cfg.preset] : undefined;
      if (cfg.preset && !preset) throw new HttpError(400, `unknown Tuya preset; use one of ${Object.keys(TUYA_PRESETS).join(", ")}`);
      const out = { ...preset, ...cfg, device_id: need(cfg.device_id, "config.device_id") };
      delete out.preset;
      if (!Array.isArray(out.on_trigger) || !Array.isArray(out.on_clear)) throw new HttpError(400, "tuya config needs on_trigger and on_clear (or a preset)");
      return out;
    }
    case "ntfy":
      return { server: cfg.server || "https://ntfy.sh", topic: need(cfg.topic, "config.topic"), token: cfg.token || undefined };
    case "webhook":
      return { url: need(cfg.url, "config.url"), authorization: cfg.authorization || undefined };
    case "slack":
      return { webhook_url: need(cfg.webhook_url, "config.webhook_url") };
    case "webpush": {
      if (typeof cfg.endpoint !== "string" || !/^https:\/\//.test(cfg.endpoint)) throw new HttpError(400, "config.endpoint must be an https URL");
      return { endpoint: cfg.endpoint, keys: { p256dh: need(cfg.keys?.p256dh, "config.keys.p256dh"), auth: need(cfg.keys?.auth, "config.keys.auth") } };
    }
  }
  throw new HttpError(400, `type must be one of ${CM_TYPES.join(", ")}`);
}

function redact(cm: any) {
  const cfg = parseJson<Record<string, unknown>>(cm.config, {});
  for (const k of ["token", "authorization"]) if (cfg[k]) cfg[k] = "••••";
  delete cfg.keys; // a push subscription's secret; the app only needs the endpoint to recognise this device
  return { ...cm, enabled: !!cm.enabled, config: cfg };
}

api.get("/contact-methods", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM contact_methods WHERE user_id = ? ORDER BY created_at`).bind(c.get("user").id).all();
  return c.json({ contact_methods: results.map(redact), tuya_presets: Object.keys(TUYA_PRESETS) });
});

api.post("/contact-methods", async (c) => {
  const b = await body<{ type: string; label?: string; config: unknown; min_severity?: string; delay_min?: number }>(c);
  const config = validateConfig(b.type, b.config);
  const sev = SEVERITIES.includes(b.min_severity as any) ? b.min_severity : "info";
  const id = newId("cm");
  // Turning paging on again on the same browser replaces its old subscription instead of ringing it twice.
  if (b.type === "webpush") {
    await c.env.DB.prepare(`DELETE FROM contact_methods WHERE user_id = ? AND type = 'webpush' AND json_extract(config, '$.endpoint') = ?`)
      .bind(c.get("user").id, (config as { endpoint: string }).endpoint)
      .run();
  }
  await c.env.DB.prepare(`INSERT INTO contact_methods (id, user_id, type, label, config, min_severity, delay_min, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, c.get("user").id, b.type, b.label ?? "", JSON.stringify(config), sev, delayMin(b.delay_min ?? 0), now())
    .run();
  return c.json({ id }, 201);
});

api.patch("/contact-methods/:id", async (c) => {
  const b = await body<{ label?: string; enabled?: boolean; min_severity?: string; delay_min?: number }>(c);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.label !== undefined) (sets.push("label = ?"), vals.push(b.label));
  if (b.enabled !== undefined) (sets.push("enabled = ?"), vals.push(b.enabled ? 1 : 0));
  if (b.min_severity !== undefined) {
    if (!SEVERITIES.includes(b.min_severity as any)) throw new HttpError(400, "bad min_severity");
    sets.push("min_severity = ?"), vals.push(b.min_severity);
  }
  if (b.delay_min !== undefined) (sets.push("delay_min = ?"), vals.push(delayMin(b.delay_min)));
  if (sets.length === 0) throw new HttpError(400, "nothing to change");
  await c.env.DB.prepare(`UPDATE contact_methods SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...vals, c.req.param("id"), c.get("user").id)
    .run();
  return c.json({ ok: true });
});

api.delete("/contact-methods/:id", async (c) => {
  await c.env.DB.prepare(`DELETE FROM contact_methods WHERE id = ? AND user_id = ?`).bind(c.req.param("id"), c.get("user").id).run();
  return c.body(null, 204);
});

/** Sends a test page through one method; devices are cleared again 15 s later. */
api.post("/contact-methods/:id/test", async (c) => {
  const user = c.get("user");
  const cm = await c.env.DB.prepare(`SELECT id FROM contact_methods WHERE id = ? AND user_id = ?`).bind(c.req.param("id"), user.id).first();
  if (!cm) throw new HttpError(404, "contact method not found");
  await enqueueTest(c.env, newId("test"), user.id, c.req.param("id"));
  return c.json({ ok: true });
});

// ---- Web Push (the key pair is made on first use and lives with the data, so no deploy can rotate it)

api.get("/push/vapid", async (c) => c.json({ publicKey: (await c.env.vapid()).publicKey }));

// ---- what today has cost against the free plan

api.get("/usage", requireAdmin, (c) => {
  const u = c.env.usageToday();
  return c.json({ ...u, free: FREE, target: TARGET, pressure: pressure(u) });
});

// ---- Tuya helpers

api.get("/tuya/presets", (c) => c.json({ presets: TUYA_PRESETS }));

/** Devices the pager can drive (those of the Tuya accounts linked to the cloud project), to pick one in the app. */
api.get("/tuya/devices", async (c) => {
  if (!c.env.TUYA_CLIENT_ID || !c.env.TUYA_CLIENT_SECRET) return c.json({ configured: false, devices: [] });
  return c.json({ configured: true, devices: await new TuyaClient(c.env).listDevices() });
});

api.get("/tuya/devices/:id/status", async (c) => c.json({ status: await new TuyaClient(c.env).deviceStatus(c.req.param("id")) }));

// Devices first: the generic /v1 group requires a user token on every path.
app.route("/v1/device", deviceApi);
app.route("/v1/devices", devicesAdmin);
app.route("/v1", api);
