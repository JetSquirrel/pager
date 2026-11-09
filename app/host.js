// The web build's host (nsh.json "web.host"): what the page offers the app, which runs in Wasm without DOM access.
//   pageInfo()        → { origin, hash }      sign-in defaults to this server; #/incidents/<id> deep links
//   notify({title, body, tag, severity}) → shows a browser notification while the tab is in the background
//   requestNotifications() → "granted" | "denied" | "default" | "unsupported"
//   pushState()       → can this browser be paged while the app is closed, and is it already subscribed?
//   pushEnable({publicKey}) → { endpoint, keys, label } or { error }
// Event "open" { hash }: the URL hash changed while the app was running (a notification was tapped).

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const ua = () => navigator.userAgent;
const isIos = () => /iPhone|iPad|iPod/.test(ua()) || (/Macintosh/.test(ua()) && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function deviceLabel() {
  const u = ua();
  const device = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android" : /Mac OS X/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "Device";
  const browser = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "browser";
  return `${device} ${standalone() ? "app" : browser}`;
}

function keyBytes(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

async function pushState() {
  const state = { supported: pushSupported(), ios: isIos(), standalone: standalone(), endpoint: null };
  if (!state.supported) return state;
  try {
    const reg = await navigator.serviceWorker.getRegistration("./");
    const sub = reg && (await reg.pushManager.getSubscription());
    state.endpoint = sub && Notification.permission === "granted" ? sub.endpoint : null;
  } catch {
    // treated as not subscribed
  }
  return state;
}

async function pushEnable({ publicKey }) {
  if (!pushSupported()) return { error: "This browser cannot receive push notifications." };
  if ((await Notification.requestPermission()) !== "granted") return { error: "Notifications are blocked for this site." };
  try {
    await navigator.serviceWorker.register(new URL("sw.js", location.href).href, { scope: "./" });
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    const { endpoint, keys } = sub.toJSON();
    return { endpoint, keys, label: deviceLabel() };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

export function createHost(player) {
  if (typeof window !== "undefined") window.addEventListener("hashchange", () => player.hostEvent("open", { hash: location.hash }));
  return {
    call(name, args) {
      switch (name) {
        case "pageInfo":
          return { origin: location.origin, hash: location.hash };
        case "requestNotifications":
          if (!("Notification" in window)) return "unsupported";
          return Notification.requestPermission();
        case "pushState":
          return pushState();
        case "pushEnable":
          return pushEnable(args ?? {});
        case "notify": {
          if (!("Notification" in window) || Notification.permission !== "granted") return false;
          if (document.visibilityState === "visible" && document.hasFocus()) return false;
          const { title, body, tag, severity } = args ?? {};
          const n = new Notification(title, { body, tag, requireInteraction: severity === "critical" });
          n.onclick = () => {
            window.focus();
            if (tag) location.hash = `#/incidents/${tag}`;
            n.close();
          };
          return true;
        }
        default:
          return Promise.reject(new Error(`unknown host call ${name}`));
      }
    },
  };
}
