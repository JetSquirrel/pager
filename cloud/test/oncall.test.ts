import { describe, expect, it } from "vitest";
import { onCallAt, rotationShiftAt, upcomingShifts } from "../src/oncall";
import { planStep } from "../src/escalation";

const H = 3_600_000;
const rotation = { start: 1_000 * H, shift_hours: 24, users: ["a", "b", "c"] };

describe("rotation", () => {
  it("cycles through users", () => {
    expect(rotationShiftAt(rotation, 1_000 * H)!.user_id).toBe("a");
    expect(rotationShiftAt(rotation, 1_000 * H + 23 * H)!.user_id).toBe("a");
    expect(rotationShiftAt(rotation, 1_000 * H + 24 * H)!.user_id).toBe("b");
    expect(rotationShiftAt(rotation, 1_000 * H + 72 * H)!.user_id).toBe("a");
  });
  it("works before the start", () => {
    const s = rotationShiftAt(rotation, 1_000 * H - 1)!;
    expect(s.user_id).toBe("c");
    expect(s.ends_at).toBe(1_000 * H);
  });
  it("is empty without users", () => {
    expect(rotationShiftAt({ ...rotation, users: [] }, 0)).toBeNull();
  });
  it("lets the newest override win", () => {
    const at = 1_000 * H + 5 * H;
    const overrides = [
      { user_id: "x", starts_at: at - 2 * H, ends_at: at + H },
      { user_id: "y", starts_at: at - H, ends_at: at + H },
      { user_id: "z", starts_at: at + H, ends_at: at + 2 * H },
    ];
    expect(onCallAt(rotation, overrides, at)).toMatchObject({ user_id: "y", override: true });
    expect(onCallAt(rotation, overrides, at + 3 * H)).toMatchObject({ user_id: "a", override: false });
  });
  it("lists upcoming shifts", () => {
    expect(upcomingShifts(rotation, 1_000 * H, 1_000 * H + 72 * H).map((s) => s.user_id)).toEqual(["a", "b", "c"]);
  });
});

describe("planStep", () => {
  const policy = {
    id: "p",
    name: "p",
    repeat: 1,
    steps: [
      { delay_min: 0, targets: [] },
      { delay_min: 10, targets: [] },
    ],
  };
  it("walks steps, repeats, then stops", () => {
    expect(planStep(policy, 0)).toEqual({ policyStep: 0, nextDelayMs: 10 * 60_000 });
    // after the last step the repeat goes back to step 0, whose delay of 0 is raised to 1 minute
    expect(planStep(policy, 1)).toEqual({ policyStep: 1, nextDelayMs: 60_000 });
    expect(planStep(policy, 2)).toEqual({ policyStep: 0, nextDelayMs: 10 * 60_000 });
    expect(planStep(policy, 3)).toEqual({ policyStep: 1, nextDelayMs: null });
  });
});
