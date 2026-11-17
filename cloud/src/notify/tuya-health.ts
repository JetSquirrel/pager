// A siren that has lost its Wi-Fi fails exactly when it matters. Every half hour the alarm asks Tuya whether the devices
// still answer, and tells their owner on another channel when one stops.
// Budget: 48 alarms a day and only when someone has a Tuya device; each writes 2 rows. The calls to Tuya cost the Worker nothing.
import type { Db, KvTable } from "../db";
import type { Env } from "../types";
import { now } from "../util";
import type { ContactMethodRow } from "./dispatch";
import { DEVICE_OFFLINE, TuyaClient, type TuyaConfig } from "./tuya";

export const SWEEP_MS = 30 * 60_000;
/** Free-plan Workers may make 50 subrequests per invocation, and the same alarm delivers pages too. */
const MAX_DEVICES = 20;
const SWEPT = "tuya_swept_at";

export function nextSweep(db: Db, kv: KvTable, configured: boolean): number | null {
  if (!configured || db.execute("SELECT 1 AS y FROM contact_methods WHERE type = 'tuya' AND enabled = 1 LIMIT 1", []).rows.length === 0) return null;
  return Number(kv.read(SWEPT) ?? 0) + SWEEP_MS;
}

export async function sweepTuya(env: Env, at: number): Promise<void> {
  if (!env.TUYA_CLIENT_ID || !env.TUYA_CLIENT_SECRET) return;
  const last = Number(env.CACHE.read(SWEPT) ?? 0);
  if (at - last < SWEEP_MS) return;
  const { results } = await env.DB.prepare(`SELECT * FROM contact_methods WHERE type = 'tuya' AND enabled = 1 ORDER BY id LIMIT ${MAX_DEVICES}`).all<ContactMethodRow>();
  if (results.length === 0) return;
  env.CACHE.write(SWEPT, String(at));
  const client = new TuyaClient(env);
  for (const cm of results) {
    let online: boolean;
    try {
      online = await client.online((JSON.parse(cm.config) as TuyaConfig).device_id);
    } catch (e) {
      // Tuya itself not answering says nothing about the device, and would otherwise mark every one offline.
      console.error("tuya health check failed", e);
      return;
    }
    if (online && cm.last_error === DEVICE_OFFLINE) {
      await env.DB.prepare(`UPDATE contact_methods SET last_error = NULL, last_error_at = NULL WHERE id = ?`).bind(cm.id).run();
    } else if (!online && cm.last_error !== DEVICE_OFFLINE) {
      await env.DB.prepare(`UPDATE contact_methods SET last_error = ?, last_error_at = ? WHERE id = ?`).bind(DEVICE_OFFLINE, now(), cm.id).run();
      await tellOwner(env, cm, at);
    }
  }
  env.wake();
}

async function tellOwner(env: Env, cm: ContactMethodRow, at: number): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT id FROM contact_methods WHERE user_id = ? AND enabled = 1 AND type != 'tuya'`).bind(cm.user_id).all<{ id: string }>();
  for (const other of results) {
    await env.DB.prepare(`INSERT INTO outbox (incident_id, user_id, contact_method_id, event, due_at) VALUES (?, ?, ?, 'notice', ?)`).bind(`hw_${cm.id}`, cm.user_id, other.id, at).run();
  }
}
