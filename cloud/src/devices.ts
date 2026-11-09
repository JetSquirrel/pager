// Hardware pagers (hardware/pager-t5ai firmware). Two sets of routes:
//   /v1/devices/*  — a signed-in user registers, lists and removes their devices (user token)
//   /v1/device/*   — the device itself: long-poll its state, acknowledge (device token, "Authorization: Device <token>")
import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { requireUser } from "./auth";
import { DEVICE_SEEN_MS } from "./budget";
import type { Db } from "./db";
import { acknowledge, rowToIncident, snooze } from "./incidents";
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

export function openIncidents(db: Db): Incident[] {
  return db
    .execute(
      `SELECT i.*, s.name AS service_name FROM incidents i JOIN services s ON s.id = i.service_id
        WHERE i.status != 'resolved' ORDER BY i.created_at DESC LIMIT 500`,
      [],
    )
    .rows.map(rowToIncident);
}

type DeviceRow = { id: string; user_id: string; name: string; last_seen_at: number | null };
type DeviceEnv = { Bindings: Env; Variables: { device: DeviceRow; user: User } };

// ------------------------------------------------------------------ the device's own API

export const deviceApi = new Hono<DeviceEnv>();

deviceApi.use("*", async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const token = h.toLowerCase().startsWith("device ") ? h.slice(7).trim() : null;
  if (!token) throw new HttpError(401, "missing device token");
  const device = await c.env.DB.prepare(`SELECT id, user_id, name, last_seen_at FROM devices WHERE token_hash = ?`)
    .bind(await sha256Hex(token))
    .first<DeviceRow>();
  if (!device) throw new HttpError(401, "unknown device");
  c.set("device", device);
  await next();
});

/**
 * GET /v1/device/state?v=<last v>&wait=<seconds, max 25>
 * Returns at once when anything changed since v (or without v), else after the next change or the wait.
 * The waiting is done by the Worker (src/index.ts); with an Upgrade header this answers over a hibernating socket.
 */
deviceApi.get("/state", async (c) => {
  const d = c.get("device");
  if (d.last_seen_at === null || now() - d.last_seen_at >= DEVICE_SEEN_MS) {
    await c.env.DB.prepare(`UPDATE devices SET last_seen_at = ?, last_ip = ?, firmware = COALESCE(?, firmware) WHERE id = ?`)
      .bind(now(), c.req.header("cf-connecting-ip") ?? null, c.req.header("x-firmware") ?? null, d.id)
      .run();
  }
  const state = deviceStateFor(d.user_id, openIncidents(c.env.DB), c.env.version());
  if (c.req.header("upgrade")?.toLowerCase() === "websocket") return c.env.acceptDevice(d.user_id, state);
  return c.json(state);
});

/** POST /v1/device/ack — the button: acknowledges every incident currently paging this device's user. */
deviceApi.post("/ack", async (c) => {
  const d = c.get("device");
  const mine = openIncidents(c.env.DB).filter((i) => i.status === "triggered" && i.assignees.includes(d.user_id));
  for (const i of mine) await acknowledge(c.env, c.executionCtx, i, d.user_id, `Acknowledged on ${d.name}`);
  return c.json({ acknowledged: mine.map((i) => i.number) });
});

/** POST /v1/device/snooze?minutes=30 — the long press: quiet now, and the page comes back if nobody has dealt with it. */
deviceApi.post("/snooze", async (c) => {
  const d = c.get("device");
  const minutes = Number(c.req.query("minutes") ?? 30);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new HttpError(400, "minutes must be a whole number from 1 to 240");
  const mine = openIncidents(c.env.DB).filter((i) => i.status === "triggered" && i.assignees.includes(d.user_id));
  for (const i of mine) await snooze(c.env, c.executionCtx, i, d.user_id, minutes);
  return c.json({ snoozed: mine.map((i) => i.number), minutes });
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
