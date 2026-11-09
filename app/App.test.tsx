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
  expect(app.shows("id:triggered-count >> 1")).toBe(true);
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
  await app.waitFor("Resolve");
  expect(app.shows("Acknowledged")).toBe(true);
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
  await app.waitFor("id:paged >> Alice");
  expect(app.shows("Step 1")).toBe(true);
  await app.press("Acknowledge");
  await app.waitFor("id:escalation >> Stopped");
  await app.waitFor("Acknowledged");
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
  await app.press("Rotations");
  await app.press("New rotation");
  await app.waitFor("Create rotation");

  await app.type("id:schedule-name", "Primary");
  await app.press("id:rotation-members >> Bob");
  await app.press("id:rotation-members >> Alice");
  await app.press("id:rotation-shift >> Daily");
  await app.press("Create rotation");
  await app.waitFor("Bob → Alice");
  expect(posted[0]).toEqual({ name: "Primary", rotation: { shift_hours: 24, users: ["usr_2", "usr_1"] } });

  await app.press("Policies");
  await app.press("New policy");
  await app.type("id:policy-name", "Default");
  await app.press("id:policy-first >> Primary");
  await app.press("Create policy");
  await app.waitFor("At once: on call in Primary");
  expect(posted[1]).toEqual({ name: "Default", repeat: 2, steps: [{ delay_min: 0, targets: [{ type: "schedule", id: "sch_1" }] }] });

  await app.press("Services");
  await app.press("New service");
  await app.type("id:service-name", "Checkout");
  await app.press("id:service-policy >> Default");
  await app.press("Create service");
  await app.press("Copy URL");
  await app.press("Alertmanager");
  expect(app.clipboard()).toBe(`${SERVER}/v1/integrations/key_1/alertmanager`);
});

test("turns on paging for this browser from Settings", async () => {
  const added: unknown[] = [];
  const sub = { endpoint: "https://push.test/abc", keys: { p256dh: "p", auth: "a" }, label: "Android Chrome" };
  let subscribed = false;
  const app = await open("App.tsx", {
    network: api({
      [`GET ${SERVER}/v1/push/vapid`]: { body: { publicKey: "key" } },
      [`POST ${SERVER}/v1/contact-methods`]: (req: { body: string }) => {
        added.push(JSON.parse(req.body));
        subscribed = true;
        return { status: 201, body: { id: "cm_1" } };
      },
      [`GET ${SERVER}/v1/contact-methods`]: () => ({
        body: {
          contact_methods: subscribed
            ? [{ id: "cm_1", type: "webpush", label: "Android Chrome", config: { endpoint: sub.endpoint }, min_severity: "info", enabled: true }]
            : [],
          tuya_presets: ["siren"],
        },
      }),
    }),
    storage: { "pager.session": JSON.stringify({ server: SERVER, token: "tok" }) },
    host: {
      handlers: {
        pushState: () => ({ supported: true, ios: false, standalone: false, endpoint: subscribed ? sub.endpoint : null }),
        pushEnable: sub,
      },
    },
  });
  await app.waitFor("Disk 95% on db1");
  await app.press("Settings");
  await app.waitFor("Page me on this device");
  await app.press("Page me on this device");
  await app.waitFor("Android Chrome");
  expect(added).toEqual([{ type: "webpush", label: "Android Chrome", config: { endpoint: sub.endpoint, keys: sub.keys } }]);
  expect(app.shows("Page me on this device")).toBe(false);
});

test("a wide window shows the list and the incident side by side", async () => {
  const detail = {
    body: {
      incident: incident(),
      events: [{ id: 1, at: Date.now() - 60_000, kind: "triggered", actor: null, actor_name: null, message: "Disk 95% on db1" }],
      escalation: { step: 0, nextAt: Date.now() + 9 * 60_000, stopped: false },
      assignees: [{ id: "usr_1", name: "Alice", email: "alice@example.com" }],
    },
  };
  for (const colorScheme of ["light", "dark"] as const) {
    const app = await open("App.tsx", {
      width: 1280,
      height: 800,
      platform: "web",
      colorScheme,
      storage: signedIn,
      network: api({ [`GET ${SERVER}/v1/incidents/inc_1`]: detail }),
    });
    // The first open incident is shown without a press, and the sidebar names the sections.
    await app.waitFor("id:paged >> Alice");
    expect(app.shows("id:triggered-count >> 1")).toBe(true);
    expect(app.shows("On call")).toBe(true);
  }
});

