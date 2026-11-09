// Signed one-tap action links ("Acknowledge" in a push notification, Slack message or email),
// so a responder can act without opening the app or holding an API token.
import type { Env } from "./types";
import { hmacSha256Hex } from "./util";

export type ActionKind = "ack" | "resolve";

const TTL_MS = 24 * 3_600_000;

function secret(env: Env): string {
  const s = env.ACTION_SECRET || env.BOOTSTRAP_TOKEN;
  if (!s) throw new Error("ACTION_SECRET is not set");
  return s;
}

export async function actionToken(env: Env, incidentId: string, userId: string, kind: ActionKind, at = Date.now()) {
  const payload = `${incidentId}.${userId}.${kind}.${(at + TTL_MS).toString(36)}`;
  const sig = (await hmacSha256Hex(secret(env), payload)).slice(0, 32);
  return `${payload}.${sig}`;
}

export async function actionUrl(env: Env, incidentId: string, userId: string, kind: ActionKind) {
  return `${env.PUBLIC_URL}/v1/actions/${await actionToken(env, incidentId, userId, kind)}`;
}

export async function verifyActionToken(
  env: Env,
  token: string,
  at = Date.now(),
): Promise<{ incidentId: string; userId: string; kind: ActionKind } | null> {
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [incidentId, userId, kind, exp, sig] = parts;
  if (kind !== "ack" && kind !== "resolve") return null;
  if (parseInt(exp, 36) < at) return null;
  const expected = (await hmacSha256Hex(secret(env), parts.slice(0, 4).join("."))).slice(0, 32);
  if (!timingSafeEqual(expected, sig)) return null;
  return { incidentId, userId, kind };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
