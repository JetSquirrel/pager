import { SEVERITIES, type Severity } from "./types";

export const now = () => Date.now();

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/** A random URL-safe secret (tokens, integration keys). */
export function newSecret(bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
}

export function severityRank(s: string): number {
  const i = SEVERITIES.indexOf(s as Severity);
  return i < 0 ? 0 : i;
}

export function normalizeSeverity(raw: unknown, fallback: Severity = "critical"): Severity {
  const s = String(raw ?? "").toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(s)) return s as Severity;
  if (s === "page" || s === "high" || s === "p1" || s === "sev1" || s === "fatal" || s === "disaster") return "critical";
  if (s === "p2" || s === "sev2" || s === "major") return "error";
  if (s === "p3" || s === "sev3" || s === "minor" || s === "warn" || s === "average") return "warning";
  if (s === "p4" || s === "p5" || s === "low" || s === "information" || s === "ok") return "info";
  return fallback;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
