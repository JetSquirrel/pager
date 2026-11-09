import { describe, expect, it } from "vitest";
import { actionToken, verifyActionToken } from "../src/actions";

const env = { ACTION_SECRET: "s3cret", PUBLIC_URL: "https://p" } as any;

describe("action tokens", () => {
  it("round-trips", async () => {
    const t = await actionToken(env, "inc_1", "usr_1", "ack");
    expect(await verifyActionToken(env, t)).toEqual({ incidentId: "inc_1", userId: "usr_1", kind: "ack" });
  });
  it("rejects tampering, other secrets and expiry", async () => {
    const t = await actionToken(env, "inc_1", "usr_1", "ack");
    expect(await verifyActionToken(env, t.replace(".ack.", ".resolve."))).toBeNull();
    expect(await verifyActionToken({ ...env, ACTION_SECRET: "other" }, t)).toBeNull();
    expect(await verifyActionToken(env, t, Date.now() + 25 * 3_600_000)).toBeNull();
  });
});
