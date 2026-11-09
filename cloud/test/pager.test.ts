import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHarness, seed, trigger, type Harness } from "./harness";

const MIN = 60_000;
let sent: { url: string; body: any }[];
let failing: Set<string>;
let goneStatus: number | null;
let h: Harness;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-09T00:00:00Z") });
  sent = [];
  failing = new Set();
  goneStatus = null;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (failing.has(u)) throw new Error("connection refused");
    if (u.includes("push.test") && goneStatus) return new Response("", { status: goneStatus });
    sent.push({ url: u, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return new Response("{}", { status: 201 });
  });
  h = makeHarness();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const addHook = (token: string, url: string) => h.call("POST", "/v1/contact-methods", { token, body: { type: "webhook", label: url, config: { url } } });
const fire = async (key: string, dedup = "disk") => {
  const t = trigger(key, dedup);
  return (await h.call("POST", t.path, { body: t.body })).json.results[0];
};
const timeline = async (token: string, id: string) => (await h.call("GET", `/v1/incidents/${id}`, { token })).json.events.map((e: any) => e.kind);
const advance = async (ms: number) => {
  vi.setSystemTime(Date.now() + ms);
  await h.alarms();
};

describe("an incident's life", () => {
  it("pages the on-call person, escalates, and stops on acknowledge", async () => {
    const { T, B, key } = await seed(h);
    await addHook(T, "https://alice.test/");
    await addHook(B, "https://bob.test/");

    const r = await fire(key);
    expect(r.result).toBe("created");
    await h.alarms();
    expect(sent.map((s) => [s.url, s.body.event])).toEqual([["https://alice.test/", "trigger"]]);

    expect((await fire(key)).result).toBe("deduplicated");
    await h.alarms();
    expect(sent).toHaveLength(1);

    await advance(5 * MIN);
    expect(sent.map((s) => s.url)).toEqual(["https://alice.test/", "https://bob.test/"]);

    sent = [];
    await h.call("POST", `/v1/incidents/${r.incident_id}/acknowledge`, { token: B });
    await h.alarms();
    expect(sent.map((s) => s.body.event).sort()).toEqual(["acknowledge", "acknowledge"]);

    sent = [];
    await advance(60 * MIN);
    expect(sent).toEqual([]);
    const detail = (await h.call("GET", `/v1/incidents/${r.incident_id}`, { token: T })).json;
    expect(detail.escalation).toMatchObject({ step: 1, nextAt: null, stopped: true });
  });

  it("does not ring anyone for a page that came due after the acknowledgement", async () => {
    const { T, key } = await seed(h);
    await addHook(T, "https://alice.test/");
    const r = await fire(key);
    await h.call("POST", `/v1/incidents/${r.incident_id}/acknowledge`, { token: T });
    await h.alarms();
    expect(sent.map((s) => s.body.event)).toEqual(["acknowledge"]);
  });

  it("opens a new incident once the old one is resolved", async () => {
    const { T, key } = await seed(h);
    const first = await fire(key);
    await h.call("POST", `/v1/incidents/${first.incident_id}/resolve`, { token: T });
    const second = await fire(key);
    expect(second.result).toBe("created");
    expect(second.number).toBe(first.number + 1);
  });

  it("repaging sends the current step again without moving on", async () => {
    const { T, key } = await seed(h);
    await addHook(T, "https://alice.test/");
    const r = await fire(key);
    await h.alarms();
    sent = [];
    await h.call("POST", `/v1/incidents/${r.incident_id}/repage`, { token: T });
    await h.alarms();
    expect(sent.map((s) => s.url)).toEqual(["https://alice.test/"]);
    expect((await h.call("GET", `/v1/incidents/${r.incident_id}`, { token: T })).json.escalation.step).toBe(0);
  });

  it("says so on the timeline when nothing can reach the person being paged", async () => {
    const { T, key } = await seed(h);
    const r = await fire(key);
    expect(await timeline(T, r.incident_id)).toContain("notify_failed");
  });
});

