// Runs the real Pager class on a real SQLite database, with the Durable Object runtime played by a few lines of JS.
// Sockets are the one thing it does not cover: scripts/smoke.sh exercises those against `wrangler dev`.
import { Pager } from "../src/pager";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

(globalThis as any).WebSocketRequestResponsePair ??= class {};

export interface Harness {
  pager: Pager;
  stats: { requests: number; rowsRead: number; rowsWritten: number };
  queries: Set<string>;
  explain(query: string): string[];
  call(method: string, path: string, opts?: { token?: string; device?: string; body?: unknown }): Promise<{ status: number; json: any }>;
  /** Runs the alarm for as long as it is due, as the runtime would. */
  alarms(): Promise<void>;
  alarmAt(): number | null;
}

export function makeHarness(env: Record<string, unknown> = {}): Harness {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const stats = { requests: 0, rowsRead: 0, rowsWritten: 0 };
  const queries = new Set<string>();
  let alarm: number | null = null;

  const sql = {
    exec(query: string, ...params: any[]) {
      if (query.trim().replace(/;\s*$/, "").includes(";")) {
        db.exec(query);
        return { toArray: () => [], rowsRead: 0, rowsWritten: 0 };
      }
      queries.add(query);
      const stmt = db.prepare(query);
      let rows: Record<string, unknown>[] = [];
      let written = 0;
      if (/^\s*select/i.test(query)) rows = stmt.all(...params) as Record<string, unknown>[];
      else if (/returning/i.test(query)) {
        rows = stmt.all(...params) as Record<string, unknown>[];
        written = rows.length;
      } else written = Number(stmt.run(...params).changes);
      stats.rowsRead += rows.length;
      stats.rowsWritten += written;
      return { toArray: () => rows, rowsRead: rows.length, rowsWritten: written };
    },
  };

  const pending: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      sql,
      transactionSync<T>(fn: () => T): T {
        db.exec("BEGIN");
        try {
          const out = fn();
          db.exec("COMMIT");
          return out;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      setAlarm(at: number) {
        alarm = at;
        stats.rowsWritten++;
      },
      getAlarm: () => alarm,
    },
    setWebSocketAutoResponse() {},
    getWebSockets: () => [],
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
  };

  const pager = new Pager(ctx as any, { TUYA_ENDPOINT: "https://tuya.test", BOOTSTRAP_TOKEN: "boot", ...env } as any);

  return {
    pager,
    stats,
    queries,
    explain: (query) => {
      const numbered = (query.match(/\?(\d+)/g) ?? []).map((m) => Number(m.slice(1)));
      const marks = numbered.length ? Math.max(...numbered) : (query.match(/\?/g) ?? []).length;
      return (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...Array(marks).fill(null)) as { detail: string }[]).map((r) => r.detail);
    },
    async call(method, path, opts = {}) {
      stats.requests++;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      if (opts.device) headers.Authorization = `Device ${opts.device}`;
      const res = await pager.fetch(
        new Request(`https://pager.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
      );
      await Promise.all(pending.splice(0));
      return { status: res.status, json: res.status === 204 ? null : await res.json() };
    },
    async alarms() {
      for (let guard = 0; alarm !== null && alarm <= Date.now(); guard++) {
        if (guard > 200) throw new Error("the alarm never settles");
        alarm = null;
        stats.requests++;
        await pager.alarm();
      }
    },
    alarmAt: () => alarm,
  };
}

/** A fresh pager with an admin, a second responder, a two-step policy and a service. */
export async function seed(h: Harness) {
  const admin = (await h.call("POST", "/v1/setup", { token: "boot", body: { email: "a@x.test", name: "Alice" } })).json;
  const T = admin.token as string;
  const bob = (await h.call("POST", "/v1/users", { token: T, body: { email: "b@x.test", name: "Bob" } })).json;
  const sch = (await h.call("POST", "/v1/schedules", { token: T, body: { name: "Primary", rotation: { shift_hours: 168, users: [admin.user_id] } } })).json;
  const pol = (
    await h.call("POST", "/v1/escalation-policies", {
      token: T,
      body: {
        name: "Default",
        repeat: 0,
        steps: [
          { delay_min: 0, targets: [{ type: "schedule", id: sch.id }] },
          { delay_min: 5, targets: [{ type: "user", id: bob.user_id }] },
        ],
      },
    })
  ).json;
  const svc = (await h.call("POST", "/v1/services", { token: T, body: { name: "API", escalation_policy_id: pol.id } })).json;
  return { T, B: bob.token as string, aliceId: admin.user_id as string, bobId: bob.user_id as string, key: svc.integration_key as string };
}

export const trigger = (key: string, dedup: string, summary = "Disk 95% on db1") => ({
  path: `/v1/integrations/${key}/events`,
  body: { event_action: "trigger", dedup_key: dedup, payload: { summary, severity: "critical", source: "db1" } },
});
