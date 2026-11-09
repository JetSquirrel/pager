// Hard rule: the pager runs on Cloudflare's free plan (src/budget.ts, AGENTS.md). One simulated day has to stay under
// TARGET, a fifth of the free plan. If a change breaks this, redesign the change: never raise TARGET or thin the day out.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TARGET } from "../src/budget";
import { makeHarness, seed, trigger, type Harness } from "./harness";

const MIN = 60_000;
/** Cloudflare bills index rows too; the tables written most carry two or three indexes. */
const INDEX_FACTOR = 3;
const INCIDENTS = 30;
const REPEATS_PER_INCIDENT = 30;
const POLL_EVERY_S = 20; // the firmware's long poll
const APP_REQUESTS_PER_PERSON = 200;

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-09T00:00:00Z") });
  // Shaped to answer Tuya as well as the webhooks, so the day includes a siren and its health checks.
  vi.stubGlobal("fetch", async () => Response.json({ success: true, result: { online: true, access_token: "t", expire_time: 7200 } }));
  h = makeHarness({ TUYA_CLIENT_ID: "id", TUYA_CLIENT_SECRET: "secret" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function simulateDay() {
  const { T, B, key } = await seed(h);
  for (const [token, name] of [[T, "alice"], [B, "bob"]]) {
    await h.call("POST", "/v1/contact-methods", { token, body: { type: "webhook", label: `${name}1`, config: { url: `https://${name}1.test/` } } });
    const second = name === "alice" ? { type: "tuya", label: "Siren", config: { device_id: "d1", preset: "siren" } } : { type: "webhook", label: "bob2", config: { url: "https://bob2.test/" } };
    await h.call("POST", "/v1/contact-methods", { token, body: second });
  }
  const device = (await h.call("POST", "/v1/devices", { token: T, body: { name: "Desk" } })).json.token as string;
  const start = Date.now();
  const openAt = new Map<number, { dedup: string; id?: string }>();
  for (let i = 0; i < INCIDENTS; i++) openAt.set(Math.floor((i * 86_400) / INCIDENTS / POLL_EVERY_S) * POLL_EVERY_S, { dedup: `d${i}` });
  const scheduled: { at: number; run: () => Promise<unknown> }[] = [];
  let version = 0;

  for (let s = 0; s < 86_400; s += POLL_EVERY_S) {
    vi.setSystemTime(start + s * 1000);
    await h.alarms();
    for (const due of scheduled.filter((x) => x.at <= s)) {
      await due.run();
      scheduled.splice(scheduled.indexOf(due), 1);
    }
    const state = (await h.call("GET", `/v1/device/state?v=${version}`, { device })).json;
    version = state.v;

    const incident = openAt.get(s);
    if (incident) {
      const t = trigger(key, incident.dedup);
      const { json } = await h.call("POST", t.path, { body: t.body });
      const id = json.results[0].incident_id;
      for (let r = 0; r < REPEATS_PER_INCIDENT; r++) await h.call("POST", t.path, { body: t.body });
      scheduled.push({ at: s + 180, run: () => h.call("POST", `/v1/incidents/${id}/acknowledge`, { token: B }) });
      scheduled.push({ at: s + 1800, run: () => h.call("POST", `/v1/incidents/${id}/resolve`, { token: T }) });
      for (const token of [T, B]) await h.call("GET", `/v1/incidents/${id}`, { token });
    }
    if (s % (Math.ceil(86_400 / APP_REQUESTS_PER_PERSON / POLL_EVERY_S) * POLL_EVERY_S) === 0) {
      for (const token of [T, B]) await h.call("GET", "/v1/incidents?status=open&limit=100", { token });
    }
  }
  vi.setSystemTime(start + 86_400_000 + 5 * MIN);
  await h.alarms();
}

it("a busy day stays under the free-plan target and never walks a big table", async () => {
  await simulateDay();
  const written = h.stats.rowsWritten * INDEX_FACTOR;
  console.log(`day: ${h.stats.requests} requests, ${h.stats.rowsRead} rows read, ${written} rows written (with indexes)`);
  expect(h.stats.requests).toBeLessThan(TARGET.requests);
  expect(h.stats.rowsRead).toBeLessThan(TARGET.rowsRead);
  expect(written).toBeLessThan(TARGET.rowsWritten);

  // Our row count above only sees rows returned; Cloudflare bills rows scanned. So no query may scan these tables.
  const big = /^SCAN (i|e|incidents|incident_events|outbox|escalations)\b(?!.*USING)/;
  const scans = [...h.queries].filter((q) => /^\s*(select|update|delete)/i.test(q)).flatMap((q) => h.explain(q).filter((d) => big.test(d)).map((d) => `${d}  <-  ${q.trim().slice(0, 100)}`));
  expect(scans).toEqual([]);
}, 60_000);
