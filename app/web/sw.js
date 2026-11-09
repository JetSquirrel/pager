// Pager's service worker: pages a phone or desktop browser even when the app is closed.
// Copied next to the web package's index.html (cloud/scripts/build-web.mjs), so its scope is the whole app.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let p = {};
  try {
    p = e.data ? e.data.json() : {};
  } catch {
    p = { title: "Pager", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(show(p));
});

function show(p) {
  const paging = p.event === "trigger" || p.event === "test";
  const actions = [];
  if (p.ack_url) actions.push({ action: "ack", title: "Acknowledge" });
  if (p.resolve_url) actions.push({ action: "resolve", title: "Resolve" });
  // The same tag replaces the page, so an acknowledged incident stops asking for attention on every device.
  return self.registration.showNotification(p.title || "Pager", {
    body: p.body || "",
    tag: p.tag || undefined,
    renotify: paging && !!p.tag,
    // An urgent page stays on screen until someone answers it.
    requireInteraction: paging && (p.severity === "critical" || p.severity === "error"),
    silent: !paging,
    vibrate: !paging ? undefined : p.severity === "critical" ? [800, 200, 800, 200, 800, 200, 800] : [400, 200, 400, 200, 400],
    data: { url: p.url || self.registration.scope, ack_url: p.ack_url, resolve_url: p.resolve_url },
    actions,
  });
}

async function act(url) {
  try {
    const res = await fetch(url, { method: "POST", headers: { Accept: "application/json" } });
    if (res.ok || res.status === 410) return;
  } catch {
    // fall through: open the app so the person can do it by hand
  }
  await open(self.registration.scope);
}

async function open(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find((w) => w.url.startsWith(self.registration.scope));
  if (!existing) return self.clients.openWindow(url);
  await existing.focus();
  return existing.navigate(url);
}

self.addEventListener("notificationclick", (e) => {
  const data = e.notification.data || {};
  e.notification.close();
  if (e.action === "ack" && data.ack_url) e.waitUntil(act(data.ack_url));
  else if (e.action === "resolve" && data.resolve_url) e.waitUntil(act(data.resolve_url));
  else e.waitUntil(open(data.url || self.registration.scope));
});
