// Cloudflare free-plan budget: the pager must run on the Workers Free plan. This is a hard rule (see AGENTS.md).
// Past a daily limit every operation of that kind fails until 00:00 UTC, which for a pager means nobody gets woken.
// The steady state must stay under TARGET (a fifth of FREE); test/budget.test.ts fails when a simulated day goes over.
export const FREE = { requests: 100_000, rowsRead: 5_000_000, rowsWritten: 100_000, durationGbS: 13_000 } as const;
export const TARGET = { requests: 20_000, rowsRead: 1_000_000, rowsWritten: 20_000 } as const;

/** Fractions of FREE: past LEAN the timeline stops recording repeats; past SHED it stops recording delivery receipts. */
export const LEAN = 0.4;
export const SHED = 0.7;

/** A hardware pager's last_seen is written at most this often: its polls are the busiest thing the Worker sees. */
export const DEVICE_SEEN_MS = 5 * 60_000;
/** One in this many hardware polls is metered (and counted that many times): a counter write per poll would cost more than the poll. */
export const POLL_SAMPLE = 16;

export type Pressure = "ok" | "lean" | "shed";

export interface Usage {
  day: string;
  requests: number;
  rowsRead: number;
  rowsWritten: number;
  /** Per route: [requests, rowsRead, rowsWritten]. */
  routes: Record<string, [number, number, number]>;
}

export const emptyUsage = (day: string): Usage => ({ day, requests: 0, rowsRead: 0, rowsWritten: 0, routes: {} });

export function pressure(u: Pick<Usage, "requests" | "rowsRead" | "rowsWritten">): Pressure {
  const used = Math.max(u.requests / FREE.requests, u.rowsRead / FREE.rowsRead, u.rowsWritten / FREE.rowsWritten);
  return used >= SHED ? "shed" : used >= LEAN ? "lean" : "ok";
}
