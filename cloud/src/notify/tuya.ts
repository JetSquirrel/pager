// Tuya Cloud OpenAPI client: drives Tuya smart devices (sirens, alarm lights, smart plugs, light bulbs)
// as physical pagers. Docs: https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g
import type { Env, Incident, NotifyEvent } from "../types";
import { hmacSha256Hex, sha256Hex } from "../util";

export interface TuyaCommand {
  code: string;
  value: unknown;
}

/** contact_methods.config for type "tuya". */
export interface TuyaConfig {
  device_id: string;
  /** Sent when the user is paged. E.g. a siren: [{ code: "AlarmSwitch", value: true }]. */
  on_trigger: TuyaCommand[];
  /** Sent on acknowledge/resolve, to silence the device. E.g. [{ code: "AlarmSwitch", value: false }]. */
  on_clear: TuyaCommand[];
  /** Per-severity overrides of on_trigger, e.g. a red light for critical and yellow for warning. */
  by_severity?: Partial<Record<Incident["severity"], TuyaCommand[]>>;
}

/** Ready-made configs for common device categories (the DP codes Tuya's standard instruction set uses). */
export const TUYA_PRESETS: Record<string, Omit<TuyaConfig, "device_id">> = {
  // Siren alarm (category "sgbj")
  siren: {
    on_trigger: [{ code: "AlarmSwitch", value: true }],
    on_clear: [{ code: "AlarmSwitch", value: false }],
  },
  // Smart plug (category "cz"): plug a rotating beacon or a buzzer into it
  plug: {
    on_trigger: [{ code: "switch_1", value: true }],
    on_clear: [{ code: "switch_1", value: false }],
  },
  // Color light (category "dj"): red for critical, amber for the rest, off when cleared
  light: {
    on_trigger: [
      { code: "switch_led", value: true },
      { code: "work_mode", value: "colour" },
      { code: "colour_data_v2", value: { h: 30, s: 1000, v: 1000 } },
    ],
    by_severity: {
      critical: [
        { code: "switch_led", value: true },
        { code: "work_mode", value: "colour" },
        { code: "colour_data_v2", value: { h: 0, s: 1000, v: 1000 } },
      ],
    },
    on_clear: [{ code: "switch_led", value: false }],
  },
};

export interface TuyaFunction {
  code: string;
  type: string;
  /** Tuya sends this as a JSON string: {"range":["low","high"]} or {"min":1,"max":60}. */
  values: Record<string, unknown>;
}

export interface TuyaSpec {
  category: string;
  functions: TuyaFunction[];
}

export function toSpec(raw: { category?: string; functions?: { code: string; type?: string; values?: unknown }[] }): TuyaSpec {
  const parse = (v: unknown): Record<string, unknown> => {
    if (typeof v !== "string") return (v as Record<string, unknown>) ?? {};
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  };
  return { category: raw.category ?? "", functions: (raw.functions ?? []).map((f) => ({ code: f.code, type: f.type ?? "", values: parse(f.values) })) };
}

/** Sirens name their switch differently from one maker to the next; the first of these a device has is the one. */
const SIREN_SWITCHES = ["AlarmSwitch", "alarm_switch", "siren_switch", "switch_alarm_sound", "alarm_sound_switch"];
const PLUG_SWITCHES = ["switch_1", "switch", "switch_spray", "switch_led_1"];

const RED = { h: 0 };
const AMBER = { h: 30 };

