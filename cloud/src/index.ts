// The Worker in front of the one Durable Object (src/pager.ts) that holds everything. It also does the waiting that
// would otherwise keep the object awake: a Worker is billed for CPU, not for time spent waiting.
import type { Bindings } from "./types";

export { Pager } from "./pager";

const MAX_WAIT_S = 25;

/**
 * A hardware pager asks "tell me when my state moves past version v". The object sends the current state over a
 * hibernating socket at once and again on the next change; this Worker holds the HTTP request meanwhile. Waiting inside
 * the object would stop it hibernating, and one board would use most of the free plan's Durable Object duration.
 */
async function longPoll(req: Request, pager: DurableObjectStub, seen: number, waitSeconds: number): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("Upgrade", "websocket");
  const res = await pager.fetch(new Request(req.url, { headers }));
  const ws = res.webSocket;
  if (!ws) return res;
  ws.accept();
  return new Promise((resolve) => {
    let first: { v: number; now: number } | undefined;
    const finish = (state: unknown) => {
      clearTimeout(timer);
      try {
        ws.close(1000, "done");
      } catch {
        // already closed
      }
      resolve(state ? Response.json(state) : Response.json({ error: "try again" }, { status: 503 }));
    };
    const timer = setTimeout(() => finish(first && { ...first, now: first.now + waitSeconds * 1000 }), waitSeconds * 1000);
    ws.addEventListener("message", (e) => {
      const state = JSON.parse(String(e.data));
      if (first === undefined && state.v === seen) first = state;
      else finish(state);
    });
    ws.addEventListener("close", () => finish(first));
    ws.addEventListener("error", () => finish(first));
  });
}

export default {
  async fetch(req: Request, env: Bindings): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") return Response.redirect(`${url.origin}/app/`, 302);
    if (!url.pathname.startsWith("/v1/")) return new Response("not found", { status: 404 });
    const pager = env.PAGER.get(env.PAGER.idFromName("pager"));
    if (url.pathname === "/v1/device/state") {
      const seen = Number(url.searchParams.get("v") ?? NaN);
      const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait") ?? 0)));
      if (Number.isFinite(seen) && wait > 0) return longPoll(req, pager, seen, wait);
    }
    return pager.fetch(req);
  },
} satisfies ExportedHandler<Bindings>;