describe("responding from a phone", () => {
  const detail = async (token: string, id: string) => (await h.call("GET", `/v1/incidents/${id}`, { token })).json;

  it("snooze stops the pages, then starts the policy over", async () => {
    const { T, key } = await seed(h);
    await addHook(T, "https://alice.test/");
    const r = await fire(key);
    await h.alarms();
    sent = [];
    const snoozed = (await h.call("POST", `/v1/incidents/${r.incident_id}/snooze`, { token: T, body: { minutes: 30 } })).json.incident;
    expect(snoozed.status).toBe("acknowledged");
    expect(snoozed.snoozed_until).toBe(Date.now() + 30 * MIN);
    await h.alarms();
    expect(sent.map((s) => s.body.event)).toEqual(["acknowledge"]);

    sent = [];
    await advance(29 * MIN);
    expect(sent).toEqual([]);
    await advance(MIN);
    expect(sent.map((s) => s.body.event)).toEqual(["trigger"]);
    const back = await detail(T, r.incident_id);
    expect(back.incident).toMatchObject({ status: "triggered", snoozed_until: null, acknowledged_by: null });
    expect(back.escalation.step).toBe(0);
    expect(back.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["snoozed", "unsnoozed"]));
  });

  it("resolving during a snooze ends it for good", async () => {
    const { T, key } = await seed(h);
    await addHook(T, "https://alice.test/");
    const r = await fire(key);
    await h.call("POST", `/v1/incidents/${r.incident_id}/snooze`, { token: T, body: { minutes: 30 } });
    await h.call("POST", `/v1/incidents/${r.incident_id}/resolve`, { token: T });
    await h.alarms();
    sent = [];
    await advance(31 * MIN);
    expect(sent).toEqual([]);
  });

  it("rejects a snooze of no length", async () => {
    const { T, key } = await seed(h);
    const r = await fire(key);
    expect((await h.call("POST", `/v1/incidents/${r.incident_id}/snooze`, { token: T, body: { minutes: 0 } })).status).toBe(400);
  });

  it("reassigning pages the new person and silences the old one", async () => {
    const { T, B, bobId, key } = await seed(h);
    await addHook(T, "https://alice.test/");
    await addHook(B, "https://bob.test/");
    const r = await fire(key);
    await h.call("POST", `/v1/incidents/${r.incident_id}/acknowledge`, { token: T });
    await h.alarms();
    sent = [];
    const moved = (await h.call("POST", `/v1/incidents/${r.incident_id}/reassign`, { token: T, body: { user_id: bobId } })).json.incident;
    expect(moved).toMatchObject({ status: "triggered", assignees: [bobId], acknowledged_at: null });
    await h.alarms();
    expect(sent.map((s) => [s.url, s.body.event]).sort()).toEqual([["https://alice.test/", "reassign"], ["https://bob.test/", "trigger"]]);
    expect((await detail(T, r.incident_id)).escalation.nextAt).toBe(Date.now() + 5 * MIN);
  });

  it("does not ring someone an incident has left, even for a delayed page", async () => {
    const { T, bobId, key } = await seed(h);
    const { json } = await addHook(T, "https://alice.test/");
    await h.call("PATCH", `/v1/contact-methods/${json.id}`, { token: T, body: { delay_min: 2 } });
    const r = await fire(key);
    await h.call("POST", `/v1/incidents/${r.incident_id}/reassign`, { token: T, body: { user_id: bobId } });
    await advance(3 * MIN);
    expect(sent.filter((s) => s.body.event === "trigger")).toEqual([]);
  });

  it("escalates at once, and says when there is nowhere left to go", async () => {
    const { T, B, key } = await seed(h);
    await addHook(B, "https://bob.test/");
    const r = await fire(key);
    const first = await h.call("POST", `/v1/incidents/${r.incident_id}/escalate`, { token: T });
    expect(first.status).toBe(200);
    expect(first.json.incident.escalation_step).toBe(1);
    await h.alarms();
    expect(sent.map((s) => s.url)).toEqual(["https://bob.test/"]);
    expect((await h.call("POST", `/v1/incidents/${r.incident_id}/escalate`, { token: T })).status).toBe(409);
  });

  it("acknowledges several incidents in one request", async () => {
    const { T, key } = await seed(h);
    const a = await fire(key, "a");
    const b = await fire(key, "b");
    const { json } = await h.call("POST", "/v1/incidents/bulk", { token: T, body: { action: "acknowledge", ids: [a.incident_id, b.incident_id] } });
    expect(json.incidents.map((i: any) => i.status)).toEqual(["acknowledged", "acknowledged"]);
  });

  it("holds a delayed method back, and drops it once someone answers", async () => {
    const { T, key } = await seed(h);
    await addHook(T, "https://phone.test/");
    const siren = (await addHook(T, "https://siren.test/")).json.id;
    await h.call("PATCH", `/v1/contact-methods/${siren}`, { token: T, body: { delay_min: 2 } });
    const r = await fire(key);
    await h.alarms();
    expect(sent.map((s) => s.url)).toEqual(["https://phone.test/"]);
    await h.call("POST", `/v1/incidents/${r.incident_id}/acknowledge`, { token: T });
    await advance(3 * MIN);
    expect(sent.filter((s) => s.url === "https://siren.test/").map((s) => s.body.event)).toEqual(["acknowledge"]);
  });
});

