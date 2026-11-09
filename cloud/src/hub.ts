import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * Live updates for every client (mobile, desktop, web). One instance ("global").
 * Uses the WebSocket hibernation API, so idle connections cost nothing.
 * The Worker authenticates the user before forwarding the upgrade here; the user id rides in the attachment.
 */
export class Hub extends DurableObject<Env> {
  /**
   * Bumped on every broadcast. Hardware pagers long-poll with the version they last saw (waitForChange) instead of
   * holding a WebSocket. It starts from the clock, so a restarted instance never repeats an old version.
   */
  private version = Date.now();
  private waiters = new Set<() => void>();

  /** Resolves with the current version as soon as it differs from `seen`, or after `timeoutMs`. */
  async waitForChange(seen: number, timeoutMs: number): Promise<number> {
    if (seen !== this.version) return this.version;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, 30_000)));
      this.waiters.add(done);
    });
    return this.version;
  }

  async currentVersion(): Promise<number> {
    return this.version;
  }

  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get("x-user-id") ?? "";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, since: Date.now() });
    server.send(JSON.stringify({ type: "hello", at: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(message: string): Promise<number> {
    this.version++;
    for (const wake of [...this.waiters]) wake();
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
        sent++;
      } catch {
        // closed socket; the runtime drops it
      }
    }
    return sent;
  }

  async connections(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Clients send "ping" every ~30s to keep mobile NATs and proxies from dropping the socket.
    if (message === "ping") ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}
