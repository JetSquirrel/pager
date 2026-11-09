import type { Escalator } from "./escalation";
import type { Hub } from "./hub";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ESCALATOR: DurableObjectNamespace<Escalator>;
  HUB: DurableObjectNamespace<Hub>;
  NOTIFY: Queue<NotifyMessage>;
  PUBLIC_URL: string;
  TUYA_ENDPOINT: string;
  BOOTSTRAP_TOKEN?: string;
  ACTION_SECRET?: string;
  TUYA_CLIENT_ID?: string;
  TUYA_CLIENT_SECRET?: string;
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
}

export type NotifyEvent = "trigger" | "acknowledge" | "resolve" | "test";

export interface NotifyMessage {
  incident_id: string;
  user_id: string;
  event: NotifyEvent;
  /** Restrict delivery to one contact method (used by "send test"). */
  contact_method_id?: string;
}

/** What an integration hands to the core after parsing its own payload format. */
export interface AlertEvent {
  action: "trigger" | "acknowledge" | "resolve";
  dedup_key: string;
  title: string;
  severity: Severity;
  source: string;
  details: Record<string, unknown>;
}