describe("reaching people in an emergency", () => {
  const nobody = async () => {
    const seeded = await seed(h);
    return { ...seeded, r: await fire(seeded.key) };
  };

  it("moves on within a minute when nothing can reach the person paged", async () => {
    const { T, B, r } = await nobody();
    await addHook(B, "https://bob.test/");
    await advance(30_000);
    expect(sent.map((s) => s.url)).toEqual(["https://bob.test/"]);
    expect((await h.call("GET", `/v1/incidents/${r.incident_id}`, { token: T })).json.escalation.step).toBe(1);
  });

  it("does not count someone with a hardware pager as unreachable", async () => {
    const { T, key } = await seed(h);
    await h.call("POST", "/v1/devices", { token: T, body: { name: "Desk" } });
    const r = await fire(key);
    const detail = (await h.call("GET", `/v1/incidents/${r.incident_id}`, { token: T })).json;
    expect(detail.escalation.nextAt).toBe(Date.now() + 5 * MIN);
    expect(detail.events.map((e: any) => e.kind)).not.toContain("notify_failed");
  });

  it("remembers a method's last failure until it works again", async () => {
    const { T, key } = await seed(h);
    await addHook(T, "https://flaky.test/");
    failing.add("https://flaky.test/");
    await fire(key);
    await h.alarms();
    const method = async () => (await h.call("GET", "/v1/contact-methods", { token: T })).json.contact_methods[0];
    expect((await method()).last_error).toContain("connection refused");
    failing.clear();
    await advance(5_000);
    expect((await method()).last_error).toBeNull();
  });
});

describe("customer notices", () => {
  const live = () => (h = makeHarness({ CUSTOMER_NOTIFY: "on" }));
  const customer = (T: string, url = "https://acme.test/") => h.call("POST", "/v1/customers", { token: T, body: { name: "Acme", type: "webhook", config: { url } } });
  const notify = (token: string, id: string, message = "Checkout is degraded, we are on it.") => h.call("POST", `/v1/incidents/${id}/customer-notices`, { token, body: { message } });

  it("is a dry run until it is switched on: nobody is contacted", async () => {
    const { T, key } = await seed(h);
    await customer(T);
    const r = await fire(key);
    const res = await notify(T, r.incident_id);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ audience: 1, dry_run: true });
    await h.alarms();
    expect(sent.filter((s) => s.url === "https://acme.test/")).toEqual([]);
    expect(await timeline(T, r.incident_id)).toContain("customer_notice_dry_run");
  });

  it("sends only what the sender wrote: no title, details or links", async () => {
    live();
    const { T, key } = await seed(h);
    await customer(T);
    const r = await fire(key);
    await notify(T, r.incident_id);
    await h.alarms();
    const got = sent.filter((s) => s.url === "https://acme.test/");
    expect(got.map((s) => s.body)).toEqual([{ event: "customer_notice", notice_id: expect.any(String), service: "API", message: "Checkout is degraded, we are on it." }]);
    expect(await timeline(T, r.incident_id)).toContain("customer_notice");
  });

  it("needs the permission, which an admin can grant", async () => {
    const { T, B, bobId, key } = await seed(h);
    await customer(T);
    const r = await fire(key);
    expect((await notify(B, r.incident_id)).status).toBe(403);
    await h.call("PATCH", `/v1/users/${bobId}`, { token: T, body: { can_notify_customers: true } });
    expect((await notify(B, r.incident_id)).status).toBe(201);
    expect((await h.call("PATCH", `/v1/users/${bobId}`, { token: B, body: { can_notify_customers: false } })).status).toBe(403);
  });

  it("is only for open critical or error incidents", async () => {
    const { T, key } = await seed(h);
    await customer(T);
    const warn = await h.call("POST", `/v1/integrations/${key}/events`, { body: { event_action: "trigger", dedup_key: "w", payload: { summary: "Slow", severity: "warning", source: "x" } } });
    expect((await notify(T, warn.json.results[0].incident_id)).status).toBe(409);
    const r = await fire(key);
    await h.call("POST", `/v1/incidents/${r.incident_id}/resolve`, { token: T });
    expect((await notify(T, r.incident_id)).status).toBe(409);
  });

  it("refuses to send twice within five minutes", async () => {
    live();
    const { T, key } = await seed(h);
    await customer(T);
    const r = await fire(key);
    expect((await notify(T, r.incident_id)).status).toBe(201);
    expect((await notify(T, r.incident_id)).status).toBe(429);
    vi.setSystemTime(Date.now() + 5 * MIN);
    expect((await notify(T, r.incident_id)).status).toBe(201);
  });

  it("retries a customer that failed and records giving up", async () => {
    live();
    const { T, key } = await seed(h);
    await customer(T, "https://down.test/");
    failing.add("https://down.test/");
    const r = await fire(key);
    await notify(T, r.incident_id);
    await h.alarms();
    for (const wait of [5, 10, 20, 40, 60]) await advance(wait * 1000);
    expect(await timeline(T, r.incident_id)).toContain("customer_notice_failed");
  });

  it("only admins see or change the customer list, and secrets stay hidden", async () => {
    const { T, B } = await seed(h);
    await h.call("POST", "/v1/customers", { token: T, body: { name: "Acme", type: "webhook", config: { url: "https://a.test/", authorization: "Bearer s3cret" } } });
    expect((await h.call("GET", "/v1/customers", { token: B })).status).toBe(403);
    expect((await h.call("POST", "/v1/customers", { token: B, body: {} })).status).toBe(403);
    const { json } = await h.call("GET", "/v1/customers", { token: T });
    expect(json.customers[0].config.authorization).toBe("••••");
    expect(json.live).toBe(false);
  });
});

