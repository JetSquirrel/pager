// The web build's host (nsh.json "web.host"): what the page offers the app, which runs in Wasm without DOM access.
//   pageInfo()        → { origin, hash }      sign-in defaults to this server; #/incidents/<id> deep links
//   notify({title, body, tag, severity}) → shows a browser notification while the tab is in the background
//   requestNotifications() → "granted" | "denied" | "default" | "unsupported"
export function createHost(_player) {
  return {
    call(name, args) {
      switch (name) {
        case "pageInfo":
          return { origin: location.origin, hash: location.hash };
        case "requestNotifications":
          if (!("Notification" in window)) return "unsupported";
          return Notification.requestPermission();
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
