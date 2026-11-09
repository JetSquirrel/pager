import type { Override, Rotation } from "./types";

const HOUR = 3_600_000;

export interface Shift {
  user_id: string;
  starts_at: number;
  ends_at: number;
  override: boolean;
}

/** The rotation's shift covering `at` (rotations repeat forever in both directions). */
export function rotationShiftAt(rotation: Rotation, at: number): Shift | null {
  const n = rotation.users.length;
  if (n === 0 || rotation.shift_hours <= 0) return null;
  const len = rotation.shift_hours * HOUR;
  const k = Math.floor((at - rotation.start) / len);
  const idx = ((k % n) + n) % n;
  const starts_at = rotation.start + k * len;
  return { user_id: rotation.users[idx], starts_at, ends_at: starts_at + len, override: false };
}

/** Who is on call at `at`: the latest-starting override covering `at` wins, else the rotation. */
export function onCallAt(rotation: Rotation, overrides: Override[], at: number): Shift | null {
  const active = overrides
    .filter((o) => o.starts_at <= at && at < o.ends_at)
    .sort((a, b) => b.starts_at - a.starts_at)[0];
  if (active) return { user_id: active.user_id, starts_at: active.starts_at, ends_at: active.ends_at, override: true };
  return rotationShiftAt(rotation, at);
}

/** The shifts from `from` to `to`, rotation only, for showing who is next. */
export function upcomingShifts(rotation: Rotation, from: number, to: number, limit = 20): Shift[] {
  const out: Shift[] = [];
  let at = from;
  while (at < to && out.length < limit) {
    const s = rotationShiftAt(rotation, at);
    if (!s) break;
    out.push(s);
    at = s.ends_at;
  }
  return out;
}
