import { DurableObject } from "cloudflare:workers";
import { app } from "./api";
import { emptyUsage, POLL_SAMPLE, pressure, type Pressure, type Usage } from "./budget";
import { Db, KvTable, migrate, type SqlLike } from "./db";
import { deviceStateFor, endDeviceTests, nextDeviceTest, openIncidents, testingDevices } from "./devices";
import { dueEscalations } from "./escalation";
import { drainOutbox, nextDelivery } from "./notify/dispatch";
import { nextSweep, sweepTuya } from "./notify/tuya-health";
import { newVapidKeys, type Vapid } from "./notify/webpush";
import { MIGRATIONS } from "./schema";
import type { Bindings, Env } from "./types";
import { newSecret, now } from "./util";

const DAY = 86_400_000;

/** "GET /v1/incidents/:id": the route without ids, so a day's breakdown stays a few dozen keys. */
export const routeKey = (req: Request) => {
  const path = new URL(req.url).pathname
    .replace(/\/(inc|usr|sch|pol|svc|cm|dev|ovr|cst)_[\w-]+/g, "/:id")
    .replace(/^(\/v1\/integrations|\/v1\/actions)\/[^/]+/, "$1/:key");
  return `${req.method} ${path.slice(0, 48)}`;
};

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The whole pager: one object holding incidents, people, schedules, the escalation timers, the delivery outbox and the
 * live sockets. A single alarm drives everything that has to happen later, so an incident, its escalation and its pages
 * are written together or not at all.
 */
