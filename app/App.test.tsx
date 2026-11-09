// Headless UI tests: `nsh test .` — the Worker's API is stubbed.
import { expect, open, test } from "nsh/test";

const SERVER = "https://pager.test";
const user = { id: "usr_1", email: "alice@example.com", name: "Alice", role: "admin" };

const incident = (over: Record<string, unknown> = {}) => ({
  id: "inc_1",
  number: 7,
  service_id: "svc_1",
  service_name: "API",
  dedup_key: "k",
  title: "Disk 95% on db1",
  severity: "critical",
  status: "triggered",
  source: "db1",
  details: {},
  alert_count: 2,
  escalation_step: 0,
  assignees: ["usr_1"],
  created_at: Date.now() - 60_000,
  updated_at: Date.now() - 60_000,
  acknowledged_at: null,
  acknowledged_by: null,
  resolved_at: null,
  ...over,
});

const api = (extra: Record<string, unknown> = {}) => ({
  [`GET ${SERVER}/v1/me`]: { body: { user } },
  [`GET ${SERVER}/v1/incidents?status=open&limit=100`]: { body: { incidents: [incident()] } },
  [`POST ${SERVER}/v1/incidents/inc_1/acknowledge`]: {
    body: { incident: incident({ status: "acknowledged", acknowledged_at: Date.now(), acknowledged_by: "usr_1" }) },
  },
  // The live socket has no stub: the app falls back to polling, which the tests don't wait for.
  ...extra,
});

test("signs in and shows the open incidents", async () => {
  const app = await open("App.tsx", { network: api() });
  // The server field starts with "https://".
  await app.type("id:server", "pager.test");
  await app.type("id:token", "tok");
  await app.press("Sign in");
  await app.waitFor("Disk 95% on db1");
  expect(app.shows("2 alerts")).toBe(true);
  expect(app.shows("Incidents (1)")).toBe(true);
  // The session is kept for the next start.
  expect(JSON.parse(app.storage()["pager.session"])).toEqual({ server: SERVER, token: "tok" });
});

test("restores the session and acknowledges from the list", async () => {
  const app = await open("App.tsx", {
    network: api(),
    storage: { "pager.session": JSON.stringify({ server: SERVER, token: "tok" }) },
  });
  await app.waitFor("Disk 95% on db1");
  await app.press("Acknowledge");
  await app.waitFor("ACKNOWLEDGED (1)");
  expect(app.shows("All quiet")).toBe(true);
  const ack = app.requests().find((r) => r.method === "POST");
  expect(ack?.url).toBe(`${SERVER}/v1/incidents/inc_1/acknowledge`);
  expect(ack?.headers["authorization"] ?? ack?.headers["Authorization"]).toBe("Bearer tok");
});

test("shows the sign-in error from the server", async () => {
  const app = await open("App.tsx", {
    network: { [`GET ${SERVER}/v1/me`]: { status: 401, body: { error: "invalid token" } } },
  });
  await app.type("id:server", "pager.test");
  await app.type("id:token", "nope");
  await app.press("Sign in");
  await app.waitFor("invalid token");
});

const signedIn = { "pager.session": JSON.stringify({ server: SERVER, token: "tok" }) };

test("opens an incident: timeline, escalation, acknowledge", async () => {
  let status = "triggered";
  const detail = () => ({
    body: {
      incident: incident({ status }),
      events: [
        { id: 1, at: Date.now() - 60_000, kind: "triggered", actor: null, actor_name: null, message: "Disk 95% on db1" },
        { id: 2, at: Date.now() - 59_000, kind: "notified", actor: null, actor_name: null, message: "Step 1" },
        ...(status === "acknowledged"
          ? [{ id: 3, at: Date.now(), kind: "acknowledged", actor: "usr_1", actor_name: "Alice", message: "Acknowledged" }]
          : []),
      ],
      escalation: { step: 0, nextAt: status === "triggered" ? Date.now() + 9 * 60_000 : null, stopped: status !== "triggered" },
      assignees: [{ id: "usr_1", name: "Alice", email: "alice@example.com" }],
    },
  });
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/incidents/inc_1`]: detail,
      [`POST ${SERVER}/v1/incidents/inc_1/acknowledge`]: () => {
        status = "acknowledged";
        return { body: { incident: incident({ status }) } };
      },
    }),
  });
  await app.press("Disk 95% on db1");
  await app.waitFor("Paged: Alice");
  expect(app.shows("Step 1")).toBe(true);
  await app.press("Acknowledge");
  await app.waitFor("Escalation stopped");
  await app.waitFor("Acknowledged · Alice");
});

test("admin sets up a rotation, a policy and a service", async () => {
  const users = [user, { id: "usr_2", email: "bob@example.com", name: "Bob", role: "responder" }];
  const schedules: unknown[] = [];
  const policies: unknown[] = [];
  const services: unknown[] = [];
  const posted: Record<string, unknown>[] = [];
  const post = (list: unknown[], make: (b: any) => unknown) => (req: { body?: string | null }) => {
    const b = JSON.parse(req.body ?? "{}");
    posted.push(b);
    list.push(make(b));
    return { status: 201, body: { id: `id_${list.length}`, integration_key: "key_1" } };
  };
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/users`]: () => ({ body: { users } }),
      [`GET ${SERVER}/v1/schedules`]: () => ({ body: { schedules } }),
      [`GET ${SERVER}/v1/escalation-policies`]: () => ({ body: { policies } }),
      [`GET ${SERVER}/v1/services`]: () => ({ body: { services } }),
      [`POST ${SERVER}/v1/schedules`]: post(schedules, (b) => ({ id: "sch_1", ...b })),
      [`POST ${SERVER}/v1/escalation-policies`]: post(policies, (b) => ({ id: "pol_1", ...b })),
      [`POST ${SERVER}/v1/services`]: post(services, (b) => ({
        id: "svc_1",
        open_incidents: 0,
        ...b,
        endpoints: { events: `${SERVER}/v1/integrations/key_1/events`, alertmanager: `${SERVER}/v1/integrations/key_1/alertmanager`, grafana: `${SERVER}/v1/integrations/key_1/grafana` },
      })),
    }),
  });
  await app.press("Admin");
  await app.waitFor("Create rotation");

  await app.type("id:schedule-name", "Primary");
  await app.press("id:rotation-members >> Bob");
  await app.press("id:rotation-members >> Alice");
  await app.press("id:rotation-shift >> Daily");
  await app.press("Create rotation");
  await app.waitFor("Bob → Alice");
  expect(posted[0]).toEqual({ name: "Primary", rotation: { shift_hours: 24, users: ["usr_2", "usr_1"] } });

  await app.type("id:policy-name", "Default");
  await app.press("id:policy-first >> 🗓 Primary");
  await app.press("Create policy");
  await app.waitFor("At once: on call in Primary");
  expect(posted[1]).toEqual({ name: "Default", repeat: 2, steps: [{ delay_min: 0, targets: [{ type: "schedule", id: "sch_1" }] }] });

  await app.type("id:service-name", "Checkout");
  await app.press("id:service-policy >> Default");
  await app.press("Create service");
  await app.press("Copy Alertmanager URL");
  expect(app.clipboard()).toBe(`${SERVER}/v1/integrations/key_1/alertmanager`);
});
