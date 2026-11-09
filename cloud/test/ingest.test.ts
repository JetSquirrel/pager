import { describe, expect, it } from "vitest";
import { parseAlertmanager, parseGeneric } from "../src/ingest";
import { normalizeSeverity } from "../src/util";

describe("parseGeneric", () => {
  it("reads PagerDuty Events v2 payloads", () => {
    const [ev] = parseGeneric({
      routing_key: "x",
      event_action: "trigger",
      dedup_key: "disk-db1",
      payload: { summary: "Disk 95% on db1", severity: "warning", source: "db1", custom_details: { free: "5%" } },
    });
    expect(ev).toEqual({
      action: "trigger",
      dedup_key: "disk-db1",
      title: "Disk 95% on db1",
      severity: "warning",
      source: "db1",
      details: { free: "5%" },
    });
  });
  it("accepts the flat form and makes a dedup key", () => {
    const [ev] = parseGeneric({ title: "API down", severity: "p1" });
    expect(ev.severity).toBe("critical");
    expect(ev.dedup_key).toMatch(/[0-9a-f-]{36}/);
  });
  it("needs a dedup key to resolve", () => {
    expect(() => parseGeneric({ event_action: "resolve" })).toThrow(/dedup_key/);
  });
  it("rejects unknown actions", () => {
    expect(() => parseGeneric({ event_action: "explode", title: "x" })).toThrow(/event_action/);
  });
});

describe("parseAlertmanager", () => {
  const payload = {
    version: "4",
    status: "firing",
    receiver: "pager",
    commonLabels: { severity: "critical", job: "api" },
    externalURL: "http://am:9093",
    alerts: [
      {
        status: "firing",
        labels: { alertname: "HighErrorRate", instance: "api-1" },
        annotations: { summary: "5xx above 5% on api-1" },
        fingerprint: "abc123",
        startsAt: "2026-11-07T00:00:00Z",
      },
      { status: "resolved", labels: { alertname: "HighLatency", instance: "api-2", severity: "warning" }, annotations: {} },
    ],
  };
  it("maps each alert", () => {
    const [a, b] = parseAlertmanager(payload);
    expect(a).toMatchObject({ action: "trigger", dedup_key: "am:abc123", title: "5xx above 5% on api-1", severity: "critical", source: "api-1" });
    expect(b).toMatchObject({ action: "resolve", title: "HighLatency on api-2", severity: "warning" });
    expect(b.dedup_key).toBe("am:alertname=HighLatency,instance=api-2,job=api,severity=warning");
  });
  it("rejects other payloads", () => {
    expect(() => parseAlertmanager({ hello: 1 })).toThrow(/alerts/);
  });
});

describe("normalizeSeverity", () => {
  it("maps common vocabularies", () => {
    expect(normalizeSeverity("CRITICAL")).toBe("critical");
    expect(normalizeSeverity("sev2")).toBe("error");
    expect(normalizeSeverity("warn")).toBe("warning");
    expect(normalizeSeverity("whatever", "info")).toBe("info");
  });
});
