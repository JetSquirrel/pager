import { describe, expect, it } from "vitest";
import { deviceStateFor } from "../src/devices";

const inc = (o: Record<string, unknown>) =>
  ({ id: "i", number: 1, title: "t", severity: "warning", status: "triggered", assignees: ["u1"], created_at: 0, service_name: "API", ...o }) as any;

describe("deviceStateFor", () => {
  it("rings for the user's unacknowledged incidents, most severe first", () => {
    const s = deviceStateFor("u1", [
      inc({ id: "a", number: 1, severity: "warning", created_at: 3 }),
      inc({ id: "b", number: 2, severity: "critical", created_at: 1 }),
      inc({ id: "c", number: 3, status: "acknowledged" }),
      inc({ id: "d", number: 4, assignees: ["u2"], severity: "critical", created_at: 9 }),
    ], 42, 1000);
    expect(s).toEqual({
      v: 42,
      alert: 1,
      count: 2,
      acked: 1,
      top: { id: "b", number: 2, title: "t", severity: "critical", service: "API" },
      now: 1000,
    });
  });
  it("is quiet when nothing pages the user", () => {
    expect(deviceStateFor("u1", [inc({ assignees: ["u2"] })], 1, 0)).toMatchObject({ alert: 0, count: 0, top: null });
  });
});
