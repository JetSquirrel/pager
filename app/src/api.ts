// Typed client for the pager Worker (cloud/src/index.ts).

export type Severity = "critical" | "error" | "warning" | "info";
export type Status = "triggered" | "acknowledged" | "resolved";

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "responder";
  can_notify_customers?: number;
}

export interface Incident {
  id: string;
  number: number;
  service_id: string;
  service_name?: string;
  title: string;
  severity: Severity;
  status: Status;
  source: string;
  details: Record<string, unknown>;
  alert_count: number;
  escalation_step: number;
  assignees: string[];
  created_at: number;
  updated_at: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  resolved_at: number | null;
  snoozed_until: number | null;
}

export interface IncidentEvent {
  id: number;
  at: number;
  kind: string;
  actor: string | null;
  actor_name: string | null;
  message: string;
}

export interface IncidentDetail {
  incident: Incident;
  events: IncidentEvent[];
  escalation: { step: number; nextAt: number | null; stopped: boolean };
  assignees: { id: string; name: string; email: string }[];
}

export interface Shift {
  user_id: string;
  starts_at: number;
  ends_at: number;
  override: boolean;
  user: { id: string; name: string; email: string } | null;
}

export interface OnCall {
  at: number;
  schedules: { id: string; name: string; current: Shift | null; next: Shift[] }[];
}

export interface ContactMethod {
  id: string;
  type: "tuya" | "ntfy" | "webhook" | "slack" | "webpush";
  label: string;
  config: Record<string, unknown>;
  min_severity: Severity;
  enabled: boolean;
  delay_min: number;
  last_error: string | null;
}

export interface Service {
  id: string;
  name: string;
  escalation_policy_id: string;
  open_incidents: number;
  integration_key?: string;
  endpoints?: { events: string; alertmanager: string; grafana: string };
}

export interface PolicyTarget {
  type: "user" | "schedule";
  id: string;
}

export interface Policy {
  id: string;
  name: string;
  repeat: number;
  steps: { delay_min: number; targets: PolicyTarget[] }[];
}

export interface ScheduleDef {
  id: string;
  name: string;
  rotation: { start: number; shift_hours: number; users: string[] };
}

export type CustomerChannel = "webhook" | "slack" | "ntfy";

export interface Customer {
  id: string;
  name: string;
  type: CustomerChannel;
  config: Record<string, unknown>;
  service_id: string | null;
  enabled: boolean;
}

export interface TuyaDevice {
  id: string;
  name: string;
  category: string;
  online: boolean;
  suggested_preset: string | null;
}

export interface HardwarePager {
  id: string;
  name: string;
  last_seen_at: number | null;
  firmware: string | null;
}

export interface CustomerNotice {
  id: string;
  message: string;
  audience: number;
  dry_run: number;
  created_at: number;
}

export interface UsageToday {
  requests: number;
  rowsRead: number;
  rowsWritten: number;
  free: { requests: number; rowsRead: number; rowsWritten: number };
  pressure: "ok" | "lean" | "shed";
}

export interface Session {
  server: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  constructor(public session: Session) {}

  private url(path: string) {
    return this.session.server.replace(/\/+$/, "") + "/v1" + path;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: {
        Authorization: `Bearer ${this.session.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`);
    return json as T;
  }