export class Pager extends DurableObject<Bindings> {
  readonly db: Db;
  readonly kv: KvTable;
  readonly view: Env;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.db = new Db(ctx.storage.sql as unknown as SqlLike, (fn) => ctx.storage.transactionSync(fn));
    this.kv = new KvTable(this.db);
    migrate(this.db, this.kv, MIGRATIONS);
    // Clients ping to keep mobile NATs open; answering here never wakes the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", JSON.stringify({ type: "pong" })));
    this.view = this.makeView();
  }

  private makeView(): Env {
    const self = this;
    return Object.create(this.env, {
      DB: { value: this.db },
      CACHE: { value: this.kv },
      // A deploy needs no URL: the first request tells us where we live (PUBLIC_URL overrides it, e.g. for a custom domain).
      PUBLIC_URL: { get: () => self.env.PUBLIC_URL || self.kv.read("origin") || "" },
      // Generated once and kept here, so redeploying from any machine can never rotate it.
      ACTION_SECRET: { get: () => self.env.ACTION_SECRET || self.kv.once("action_secret", () => newSecret(32)) },
      vapid: { value: () => self.vapid() },
      wake: { value: () => self.arm() },
      publish: { value: (message: string) => self.publish(message) },
      acceptClient: { value: (userId: string) => self.acceptSocket("client", userId, { type: "hello", at: now() }) },
      acceptDevice: { value: (userId: string, state: unknown, deviceId: string) => self.acceptSocket("device", userId, state, deviceId) },
      version: { value: () => self.version() },
      pressure: { value: () => self.pressureNow() },
      usageToday: { value: () => self.today() },
    }) as Env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!this.env.PUBLIC_URL && !this.kv.read("origin")) this.kv.write("origin", url.origin);
    try {
      return await app.fetch(req, this.view, this.ctx as unknown as ExecutionContext);
    } finally {
      this.settle(routeKey(req), url.pathname === "/v1/device/state");
    }
  }

  async alarm(): Promise<void> {
    try {
      await dueEscalations(this.view, now());
      await drainOutbox(this.view, now());
      await sweepTuya(this.view, now());
      endDeviceTests(this.view, now());
      this.prune();
    } finally {
      this.arm();
      this.settle("alarm", false);
    }
  }

  /** Points the single alarm at the next thing due. */
  arm(): void {
    const due = [
      this.db.execute("SELECT MIN(next_at) AS at FROM escalations WHERE next_at IS NOT NULL", []).rows[0]?.at as number | null,
      nextDelivery(this.db),
      nextSweep(this.db, this.kv, !!(this.env.TUYA_CLIENT_ID && this.env.TUYA_CLIENT_SECRET)),
      nextDeviceTest(this.db),
      Number(this.kv.read("pruned_at") ?? now()) + DAY,
    ].filter((x): x is number => x != null);
    void this.ctx.storage.setAlarm(Math.max(now(), Math.min(...due)));
  }

  /** Once a day: delivery receipts and repeats older than 90 days go; the incidents themselves stay. */
  private prune(): void {
    const last = this.kv.read("pruned_at");
    if (last !== null && now() - Number(last) < DAY) return;
    this.kv.write("pruned_at", String(now()));
    this.db.execute("DELETE FROM incident_events WHERE kind IN ('notify_sent', 'alert_repeated') AND at < ?", [now() - 90 * DAY]);
  }

  private async vapid(): Promise<Vapid> {
    let stored = this.kv.read("vapid");
    if (!stored) {
      stored = JSON.stringify(await newVapidKeys());
      this.kv.write("vapid", stored);
    }
    const admin = this.db.execute("SELECT email FROM users WHERE role = 'admin' LIMIT 1", []).rows[0]?.email as string | undefined;
    return { ...JSON.parse(stored), subject: `mailto:${admin ?? "pager@example.com"}` };
  }

  // ---------------------------------------------------------------- live sockets

  /** Goes up on every incident change. Stored, because the object forgets everything when it hibernates. */
  private version(): number {
    return Number(this.kv.once("version", () => String(now())));
  }

  private publish(message: string): void {
    const v = this.version() + 1;
    this.kv.write("version", String(v));
    for (const ws of this.ctx.getWebSockets("client")) {
      try {
        ws.send(message);
      } catch {
        // closed socket; the runtime drops it
      }
    }
    const devices = this.ctx.getWebSockets("device");
    if (devices.length === 0) return;
    const open = openIncidents(this.db);
    const testing = testingDevices(this.db, now());
    for (const ws of devices) {
      try {
        const { userId, deviceId } = ws.deserializeAttachment() as { userId: string; deviceId?: string };
        ws.send(JSON.stringify(deviceStateFor(userId, open, v, now(), !!deviceId && testing.has(deviceId))));
      } catch {
        // closed socket
      }
    }
  }

  /** "client": the app's live feed. "device": a hardware pager's long poll, waited out by the Worker (src/index.ts). */
  private acceptSocket(tag: "client" | "device", userId: string, first: unknown, deviceId?: string): Response {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ userId, deviceId });
    server.send(JSON.stringify(first));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  // ---------------------------------------------------------------- metering

  private today(): Usage {
    const day = dayOf(now());
    try {
      const saved = JSON.parse(this.kv.read("usage") ?? "") as Usage;
      if (saved.day === day) return saved;
    } catch {
      // nothing saved yet
    }
    return emptyUsage(day);
  }

  private pressureNow(): Pressure {
    return pressure(this.today());
  }

  /**
   * Adds this request to today's counters and saves them. The object loses its memory when it hibernates, so counts
   * cannot wait there; hardware polls, which are most of the traffic, are sampled instead of each paying for a write.
   */
  private settle(route: string, sampled: boolean): void {
    const { rowsRead, rowsWritten } = this.db.take();
    const weight = !sampled ? 1 : Math.random() < 1 / POLL_SAMPLE ? POLL_SAMPLE : 0;
    if (weight === 0) return;
    const u = this.today();
    const add: [number, number, number] = [weight, rowsRead * weight, (rowsWritten + 1) * weight];
    u.requests += add[0];
    u.rowsRead += add[1];
    u.rowsWritten += add[2];
    const r = (u.routes[route] ??= [0, 0, 0]);
    r[0] += add[0];
    r[1] += add[1];
    r[2] += add[2];
    this.kv.write("usage", JSON.stringify(u));
    this.db.take();
  }
}