const detailOf = (over: Record<string, unknown> = {}) => ({
  body: {
    incident: incident(over),
    events: [{ id: 1, at: Date.now() - 60_000, kind: "triggered", actor: null, actor_name: null, message: "Disk 95% on db1" }],
    escalation: { step: 0, nextAt: Date.now() + 9 * 60_000, stopped: false },
    assignees: [{ id: "usr_1", name: "Alice", email: "alice@example.com" }],
  },
});

test("filters to my incidents, and keeps history apart", async () => {
  const theirs = incident({ id: "inc_2", number: 8, title: "Queue backing up", assignees: ["usr_2"] });
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/incidents?status=open&limit=100`]: { body: { incidents: [incident(), theirs] } },
      [`GET ${SERVER}/v1/incidents?status=resolved&limit=50`]: { body: { incidents: [incident({ id: "inc_3", number: 3, title: "Old outage", status: "resolved" })] } },
    }),
  });
  await app.waitFor("Disk 95% on db1");
  expect(app.shows("Queue backing up")).toBe(false);
  await app.press("id:incident-filter >> All");
  await app.waitFor("Queue backing up");
  await app.press("id:incident-filter >> History");
  await app.waitFor("Old outage");
  expect(app.shows("Disk 95% on db1")).toBe(false);
});

test("acknowledges everything that is paging me at once", async () => {
  const two = incident({ id: "inc_2", number: 8, title: "Queue backing up" });
  const posts: any[] = [];
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/incidents?status=open&limit=100`]: { body: { incidents: [incident(), two] } },
      [`POST ${SERVER}/v1/incidents/bulk`]: (req: { body: string }) => {
        posts.push(JSON.parse(req.body));
        return { body: { incidents: [incident({ status: "acknowledged" }), { ...two, status: "acknowledged" }] } };
      },
    }),
  });
  await app.press("Acknowledge all");
  await app.waitFor("All quiet");
  expect(posts).toEqual([{ action: "acknowledge", ids: ["inc_1", "inc_2"] }]);
});

test("snoozes and reassigns from the incident", async () => {
  const posts: Record<string, unknown>[] = [];
  let snoozed: number | null = null;
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/incidents/inc_1`]: () => detailOf({ snoozed_until: snoozed, status: snoozed ? "acknowledged" : "triggered" }),
      [`GET ${SERVER}/v1/users`]: { body: { users: [user, { id: "usr_2", email: "bob@example.com", name: "Bob", role: "responder" }] } },
      [`POST ${SERVER}/v1/incidents/inc_1/snooze`]: (req: { body: string }) => {
        posts.push(JSON.parse(req.body));
        snoozed = Date.now() + 3_600_000;
        return { body: { incident: incident({ status: "acknowledged", snoozed_until: snoozed }) } };
      },
      [`POST ${SERVER}/v1/incidents/inc_1/reassign`]: (req: { body: string }) => {
        posts.push(JSON.parse(req.body));
        snoozed = null;
        return { body: { incident: incident({ assignees: ["usr_2"] }) } };
      },
    }),
  });
  await app.press("Disk 95% on db1");
  await app.waitFor("id:paged >> Alice");
  await app.press("id:incident-more");
  await app.press("Snooze 1 hour");
  await app.waitFor("id:snoozed >> Pages again in 1h 0m");
  await app.press("id:incident-more");
  await app.press("Reassign");
  await app.press("id:reassign-people >> Bob");
  await app.waitFor("id:escalation >> Next step in 9m");
  expect(posts).toEqual([{ minutes: 60 }, { user_id: "usr_2" }]);
});

test("opens an incident by hand", async () => {
  const posts: unknown[] = [];
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/services`]: { body: { services: [{ id: "svc_1", name: "API", escalation_policy_id: "pol_1", open_incidents: 0 }] } },
      [`POST ${SERVER}/v1/incidents`]: (req: { body: string }) => {
        posts.push(JSON.parse(req.body));
        return { status: 201, body: { incident: incident({ id: "inc_9", number: 9, title: "Checkout down" }) } };
      },
      [`GET ${SERVER}/v1/incidents/inc_9`]: detailOf({ id: "inc_9", number: 9, title: "Checkout down" }),
    }),
  });
  await app.waitFor("Disk 95% on db1");
  await app.press("id:new-incident");
  await app.type("id:incident-title", "Checkout down");
  await app.press("id:incident-service >> API");
  await app.press("Page the on-call");
  await app.waitFor("id:paged >> Alice");
  expect(posts).toEqual([{ service_id: "svc_1", title: "Checkout down", severity: "critical" }]);
});