  me = () => this.call<{ user: User }>("GET", "/me");
  incidents = (status: "open" | "resolved" | "all" = "open", limit = 100) =>
    this.call<{ incidents: Incident[] }>("GET", `/incidents?status=${status}&limit=${limit}`);
  incident = (id: string) => this.call<IncidentDetail>("GET", `/incidents/${id}`);
  acknowledge = (id: string) => this.call<{ incident: Incident }>("POST", `/incidents/${id}/acknowledge`);
  resolve = (id: string) => this.call<{ incident: Incident }>("POST", `/incidents/${id}/resolve`);
  snooze = (id: string, minutes: number) => this.call<{ incident: Incident }>("POST", `/incidents/${id}/snooze`, { minutes });
  reassign = (id: string, userId: string) => this.call<{ incident: Incident }>("POST", `/incidents/${id}/reassign`, { user_id: userId });
  escalate = (id: string) => this.call<{ incident: Incident }>("POST", `/incidents/${id}/escalate`);
  bulk = (action: "acknowledge" | "resolve", ids: string[]) => this.call<{ incidents: Incident[] }>("POST", "/incidents/bulk", { action, ids });
  openIncident = (i: { service_id: string; title: string; severity: Severity }) => this.call<{ incident: Incident }>("POST", "/incidents", i);
  repage = (id: string) => this.call<{ ok: true }>("POST", `/incidents/${id}/repage`);
  note = (id: string, message: string) => this.call<{ ok: true }>("POST", `/incidents/${id}/notes`, { message });
  oncall = () => this.call<OnCall>("GET", "/oncall");
  takeShift = (scheduleId: string, startsAt: number, endsAt: number) =>
    this.call<{ id: string }>("POST", `/schedules/${scheduleId}/overrides`, { starts_at: startsAt, ends_at: endsAt });
  contactMethods = () => this.call<{ contact_methods: ContactMethod[]; tuya_presets: string[] }>("GET", "/contact-methods");
  addContactMethod = (cm: { type: string; label: string; config: Record<string, unknown>; min_severity?: Severity }) =>
    this.call<{ id: string }>("POST", "/contact-methods", cm);
  updateContactMethod = (id: string, patch: { enabled?: boolean; min_severity?: Severity; label?: string; delay_min?: number }) =>
    this.call<{ ok: true }>("PATCH", `/contact-methods/${id}`, patch);
  deleteContactMethod = (id: string) => this.call<void>("DELETE", `/contact-methods/${id}`);
  testContactMethod = (id: string) => this.call<{ ok: true }>("POST", `/contact-methods/${id}/test`);

  tuyaDevices = () => this.call<{ configured: boolean; devices: TuyaDevice[] }>("GET", "/tuya/devices");
  hardwarePagers = () => this.call<{ devices: HardwarePager[] }>("GET", "/devices");
  addHardwarePager = (name: string) => this.call<{ id: string; token: string }>("POST", "/devices", { name });
  deleteHardwarePager = (id: string) => this.call<void>("DELETE", `/devices/${id}`);

  pushKey = () => this.call<{ publicKey: string }>("GET", "/push/vapid");

  customerNotices = (id: string) => this.call<{ audience: number; live: boolean; allowed: boolean; notices: CustomerNotice[] }>("GET", `/incidents/${id}/customer-notices`);
  sendCustomerNotice = (id: string, message: string) => this.call<{ id: string; audience: number; dry_run: boolean }>("POST", `/incidents/${id}/customer-notices`, { message });

  // ---- admin
  usage = () => this.call<UsageToday>("GET", "/usage");
  users = () => this.call<{ users: User[] }>("GET", "/users");
  addUser = (u: { email: string; name: string; role: "admin" | "responder" }) =>
    this.call<{ user_id: string; token: string }>("POST", "/users", u);
  updateUser = (id: string, patch: { role?: "admin" | "responder"; can_notify_customers?: boolean }) => this.call<{ ok: true }>("PATCH", `/users/${id}`, patch);
  customers = () => this.call<{ customers: Customer[]; live: boolean }>("GET", "/customers");
  addCustomer = (c: { name: string; type: CustomerChannel; config: Record<string, unknown>; service_id?: string | null }) => this.call<{ id: string }>("POST", "/customers", c);
  deleteCustomer = (id: string) => this.call<void>("DELETE", `/customers/${id}`);
  services = () => this.call<{ services: Service[] }>("GET", "/services");
  addService = (s: { name: string; escalation_policy_id: string }) =>
    this.call<{ id: string; integration_key: string }>("POST", "/services", s);
  policies = () => this.call<{ policies: Policy[] }>("GET", "/escalation-policies");
  addPolicy = (p: Omit<Policy, "id">) => this.call<{ id: string }>("POST", "/escalation-policies", p);
  schedules = () => this.call<{ schedules: ScheduleDef[] }>("GET", "/schedules");
  addSchedule = (s: { name: string; rotation: { shift_hours: number; users: string[]; start?: number } }) =>
    this.call<{ id: string }>("POST", "/schedules", s);

  streamUrl() {
    return this.url("/stream").replace(/^http/, "ws") + `?token=${encodeURIComponent(this.session.token)}`;
  }
}