/** How to drive this device, worked out from what it says it can do. Null when it has nothing that makes noise or light. */
export function planFromSpec(spec: TuyaSpec): Omit<TuyaConfig, "device_id"> | null {
  const has = (code: string) => spec.functions.find((f) => f.code === code);
  const firstOf = (codes: string[]) => codes.map(has).find((f) => f && /bool/i.test(f.type));

  const siren = firstOf(SIREN_SWITCHES);
  if (siren) {
    const setup: TuyaCommand[] = [];
    const volume = has("alarm_volume") ?? has("AlarmVolume");
    const levels = ((volume?.values.range as string[] | undefined) ?? []).filter((l) => l !== "mute");
    if (volume && levels.length) setup.push({ code: volume.code, value: levels.includes("high") ? "high" : levels[levels.length - 1] });
    const time = has("alarm_time") ?? has("AlarmPeriod");
    if (time && typeof time.values.max === "number") setup.push({ code: time.code, value: time.values.max });
    return { on_trigger: [...setup, { code: siren.code, value: true }], on_clear: [{ code: siren.code, value: false }] };
  }

  const lamp = has("switch_led");
  const colour = has("colour_data_v2") ?? has("colour_data");
  if (lamp && colour) {
    // v2 runs saturation and value to 1000, the older code to 255.
    const full = colour.code === "colour_data_v2" ? 1000 : 255;
    const paint = (hue: { h: number }): TuyaCommand[] => [
      { code: lamp.code, value: true },
      ...(has("work_mode") ? [{ code: "work_mode", value: "colour" }] : []),
      { code: colour.code, value: { ...hue, s: full, v: full } },
    ];
    return { on_trigger: paint(AMBER), by_severity: { critical: paint(RED) }, on_clear: [{ code: lamp.code, value: false }] };
  }

  const plug = firstOf([...PLUG_SWITCHES, "switch_led"]);
  return plug ? { on_trigger: [{ code: plug.code, value: true }], on_clear: [{ code: plug.code, value: false }] } : null;
}

/** Codes a config sends that this device does not have: a page that would otherwise fail in the middle of the night. */
export function unsupportedCodes(cfg: Omit<TuyaConfig, "device_id">, spec: TuyaSpec): string[] {
  const known = new Set(spec.functions.map((f) => f.code));
  const used = [...cfg.on_trigger, ...cfg.on_clear, ...Object.values(cfg.by_severity ?? {}).flat()].map((c) => c.code);
  return [...new Set(used)].filter((c) => !known.has(c));
}

export interface TuyaDevice {
  id: string;
  name: string;
  category: string;
  product_name: string;
  online: boolean;
  /** The preset that fits its category, if one does. */
  suggested_preset: string | null;
}

type RawTuyaDevice = { id: string; name?: string; category?: string; product_name?: string; online?: boolean };

/** Tuya category codes → preset: sirens and alarms, plugs and switches, lights. */
export function presetForCategory(category: string): string | null {
  if (["sgbj", "sgbj2"].includes(category)) return "siren";
  if (["cz", "pc", "kg", "tdq"].includes(category)) return "plug";
  if (["dj", "dd", "fwd", "dc", "xdd", "fsd", "tgq", "tgkg"].includes(category)) return "light";
  return null;
}

export function toDevice(d: RawTuyaDevice): TuyaDevice {
  const category = d.category ?? "";
  return {
    id: d.id,
    name: d.name || d.product_name || d.id,
    category,
    product_name: d.product_name ?? "",
    online: !!d.online,
    suggested_preset: presetForCategory(category),
  };
}

export function commandsFor(cfg: TuyaConfig, event: NotifyEvent, severity: Incident["severity"]): TuyaCommand[] {
  if (event === "notice") return [];
  if (event === "acknowledge" || event === "resolve" || event === "reassign") return cfg.on_clear ?? [];
  return cfg.by_severity?.[severity] ?? cfg.on_trigger ?? [];
}

/**
 * Tuya's signature (HMAC-SHA256, uppercase hex) over
 *   client_id + access_token + t + nonce + METHOD\n sha256(body)\n headers\n url
 * where url is the path plus its query sorted by key. access_token is "" when fetching a token.
 */
export async function tuyaSign(p: {
  clientId: string;
  secret: string;
  accessToken: string;
  t: string;
  nonce: string;
  method: string;
  path: string;
  body: string;
  /** Headers listed in Signature-Headers, in order (Tuya's optional extra signed headers). */
  signHeaders?: [string, string][];
}): Promise<string> {
  const [pathname, query = ""] = p.path.split("?");
  const sortedQuery = query
    ? "?" +
      query
        .split("&")
        .filter(Boolean)
        .sort((a, b) => a.split("=")[0].localeCompare(b.split("=")[0]))
        .join("&")
    : "";
  const headerBlock = (p.signHeaders ?? []).map(([k, v]) => `${k}:${v}\n`).join("");
  const stringToSign = `${p.method.toUpperCase()}\n${await sha256Hex(p.body)}\n${headerBlock}\n${pathname + sortedQuery}`;
  const str = p.clientId + p.accessToken + p.t + p.nonce + stringToSign;
  return (await hmacSha256Hex(p.secret, str)).toUpperCase();
}

