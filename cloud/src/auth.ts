import type { Context, MiddlewareHandler } from "hono";
import type { Env, User } from "./types";
import { HttpError, sha256Hex } from "./util";

export type AppEnv = { Bindings: Env; Variables: { user: User } };

/** Bearer token from the Authorization header, or ?token= for WebSocket upgrades (browsers can't set headers there). */
export function bearer(c: Context<AppEnv>): string | null {
  const h = c.req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  if (c.req.header("upgrade")?.toLowerCase() === "websocket") return c.req.query("token") ?? null;
  return null;
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw new HttpError(401, "missing bearer token");
  const user = await c.env.DB.prepare(
    `SELECT id, email, name, role, can_notify_customers, timezone, created_at FROM users WHERE token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<User>();
  if (!user) throw new HttpError(401, "invalid token");
  c.set("user", user);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user").role !== "admin") throw new HttpError(403, "admin only");
  await next();
};
