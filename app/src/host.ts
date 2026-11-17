// What the surrounding host offers, where there is one: the web page (host.js) today; a native shell's push
// registration later. Every call degrades to "not available" so the same code runs on every target.
import { host } from "nsh";
import type { Severity } from "./api";

const has = () => {
  try {
    return host.available();
  } catch {
    return false;
  }
};

async function call<T>(name: string, data?: unknown, timeout = 2000): Promise<T | null> {
  if (!has()) return null;
  try {
    return await host.call<T>(name, data, { timeout });
  } catch {
    return null;
  }
}

/** The web page the app is served from: its origin is the pager server, its hash may name an incident. */
export const pageInfo = () => call<{ origin: string; hash: string }>("pageInfo");

/** Asks the browser for notification permission (a user gesture should precede it). */
export const requestNotifications = () => call<string>("requestNotifications");

/** A system notification while the app is in the background (web: a browser notification). */
export const notify = (n: { title: string; body?: string; tag?: string; severity?: Severity }) => call<boolean>("notify", n);

export interface PushState {
  supported: boolean;
  ios: boolean;
  standalone: boolean;
  endpoint: string | null;
  permission?: "granted" | "denied" | "default" | "unsupported";
}

export type PushSubscribed = { endpoint: string; keys: { p256dh: string; auth: string }; label: string } | { error: string };

/** Whether this browser can be paged with the app closed. Null where there is no page around the app. */
export const pushState = () => call<PushState>("pushState");

/** Asks for permission and subscribes. The wait covers the person answering the browser's prompt. */
export const pushEnable = (publicKey: string) => call<PushSubscribed>("pushEnable", { publicKey }, 120_000);

/** Calls back when the URL hash changes while the app is running (a notification was tapped). */
export function onOpen(fn: (hash: string) => void) {
  if (has()) host.on("open", (data: unknown) => fn((data as { hash?: string })?.hash ?? ""));
}

/** "#/incidents/inc_123" → "inc_123". */
export function incidentFromHash(hash: string | undefined | null): string | null {
  const m = /^#\/incidents\/([\w-]+)/.exec(hash ?? "");
  return m ? m[1] : null;
}