test("shows my own shifts first", async () => {
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/oncall`]: {
        body: {
          schedules: [
            { id: "sch_1", name: "Primary", current: { user_id: "usr_1", user, starts_at: Date.now() - 1000, ends_at: Date.now() + 7_200_000, override: false }, next: [] },
          ],
        },
      },
    }),
  });
  await app.press("On call");
  await app.waitFor("id:on-call-now >> Primary");
});

test("runs a customer notice as a dry run, with confirmation", async () => {
  const posts: unknown[] = [];
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/incidents/inc_1`]: detailOf(),
      [`GET ${SERVER}/v1/incidents/inc_1/customer-notices`]: { body: { audience: 3, live: false, allowed: true, notices: [] } },
      [`POST ${SERVER}/v1/incidents/inc_1/customer-notices`]: (req: { body: string }) => {
        posts.push(JSON.parse(req.body));
        return { status: 201, body: { id: "ntc_1", audience: 3, dry_run: true } };
      },
    }),
  });
  await app.press("Disk 95% on db1");
  await app.waitFor("id:paged >> Alice");
  await app.press("id:incident-more");
  await app.press("Notify customers");
  await app.waitFor("Dry run for 3 customers");
  await app.type("id:notice-message", "We are looking into it.");
  app.onDialog(() => "Dry run");
  await app.press("Dry run for 3 customers");
  await app.waitFor("Dry run: 3 customers would be told");
  expect(app.dialogs()[0].title).toBe("Run a dry run?");
  expect(posts).toEqual([{ message: "We are looking into it." }]);
});

test("hides customer notices from someone without the permission", async () => {
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/me`]: { body: { user: { ...user, role: "responder", can_notify_customers: 0 } } },
      [`GET ${SERVER}/v1/incidents/inc_1`]: detailOf(),
    }),
  });
  await app.press("Disk 95% on db1");
  await app.waitFor("id:paged >> Alice");
  await app.press("id:incident-more");
  await app.waitFor("Reassign");
  expect(app.shows("Notify customers")).toBe(false);
});

test("the alarm check says what would stop a page", async () => {
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/contact-methods`]: {
        body: {
          contact_methods: [{ id: "cm_1", type: "webhook", label: "Ops hook", config: { url: "https://x.test" }, min_severity: "info", enabled: true, delay_min: 0, last_error: "HTTP 500" }],
          tuya_presets: ["siren"],
        },
      },
    }),
    host: { handlers: { pushState: () => ({ supported: true, ios: false, standalone: false, endpoint: null, permission: "denied" }) } },
  });
  await app.press("Settings");
  await app.waitFor("id:alarm-reach >> Critical pages ring 1 method");
  await app.waitFor("id:alarm-failing >> Ops hook: last delivery failed");
  await app.waitFor("id:alarm-browser >> This browser blocks alarms: allow notifications for this site");
});

test("takes over a shift from the menu", async () => {
  const posts: unknown[] = [];
  const app = await open("App.tsx", {
    storage: signedIn,
    network: api({
      [`GET ${SERVER}/v1/oncall`]: {
        body: { schedules: [{ id: "sch_1", name: "Primary", current: { user_id: "usr_2", user: { id: "usr_2", name: "Bob" }, starts_at: Date.now() - 1000, ends_at: Date.now() + 7_200_000, override: false }, next: [] }] },
      },
      [`POST ${SERVER}/v1/schedules/sch_1/overrides`]: (req: { body: string }) => {
        posts.push(JSON.parse(req.body));
        return { status: 201, body: {} };
      },
    }),
  });
  await app.press("On call");
  await app.waitFor("Bob");
  await app.press("Take over");
  await app.press("For 1 hour");
  await app.waitFor("You are on call for Primary");
  expect(posts.length).toBe(1);
});
