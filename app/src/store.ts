// App state: the session, the open incidents and the live connection to the Worker's Hub.
import { batch, computed, effect, signal, Storage } from "nsh";
import { isAvailable as hasWindow, Window } from "nsh/desktop";
import { Api, type Incident, type Session, type User } from "./api";
import { incidentFromHash, notify, onOpen, pageInfo, requestNotifications } from "./host";
import { toast } from "./toast";

const SESSION_KEY = "pager.session";

export const session = signal<Session | null>(null);
export const me = signal<User | null>(null);
export const ready = signal(false);
export const incidents = signal<Incident[]>([]);
export const connection = signal<"offline" | "connecting" | "live">("offline");
export const lastError = signal<string | null>(null);
/** An incident the app was opened for (web: #/incidents/<id> from a notification link). */
export const deepLink = signal<string | null>(null);

let client: Api | null = null;
export const api = () => {
  if (!client) throw new Error("not signed in");
  return client;
};

export const triggered = computed(() => incidents().filter((i) => i.status === "triggered"));
export const acknowledged = computed(() => incidents().filter((i) => i.status === "acknowledged"));

/** Restores the saved session at start-up. */
export async function boot() {
  const page = await pageInfo();
  deepLink.set(incidentFromHash(page?.hash));
  onOpen((hash) => deepLink.set(incidentFromHash(hash)));
  const saved = await Storage.getItem(SESSION_KEY);
  if (saved) {
    try {
      await signIn(JSON.parse(saved) as Session, false);
    } catch {
      // stale token or server gone: show the sign-in screen
    }
  }
  ready.set(true);
}

export async function signIn(s: Session, persist = true) {
  const candidate = new Api({ server: s.server.trim().replace(/\/+$/, ""), token: s.token.trim() });
  const { user } = await candidate.me();
  client = candidate;
  if (persist) {
    await Storage.setItem(SESSION_KEY, JSON.stringify(candidate.session));
    // Signing in is a user gesture: the moment to ask for system notifications (web).
    requestNotifications();
  }
  batch(() => {
    session.set(candidate.session);
    me.set(user);
  });
  await refresh();
  connect();
}

export async function signOut() {
  disconnect();
  client = null;
  await Storage.removeItem(SESSION_KEY);
  batch(() => {
    session.set(null);
    me.set(null);
    incidents.set([]);
  });
}

export async function refresh() {
  try {
    const { incidents: list } = await api().incidents("open");
    incidents.set(list);
    lastError.set(null);
  } catch (e) {
    lastError.set(String((e as Error).message ?? e));
  }
}

/** Puts a changed incident into the open list (or takes it out once resolved). */
export function upsert(incident: Incident) {
  incidents.update((list) => {
    const rest = list.filter((i) => i.id !== incident.id);
    if (incident.status === "resolved") return rest;
    return [incident, ...rest].sort((a, b) => b.created_at - a.created_at);
  });
}

// ------------------------------------------------------------ live updates

let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let wanted = false;

function connect() {
  wanted = true;
  if (socket || !client) return;
  connection.set("connecting");
  const ws = new WebSocket(client.streamUrl());
  socket = ws;

  ws.addEventListener("open", () => {
    retries = 0;
    connection.set("live");
    // Catch up on anything that happened while we were away.
    refresh();
    pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
  });

  ws.onmessage = (event) => {
    let msg: { type: string; incident?: Incident };
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!msg.incident) return;
    upsert(msg.incident);
    if (msg.type === "incident.triggered") {
      toast(`#${msg.incident.number} ${msg.incident.title}`, msg.incident.severity);
      notify({
        title: `#${msg.incident.number} ${msg.incident.title}`,
        body: [msg.incident.service_name, msg.incident.severity].filter(Boolean).join("  "),
        tag: msg.incident.id,
        severity: msg.incident.severity,
      });
    }
  };

  const closed = () => {
    if (socket !== ws) return;
    socket = null;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    connection.set("offline");
    if (wanted) {
      // Back off 1s, 2s, 4s … up to 30s.
      const delay = Math.min(30_000, 1000 * 2 ** retries++);
      retryTimer = setTimeout(connect, delay);
    }
  };
  ws.addEventListener("close", closed);
  ws.addEventListener("error", closed);
}

function disconnect() {
  wanted = false;
  if (retryTimer) clearTimeout(retryTimer);
  const ws = socket;
  socket = null;
  ws?.close();
  if (pingTimer) clearInterval(pingTimer);
  connection.set("offline");
}

// NSH 0.3 has no app-lifecycle signal: a socket the OS killed in the background shows up as a close,
// and the reconnect loop above (plus the poll below) brings the list back when the app is used again.

// Safety net when the socket is down: poll every 30s while the app is in use.
setInterval(() => {
  if (session() && connection() !== "live") refresh();
}, 30_000);

// Desktop: show the count of unacknowledged pages in the window title (taskbar, Dock, window switcher).
effect(() => {
  const n = triggered().length;
  if (hasWindow) Window.setTitle(n > 0 ? `(${n}) Pager` : "Pager");
});
