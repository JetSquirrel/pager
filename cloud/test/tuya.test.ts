import { describe, expect, it } from "vitest";
import { commandsFor, TUYA_PRESETS, tuyaSign } from "../src/notify/tuya";

// Worked examples from https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g
const base = {
  clientId: "1KAD46OrT9HafiKdsXeg",
  secret: "4OHBOnWOqaEC1mWXOpVL3yV50s0qGSRC",
  t: "1588925778000",
  nonce: "5138cc3a9033d69856923fd07b491173",
  method: "GET",
  body: "",
  signHeaders: [
    ["area_id", "29a33e8796834b1efa6"],
    ["call_id", "8afdb70ab2ed11eb85290242ac130003"],
  ] as [string, string][],
};

describe("tuyaSign", () => {
  it("matches Tuya's token API example", async () => {
    expect(await tuyaSign({ ...base, accessToken: "", path: "/v1.0/token?grant_type=1" })).toBe(
      "9E48A3E93B302EEECC803C7241985D0A34EB944F40FB573C7B5C2A82158AF13E",
    );
  });

  it("matches Tuya's business API example, with the query sorted", async () => {
    expect(
      await tuyaSign({
        ...base,
        accessToken: "3f4eda2bdec17232f67c0b188af3eec1",
        path: "/v2.0/apps/schema/users?page_size=50&page_no=1",
      }),
    ).toBe("AE4481C692AA80B25F3A7E12C3A5FD9BBF6251539DD78E565A1A72A508A88784");
  });
});

describe("commandsFor", () => {
  const light = { device_id: "d", ...TUYA_PRESETS.light };
  it("uses severity overrides when paging", () => {
    expect(commandsFor(light, "trigger", "critical")).toContainEqual({ code: "colour_data_v2", value: { h: 0, s: 1000, v: 1000 } });
    expect(commandsFor(light, "trigger", "warning")).toContainEqual({ code: "colour_data_v2", value: { h: 30, s: 1000, v: 1000 } });
  });
  it("clears on acknowledge and resolve", () => {
    expect(commandsFor(light, "acknowledge", "critical")).toEqual([{ code: "switch_led", value: false }]);
    expect(commandsFor(light, "resolve", "info")).toEqual([{ code: "switch_led", value: false }]);
  });
});

import { afterEach, vi } from "vitest";
import { presetForCategory, TuyaClient } from "../src/notify/tuya";

describe("TuyaClient.listDevices", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pages through /v1.0/devices and suggests presets", async () => {
    const kv = new Map<string, string>();
    const env = {
      TUYA_CLIENT_ID: "id",
      TUYA_CLIENT_SECRET: "secret",
      TUYA_ENDPOINT: "https://openapi.tuyaus.com",
      CACHE: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) },
    } as any;
    const urls: string[] = [];
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `d${from + i}`, name: `Dev ${from + i}`, category: i % 2 ? "sgbj" : "cz", online: true }));
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      urls.push(url);
      const h = init.headers as Record<string, string>;
      expect(h.sign).toMatch(/^[0-9A-F]{64}$/);
      if (url.includes("/v1.0/token")) return Response.json({ success: true, result: { access_token: "AT", expire_time: 7200 } });
      expect(h.access_token).toBe("AT");
      if (!url.includes("last_id")) return Response.json({ success: true, result: { devices: page(100, 0), last_id: "x1" } });
      return Response.json({ success: true, result: { devices: page(3, 100), last_id: "x2" } });
    });
    const devices = await new TuyaClient(env).listDevices();
    expect(devices).toHaveLength(103);
    expect(devices[1]).toEqual({ id: "d1", name: "Dev 1", category: "sgbj", product_name: "", online: true, suggested_preset: "siren" });
    expect(urls.filter((u) => u.includes("/v1.0/token"))).toHaveLength(1);
    expect(urls[2]).toContain("last_id=x1");
  });

  it("maps categories", () => {
    expect(presetForCategory("dj")).toBe("light");
    expect(presetForCategory("cz")).toBe("plug");
    expect(presetForCategory("wsdcg")).toBeNull();
  });
});