describe("getting back in", () => {
  it("issues a new admin token with the bootstrap token, and retires the old one", async () => {
    const { T } = await seed(h);
    expect((await h.call("POST", "/v1/recover", { token: "wrong", body: { email: "a@x.test" } })).status).toBe(401);
    expect((await h.call("POST", "/v1/recover", { token: "boot", body: { email: "b@x.test" } })).status).toBe(404);
    const { json } = await h.call("POST", "/v1/recover", { token: "boot", body: { email: "a@x.test" } });
    expect((await h.call("GET", "/v1/me", { token: json.token })).status).toBe(200);
    expect((await h.call("GET", "/v1/me", { token: T })).status).toBe(401);
  });

  it("keeps at least one admin", async () => {
    const { T, aliceId } = await seed(h);
    expect((await h.call("PATCH", `/v1/users/${aliceId}`, { token: T, body: { role: "responder" } })).status).toBe(409);
  });
});

describe("delivery", () => {
  it("retries only the channel that failed, and gives up out loud", async () => {
    const { T, key } = await seed(h);
    await addHook(T, "https://good.test/");
    await addHook(T, "https://bad.test/");
    failing.add("https://bad.test/");
    const r = await fire(key);
    await h.alarms();
    for (const wait of [5, 10, 20, 40, 60]) await advance(wait * 1000);
    expect(sent.filter((s) => s.url === "https://good.test/")).toHaveLength(1);
    const kinds = await timeline(T, r.incident_id);
    expect(kinds.filter((k: string) => k === "notify_failed")).toHaveLength(1);
    expect(kinds).toContain("notify_gave_up");
  });

  it("delivers a page once a failing channel recovers", async () => {
    const { T, key } = await seed(h);
    await addHook(T, "https://flaky.test/");
    failing.add("https://flaky.test/");
    await fire(key);
    await h.alarms();
    failing.clear();
    await advance(5_000);
    expect(sent.map((s) => s.url)).toEqual(["https://flaky.test/"]);
  });

  it("a delivery failure never makes escalation skip a step", async () => {
    const { T, B, key } = await seed(h);
    await addHook(T, "https://alice.test/");
    await addHook(B, "https://bob.test/");
    failing.add("https://alice.test/");
    const r = await fire(key);
    await h.alarms();
    expect((await h.call("GET", `/v1/incidents/${r.incident_id}`, { token: T })).json.escalation.step).toBe(0);
    await advance(5 * MIN);
    expect((await h.call("GET", `/v1/incidents/${r.incident_id}`, { token: T })).json.escalation.step).toBe(1);
  });

  it("sends a test page, then the all-clear that silences a siren", async () => {
    const { T } = await seed(h);
    const { json } = await addHook(T, "https://alice.test/");
    await h.call("POST", `/v1/contact-methods/${json.id}/test`, { token: T });
    await h.alarms();
    expect(sent.map((s) => s.body.event)).toEqual(["test"]);
    await advance(15_000);
    expect(sent.map((s) => s.body.event)).toEqual(["test", "resolve"]);
  });
});

