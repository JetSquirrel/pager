// Hardware pagers (hardware/pager-t5ai firmware). Two sets of routes:
//   /v1/devices/*  — a signed-in user registers, lists and removes their devices (user token)
//   /v1/device/*   — the device itself: long-poll its state, acknowledge (device token, "Authorization: Device <token>")
import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { requireUser } from "./auth";
import { acknowledge, rowToIncident } from "./incidents";
import type { Env, Incident, User } from "./types";
import { HttpError, newId, newSecret, now, sha256Hex } from "./util";

export interface DeviceState {
  /** Changes whenever any incident changes; pass it back as ?v= to wait for the next change. */
  v: number;
  /** 1 while any incident paging this device's user is unacknowledged: ring. */
  alert: 0 | 1;
  /** Unacknowledged incidents paging this user. */
  count: number;
  /** Acknowledged-but-open incidents assigned to this user (steady light). */
  acked: number;
  /** The most severe, newest unacknowledged one. */
  top: { id: string; number: number; title: string; severity: Incident["severity"]; service: string } | null;
  /** Server time, so a device without RTC can show ages. */
  now: number;
}

const SEV_ORDER = { critical: 3, error: 2, warning: 1, info: 0 } as const;

/** What a user's device should show now. Pure function of the user's open incidents (tested). */
export function deviceStateFor(userId: string, open: Incident[], v: number, at = now()): DeviceState {
  const mine = open.filter((i) => i.assignees.includes(userId));
  const triggered = mine
    .filter((i) => i.status === "triggered")
    .sort((a, b) => SEV_ORDER[b.severity] - SEV_ORDER[a.severity] || b.created_at - a.created_at);
  const t = triggered[0];
  return {
    v,
    alert: triggered.length ? 1 : 0,
    count: triggered.length,
    acked: mine.filter((i) => i.status === "acknowledged").length,
    top: t ? { id: t.id, number: t.number, title: t.title.slice(0, 120), severity: t.severity, service: t.service_name ?? "" } : null,
    now: at,
  };
}

async function openIncidents(env: Env): Promise<Incident[]> {
  const { results } = await env.DB.prepare(
    `SELECT i.*, s.name AS service_name FROM incidents i JOIN services s ON s.id = i.service_id
      WHERE i.status != 'resolved' ORDER BY i.created_at DESC LIMIT 500`,
  ).all<Record<string, unknown>>();
  return results.map(rowToIncident);
}

type DeviceEnv = { Bindings: Env; Variables: { device: { id: string; user_id: string; name: string }; user: User } };

// ------------------------------------------------------------------ the device's own API

export const deviceApi = new Hono<DeviceEnv>();

deviceApi.use("*", async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const token = h.toLowerCase().startsWith("device ") ? h.slice(7).trim() : null;
  if (!token) throw new HttpError(401, "missing device token");
  const device = await c.env.DB.prepare(`SELECT id, user_id, name FROM devices WHERE token_hash = ?`)
    .bind(await sha256Hex(token))
    .first<{ id: string; user_id: string; name: string }>();
  if (!device) throw new HttpError(401, "unknown device");
  c.set("device", device);
  await next();
});

/**
 * GET /v1/device/state?v=<last v>&wait=<seconds, max 25>
 * Returns at once when anything changed since v (or without v), else after the next change or the wait.
 */
deviceApi.get("/state", async (c) => {
  const d = c.get("device");
  const hub = c.env.HUB.get(c.env.HUB.idFromName("global"));
  const seen = Number(c.req.query("v") ?? NaN);
  const wait = Math.min(25, Math.max(0, Number(c.req.query("wait") ?? 0)));
  const v = Number.isFinite(seen) && wait > 0 ? await hub.waitForChange(seen, wait * 1000) : await hub.currentVersion();
  const fw = c.req.header("x-firmware");
  c.executionCtx.waitUntil(
    c.env.DB.prepare(`UPDATE devices SET last_seen_at = ?, last_ip = ?, firmware = COALESCE(?, firmware) WHERE id = ?`)
      .bind(now(), c.req.header("cf-connecting-ip") ?? null, fw ?? null, d.id)
      .run(),
  );
  return c.json(deviceStateFor(d.user_id, await openIncidents(c.env), v));
});

/** POST /v1/device/ack — the button: acknowledges every incident currently paging this device's user. */
deviceApi.post("/ack", async (c) => {
  const d = c.get("device");
  const mine = (await openIncidents(c.env)).filter((i) => i.status === "triggered" && i.assignees.includes(d.user_id));
  for (const i of mine) await acknowledge(c.env, c.executionCtx, i, d.user_id, `Acknowledged on ${d.name}`);
  return c.json({ acknowledged: mine.map((i) => i.number) });
});

// ------------------------------------------------------------------ users managing their devices

export const devicesAdmin = new Hono<AppEnv>();
devicesAdmin.use("*", requireUser);

devicesAdmin.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, last_seen_at, last_ip, firmware, created_at FROM devices WHERE user_id = ? ORDER BY created_at`,
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ devices: results });
});

/** Registers a device; the token is returned once, to be entered on the device (serial console: `pager token …`). */
devicesAdmin.post("/", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { name?: string };
  const token = `dev_${newSecret(24)}`;
  const id = newId("dev");
  await c.env.DB.prepare(`INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, c.get("user").id, (b.name || "T5AI pager").slice(0, 60), await sha256Hex(token), now())
    .run();
  return c.json({ id, token }, 201);
});

devicesAdmin.delete("/:id", async (c) => {
  await c.env.DB.prepare(`DELETE FROM devices WHERE id = ? AND user_id = ?`).bind(c.req.param("id"), c.get("user").id).run();
  return c.body(null, 204);
});
