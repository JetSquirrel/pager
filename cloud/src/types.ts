import type { Pressure, Usage } from "./budget";
import type { Db, KvTable } from "./db";
import type { Vapid } from "./notify/webpush";
import type { Pager } from "./pager";

/** What Cloudflare hands the Worker. */
export interface Bindings {
  PAGER: DurableObjectNamespace<Pager>;
  TUYA_ENDPOINT: string;
  PUBLIC_URL?: string;
  BOOTSTRAP_TOKEN?: string;
  ACTION_SECRET?: string;
  TUYA_CLIENT_ID?: string;
  TUYA_CLIENT_SECRET?: string;
}

/** What request code sees inside the Durable Object (src/pager.ts). */
export interface Env extends Omit<Bindings, "PUBLIC_URL"> {
  DB: Db;
  CACHE: KvTable;
  PUBLIC_URL: string;
  vapid(): Promise<Vapid>;
  /** Re-aims the alarm after anything that adds or moves future work. */
  wake(): void;
  publish(message: string): void;
  acceptClient(userId: string): Response;
  acceptDevice(userId: string, state: unknown): Response;
  version(): number;
  pressure(): Pressure;
  usageToday(): Usage;
}

export const SEVERITIES = ["info", "warning", "error", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type IncidentStatus = "triggered" | "acknowledged" | "resolved";

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "responder";
  timezone: string;
  created_at: number;
}

export interface Rotation {
  /** Epoch ms when users[0]'s first shift starts. */
  start: number;
  shift_hours: number;
  users: string[];
}

export interface Schedule {
  id: string;
  name: string;
  rotation: Rotation;
}

export interface Override {
  user_id: string;
  starts_at: number;
  ends_at: number;
}

export interface EscalationTarget {
  type: "user" | "schedule";
  id: string;
}

export interface EscalationStep {
  delay_min: number;
  targets: EscalationTarget[];
}

export interface EscalationPolicy {
  id: string;
  name: string;
  steps: EscalationStep[];
  repeat: number;
}

export interface Incident {
  id: string;
  number: number;
  service_id: string;
  service_name?: string;
  dedup_key: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
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
  resolved_by: string | null;
  snoozed_until: number | null;
}

/** "reassign" tells the people an incident was taken away from: it silences their devices like an acknowledgement. */
export type NotifyEvent = "trigger" | "acknowledge" | "resolve" | "reassign" | "test";

/** What an integration hands to the core after parsing its own payload format. */
export interface AlertEvent {
  action: "trigger" | "acknowledge" | "resolve";
  dedup_key: string;
  title: string;
  severity: Severity;
  source: string;
  details: Record<string, unknown>;
}
