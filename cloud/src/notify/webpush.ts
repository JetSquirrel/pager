// Web Push with no third-party service: RFC 8291 (aes128gcm message encryption) and RFC 8292 (VAPID).
// Pure WebCrypto. The approach comes from Noop's cloud/src/push.ts.
import { actionUrl } from "../actions";
import type { Env, Incident, NotifyEvent } from "../types";

export interface WebPushConfig {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Vapid {
  publicKey: string;
  privateJwk: JsonWebKey;
  subject: string;
}

/** The push service says this subscription is gone: the contact method should be removed, not retried. */
export class SubscriptionGone extends Error {}

type Bytes = any; // workers-types and lib.dom disagree about Uint8Array's buffer type
const te = new TextEncoder();

export const b64u = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
export const unb64u = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key as Bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as Bytes));
}

/** HKDF with one output block (at most 32 bytes), which is all RFC 8291 needs. */
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) =>
  (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, length);

const publicJwk = (raw: Uint8Array) => ({
  kty: "EC",
  crv: "P-256",
  x: b64u(raw.slice(1, 33)),
  y: b64u(raw.slice(33, 65)),
  ext: true,
});

/** `fixed` is for the RFC's test vector only. */
export async function encrypt(
  plaintext: Uint8Array,
  sub: WebPushConfig,
  fixed?: { asPrivate: string; asPublic: string; salt: string },
): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (fixed) {
    asPublic = unb64u(fixed.asPublic);
    asPrivate = await crypto.subtle.importKey("jwk", { ...publicJwk(asPublic), d: fixed.asPrivate } as JsonWebKey, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as Bytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as Bytes, asPrivate, 256));
  const ikm = await hkdf(authSecret, shared, cat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed ? unb64u(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek as Bytes, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as Bytes }, key, cat(plaintext, new Uint8Array([2])) as Bytes));
  const rs = 4096;
  return cat(salt, new Uint8Array([rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length]), asPublic, sealed);
}

export async function vapidAuth(endpoint: string, v: Vapid, at = Date.now()): Promise<string> {
  const enc = (o: unknown) => b64u(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(at / 1000) + 12 * 3600, sub: v.subject })}`;
  const key = await crypto.subtle.importKey("jwk", v.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${v.publicKey}`;
}

export async function newVapidKeys(): Promise<{ publicKey: string; privateJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const { kty, crv, x, y, d } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { publicKey: b64u(raw), privateJwk: { kty, crv, x, y, d } };
}

/** What the service worker (app/web/sw.js) turns into a notification. */
export async function pushPayload(env: Env, incident: Incident, userId: string, event: NotifyEvent) {
  const paging = event === "trigger";
  const verb = event === "acknowledge" ? "Acknowledged" : event === "resolve" ? "Resolved" : event === "reassign" ? "Reassigned" : event === "notice" ? "Notice" : event === "test" ? "Test page" : "";
  return {
    title: `${verb ? `${verb}: ` : ""}${incident.number ? `#${incident.number} ` : ""}${incident.title}`.slice(0, 160),
    body: [incident.service_name, incident.severity].filter(Boolean).join("  "),
    tag: incident.id,
    event,
    severity: incident.severity,
    url: `${env.PUBLIC_URL}/app/#/incidents/${incident.id}`,
    ack_url: paging ? await actionUrl(env, incident.id, userId, "ack") : undefined,
    resolve_url: paging ? await actionUrl(env, incident.id, userId, "resolve") : undefined,
  };
}

export async function sendWebPush(env: Env, cfg: WebPushConfig, incident: Incident, userId: string, event: NotifyEvent): Promise<void> {
  const paging = event === "trigger" || event === "test";
  const vapid = await env.vapid();
  const body = await encrypt(te.encode(JSON.stringify(await pushPayload(env, incident, userId, event))), cfg);
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(cfg.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "3600",
      Urgency: paging ? "high" : "normal",
      // A later message for the same incident replaces one still waiting for the phone to come online.
      Topic: incident.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
    },
    body: body as Bytes,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 410) throw new SubscriptionGone(`push subscription gone: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`web push: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}