export const DEVICE_OFFLINE = "Tuya device is offline";

export class TuyaClient {
  constructor(private env: Env) {}

  private get creds() {
    const clientId = this.env.TUYA_CLIENT_ID;
    const secret = this.env.TUYA_CLIENT_SECRET;
    if (!clientId || !secret) throw new Error("Tuya is not configured: set TUYA_CLIENT_ID and TUYA_CLIENT_SECRET");
    return { clientId, secret };
  }

  private async request<T>(method: string, path: string, body: unknown, accessToken: string): Promise<T> {
    const { clientId, secret } = this.creds;
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const raw = body === undefined ? "" : JSON.stringify(body);
    const sign = await tuyaSign({ clientId, secret, accessToken, t, nonce, method, path, body: raw });
    const headers: Record<string, string> = {
      client_id: clientId,
      sign,
      t,
      nonce,
      sign_method: "HMAC-SHA256",
      "Content-Type": "application/json",
    };
    if (accessToken) headers.access_token = accessToken;
    const res = await fetch(this.env.TUYA_ENDPOINT + path, { method, headers, body: raw || undefined, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json()) as { success: boolean; result: T; code?: number; msg?: string };
    if (!json.success) throw new Error(`Tuya ${method} ${path}: ${json.code} ${json.msg}`);
    return json.result;
  }

  private async token(): Promise<string> {
    const cached = await this.env.CACHE.get("tuya:token");
    if (cached) return cached;
    const r = await this.request<{ access_token: string; expire_time: number }>("GET", "/v1.0/token?grant_type=1", undefined, "");
    // Keep a margin under Tuya's expiry (usually 7200 s).
    await this.env.CACHE.put("tuya:token", r.access_token, { expirationTtl: Math.max(60, r.expire_time - 300) });
    return r.access_token;
  }

  private async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.request<T>(method, path, body, await this.token());
    } catch (e) {
      // 1010 = token invalid: drop the cached token and retry once.
      if (!String(e).includes(" 1010 ")) throw e;
      await this.env.CACHE.delete("tuya:token");
      return this.request<T>(method, path, body, await this.token());
    }
  }

  async sendCommands(deviceId: string, commands: TuyaCommand[]): Promise<void> {
    if (commands.length === 0) return;
    await this.authed("POST", `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/commands`, { commands });
  }

  async specification(deviceId: string): Promise<TuyaSpec> {
    return toSpec(await this.authed("GET", `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/specification`));
  }

  async online(deviceId: string): Promise<boolean> {
    return !!(await this.authed<{ online?: boolean }>("GET", `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}`)).online;
  }

  /** Every device of the accounts linked to the cloud project (Tuya: GET /v1.0/devices, paged by last_id). */
  async listDevices(max = 500): Promise<TuyaDevice[]> {
    const token = await this.token();
    const out: TuyaDevice[] = [];
    let lastId: string | undefined;
    while (out.length < max) {
      const q = `page_no=1&page_size=100${lastId ? `&last_id=${encodeURIComponent(lastId)}` : ""}`;
      const r = await this.request<{ devices?: RawTuyaDevice[]; last_id?: string | number; total?: number }>("GET", `/v1.0/devices?${q}`, undefined, token);
      const page = (r.devices ?? []).map(toDevice);
      out.push(...page);
      if (page.length < 100 || !r.last_id || String(r.last_id) === lastId) break;
      lastId = String(r.last_id);
    }
    return out.slice(0, max);
  }

  async deviceStatus(deviceId: string): Promise<{ code: string; value: unknown }[]> {
    return this.authed("GET", `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/status`);
  }
}

export async function sendTuya(env: Env, cfg: TuyaConfig, incident: Incident, event: NotifyEvent) {
  const commands = commandsFor(cfg, event, incident.severity);
  if (commands.length === 0) return;
  const client = new TuyaClient(env);
  // Tuya accepts a command for a device that is off the network and it goes nowhere. Better a failure on the timeline.
  if ((event === "trigger" || event === "test") && !(await client.online(cfg.device_id))) throw new Error(DEVICE_OFFLINE);
  await client.sendCommands(cfg.device_id, commands);
}