describe("web push", () => {
  // A real P-256 point (from RFC 8291's example), so the encryption runs for real.
  const keys = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
  const subscribe = (token: string) => h.call("POST", "/v1/contact-methods", { token, body: { type: "webpush", label: "Phone", config: { endpoint: "https://push.test/abc", keys } } });

  it("keeps one key pair for good, and one method per browser", async () => {
    const { T } = await seed(h);
    const key = (await h.call("GET", "/v1/push/vapid", { token: T })).json.publicKey;
    expect((await h.call("GET", "/v1/push/vapid", { token: T })).json.publicKey).toBe(key);
    await subscribe(T);
    await subscribe(T);
    const methods = (await h.call("GET", "/v1/contact-methods", { token: T })).json.contact_methods;
    expect(methods).toHaveLength(1);
    expect(methods[0].config).toEqual({ endpoint: "https://push.test/abc" });
  });

  it("pages through the push service and removes a subscription that is gone", async () => {
    const { T, key } = await seed(h);
    await subscribe(T);
    await fire(key, "one");
    await h.alarms();
    expect(sent.map((s) => s.url)).toEqual(["https://push.test/abc"]);
    goneStatus = 410;
    await fire(key, "two");
    await h.alarms();
    expect((await h.call("GET", "/v1/contact-methods", { token: T })).json.contact_methods).toEqual([]);
  });
});

describe("hardware pagers", () => {
  it("rings, acknowledges with the button, and writes last_seen rarely", async () => {
    const { T, key } = await seed(h);
    const device = (await h.call("POST", "/v1/devices", { token: T, body: { name: "Desk" } })).json.token;
    const quiet = (await h.call("GET", "/v1/device/state", { device })).json;
    expect(quiet).toMatchObject({ alert: 0, count: 0 });

    await fire(key);
    const ringing = (await h.call("GET", "/v1/device/state", { device })).json;
    expect(ringing).toMatchObject({ alert: 1, count: 1 });
    expect(ringing.v).toBeGreaterThan(quiet.v);

    const before = h.stats.rowsWritten;
    for (let i = 0; i < 10; i++) await h.call("GET", `/v1/device/state?v=${ringing.v}`, { device });
    expect(h.stats.rowsWritten - before).toBeLessThanOrEqual(10); // only the sampled usage counter

    expect((await h.call("POST", "/v1/device/ack", { device })).json.acknowledged).toEqual([1]);
    expect((await h.call("GET", "/v1/device/state", { device })).json).toMatchObject({ alert: 0, acked: 1 });
  });

  it("rejects an unknown device", async () => {
    await seed(h);
    expect((await h.call("GET", "/v1/device/state", { device: "nope" })).status).toBe(401);
  });
});

describe("the free plan", () => {
  it("reports today's use to admins only", async () => {
    const { T, B } = await seed(h);
    const usage = (await h.call("GET", "/v1/usage", { token: T })).json;
    expect(usage.requests).toBeGreaterThan(3);
    expect(usage.pressure).toBe("ok");
    expect((await h.call("GET", "/v1/usage", { token: B })).status).toBe(403);
    expect((await h.call("GET", "/v1/health")).json).toMatchObject({ ok: true, budget: "ok" });
  });

  it("stops recording repeats when the budget is tight, but still pages", async () => {
    const { T, key } = await seed(h);
    await addHook(T, "https://alice.test/");
    h.pager.kv.write("usage", JSON.stringify({ day: "2026-11-09", requests: 75_000, rowsRead: 0, rowsWritten: 0, routes: {} }));
    const r = await fire(key);
    await fire(key);
    await h.alarms();
    expect(sent).toHaveLength(1);
    const kinds = await timeline(T, r.incident_id);
    expect(kinds).not.toContain("alert_repeated");
    expect(kinds).not.toContain("notify_sent");
  });

  it("makes its secrets once and remembers where it lives", async () => {
    const { T } = await seed(h);
    await addHook(T, "https://alice.test/");
    expect(h.pager.view.PUBLIC_URL).toBe("https://pager.test");
    const secret = h.pager.view.ACTION_SECRET;
    expect(secret).toBeTruthy();
    expect(h.pager.view.ACTION_SECRET).toBe(secret);
  });
});
