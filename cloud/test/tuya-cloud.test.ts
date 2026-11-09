import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planFromSpec, toSpec, unsupportedCodes } from "../src/notify/tuya";
import { makeHarness, seed, trigger, type Harness } from "./harness";

const fn = (code: string, type: string, values: unknown = {}) => ({ code, type, values: JSON.stringify(values) });
const SIREN = [fn("alarm_volume", "Enum", { range: ["low", "middle", "high", "mute"] }), fn("alarm_time", "Integer", { min: 1, max: 60, step: 1 }), fn("alarm_switch", "Boolean")];

describe("planFromSpec", () => {
  it("drives a siren loudest and longest, whatever its switch is called", () => {
    expect(planFromSpec(toSpec({ functions: SIREN }))).toEqual({
      on_trigger: [{ code: "alarm_volume", value: "high" }, { code: "alarm_time", value: 60 }, { code: "alarm_switch", value: true }],
      on_clear: [{ code: "alarm_switch", value: false }],
    });
    expect(planFromSpec(toSpec({ functions: [fn("AlarmSwitch", "Boolean")] }))?.on_clear).toEqual([{ code: "AlarmSwitch", value: false }]);
  });

  it("paints a light red for critical, scaled to its colour code", () => {
    const v2 = planFromSpec(toSpec({ functions: [fn("switch_led", "Boolean"), fn("work_mode", "Enum"), fn("colour_data_v2", "Json")] }))!;
    expect(v2.by_severity!.critical).toContainEqual({ code: "colour_data_v2", value: { h: 0, s: 1000, v: 1000 } });
    expect(v2.on_trigger).toContainEqual({ code: "colour_data_v2", value: { h: 30, s: 1000, v: 1000 } });
    const old = planFromSpec(toSpec({ functions: [fn("switch_led", "Boolean"), fn("colour_data", "Json")] }))!;
    expect(old.on_trigger).toEqual([{ code: "switch_led", value: true }, { code: "colour_data", value: { h: 30, s: 255, v: 255 } }]);
  });

  it("falls back to a plain switch, and gives up on a sensor", () => {
    expect(planFromSpec(toSpec({ functions: [fn("switch_1", "Boolean")] }))?.on_trigger).toEqual([{ code: "switch_1", value: true }]);
    expect(planFromSpec(toSpec({ functions: [fn("va_temperature", "Integer")] }))).toBeNull();
  });

  it("finds commands the device does not have", () => {
    const cfg = { on_trigger: [{ code: "AlarmSwitch", value: true }], on_clear: [{ code: "AlarmSwitch", value: false }] };
    expect(unsupportedCodes(cfg, toSpec({ functions: SIREN }))).toEqual(["AlarmSwitch"]);
  });
});

describe("Tuya devices in the pager", () => {
  const MIN = 60_000;
  let h: Harness;
  let online: boolean;
  let commands: any[];
  let hooks: any[];
  let tuyaDown: boolean;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-09T00:00:00Z") });
    online = true;
    commands = [];
    hooks = [];
    tuyaDown = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = String(url);
      const ok = (result: unknown) => Response.json({ success: true, result });
      if (!u.startsWith("https://tuya.test")) {
        hooks.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      }
      if (u.includes("/v1.0/token")) return ok({ access_token: "AT", expire_time: 7200 });
      if (tuyaDown) return Response.json({ success: false, code: 500, msg: "system error" });
      if (u.endsWith("/specification")) return ok({ category: "sgbj", functions: SIREN });
      if (u.endsWith("/commands")) {
        commands.push(JSON.parse(String(init?.body)).commands);
        return ok(true);
      }
      return ok({ online });
    });
    h = makeHarness({ TUYA_CLIENT_ID: "id", TUYA_CLIENT_SECRET: "secret" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const addSiren = (token: string, config: Record<string, unknown> = { device_id: "d1", preset: "auto" }) =>
    h.call("POST", "/v1/contact-methods", { token, body: { type: "tuya", label: "Desk siren", config } });
  const fire = async (key: string) => {
    const t = trigger(key, "disk");
    return (await h.call("POST", t.path, { body: t.body })).json.results[0];
  };
  const advance = async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    await h.alarms();
  };

  it("works out the commands from the device", async () => {
    const { T } = await seed(h);
    expect((await addSiren(T)).status).toBe(201);
    const [m] = (await h.call("GET", "/v1/contact-methods", { token: T })).json.contact_methods;
    expect(m.config.on_trigger).toContainEqual({ code: "alarm_switch", value: true });
  });

  it("refuses a preset the device cannot follow, and says what it offers", async () => {
    const { T } = await seed(h);
    const res = await addSiren(T, { device_id: "d1", preset: "siren" });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("AlarmSwitch");
    expect(res.json.error).toContain("alarm_switch");
  });

  it("rings, then silences on acknowledge", async () => {
    const { T, key } = await seed(h);
    await addSiren(T);
    const r = await fire(key);
    await h.alarms();
    expect(commands.at(-1)).toContainEqual({ code: "alarm_switch", value: true });
    await h.call("POST", `/v1/incidents/${r.incident_id}/acknowledge`, { token: T });
    await h.alarms();
    expect(commands.at(-1)).toEqual([{ code: "alarm_switch", value: false }]);
  });

  it("puts an offline siren on the timeline instead of pretending it rang", async () => {
    const { T, key } = await seed(h);
    await addSiren(T);
    online = false;
    const r = await fire(key);
    await h.alarms();
    expect(commands).toEqual([]);
    const events = (await h.call("GET", `/v1/incidents/${r.incident_id}`, { token: T })).json.events;
    expect(events.find((e: any) => e.kind === "notify_failed").message).toContain("offline");
  });

  it("tells the owner once when a device drops off, and clears when it is back", async () => {
    const { T } = await seed(h);
    await addSiren(T);
    await h.call("POST", "/v1/contact-methods", { token: T, body: { type: "webhook", label: "Phone", config: { url: "https://phone.test/" } } });
    online = false;
    await advance(31 * MIN);
    await advance(31 * MIN);
    expect(hooks.map((b) => b.event)).toEqual(["notice"]);
    expect(hooks[0].incident.title).toContain("offline");
    const siren = async () => (await h.call("GET", "/v1/contact-methods", { token: T })).json.contact_methods.find((m: any) => m.type === "tuya");
    expect((await siren()).last_error).toBe("Tuya device is offline");
    online = true;
    await advance(31 * MIN);
    expect((await siren()).last_error).toBeNull();
  });

  it("does not call a device offline because Tuya is down", async () => {
    const { T } = await seed(h);
    await addSiren(T);
    tuyaDown = true;
    await advance(31 * MIN);
    expect((await h.call("GET", "/v1/contact-methods", { token: T })).json.contact_methods[0].last_error).toBeNull();
  });

  it("snoozes from the hardware pager's long press", async () => {
    const { T, key } = await seed(h);
    const device = (await h.call("POST", "/v1/devices", { token: T, body: { name: "Desk" } })).json.token;
    await fire(key);
    expect((await h.call("POST", "/v1/device/snooze?minutes=30", { device })).json).toEqual({ snoozed: [1], minutes: 30 });
    expect((await h.call("GET", "/v1/device/state", { device })).json).toMatchObject({ alert: 0, acked: 1 });
    await advance(31 * MIN);
    expect((await h.call("GET", "/v1/device/state", { device })).json).toMatchObject({ alert: 1 });
  });
});
