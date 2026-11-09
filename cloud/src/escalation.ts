// Escalation: one row per incident in `escalations`, walked by the Durable Object's single alarm.
import { addEvent, broadcast, getIncident, notifyUsers } from "./incidents";
import { onCallAt } from "./oncall";
import type { EscalationPolicy, EscalationTarget, Env, Override, Rotation } from "./types";
import { now, parseJson } from "./util";

const MINUTE = 60_000;
const RETRY_FAILED_STEP_MS = 30_000;

/** Turns escalation targets into user ids: users as they are, schedules into whoever is on call at `at`. */
export async function resolveTargets(env: Env, targets: EscalationTarget[], at = now()): Promise<string[]> {
  const users = new Set<string>();
  for (const t of targets) {
    if (t.type === "user") {
      users.add(t.id);
      continue;
    }
    const s = await env.DB.prepare(`SELECT rotation FROM schedules WHERE id = ?`).bind(t.id).first<{ rotation: string }>();
    if (!s) continue;
    const { results } = await env.DB.prepare(
      `SELECT user_id, starts_at, ends_at FROM schedule_overrides WHERE schedule_id = ? AND starts_at <= ? AND ends_at > ?`,
    )
      .bind(t.id, at, at)
      .all<Override>();
    const shift = onCallAt(parseJson<Rotation>(s.rotation, { start: 0, shift_hours: 0, users: [] }), results, at);
    if (shift) users.add(shift.user_id);
  }
  return [...users];
}

export async function loadPolicyForIncident(env: Env, incidentId: string): Promise<EscalationPolicy | null> {
  const r = await env.DB.prepare(
    `SELECT p.id, p.name, p.steps, p.repeat FROM incidents i
       JOIN services s ON s.id = i.service_id
       JOIN escalation_policies p ON p.id = s.escalation_policy_id
      WHERE i.id = ?`,
  )
    .bind(incidentId)
    .first<{ id: string; name: string; steps: string; repeat: number }>();
  return r ? { ...r, steps: parseJson(r.steps, []) } : null;
}

/** Where escalation stands after `step` (counted across repeats): the policy step it maps to and when the next one fires. */
export function planStep(policy: EscalationPolicy, step: number): { policyStep: number; nextDelayMs: number | null } {
  const n = policy.steps.length;
  const total = n * (Math.max(0, policy.repeat) + 1);
  const policyStep = step % n;
  if (step + 1 >= total) return { policyStep, nextDelayMs: null };
  const next = policy.steps[(step + 1) % n];
  return { policyStep, nextDelayMs: Math.max(1, next.delay_min) * MINUTE };
}

/** Opens the escalation and pages step 0, in the same turn that created the incident. */
export async function startEscalation(env: Env, incidentId: string): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO escalations (incident_id, step, next_at) VALUES (?, -1, ?)`).bind(incidentId, now()).run();
  await advance(env, incidentId);
}

export async function stopEscalation(env: Env, incidentId: string): Promise<void> {
  await env.DB.prepare(`UPDATE escalations SET stopped = 1, next_at = NULL WHERE incident_id = ?`).bind(incidentId).run();
}

/** Pages the current step again (the "page again" button) and restarts its timer. */
export async function repage(env: Env, incidentId: string): Promise<void> {
  await env.DB.prepare(`UPDATE escalations SET step = step - 1, stopped = 0 WHERE incident_id = ?`).bind(incidentId).run();
  await advance(env, incidentId);
}

export async function escalationStatus(env: Env, incidentId: string): Promise<{ step: number; nextAt: number | null; stopped: boolean }> {
  const r = await env.DB.prepare(`SELECT step, next_at, stopped FROM escalations WHERE incident_id = ?`)
    .bind(incidentId)
    .first<{ step: number; next_at: number | null; stopped: number }>();
  return { step: r?.step ?? -1, nextAt: r?.next_at ?? null, stopped: !!r?.stopped };
}

/** Runs the steps that have come due. A step that throws is tried again shortly, without holding up the others. */
export async function dueEscalations(env: Env, at: number): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT incident_id FROM escalations WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT 50`)
    .bind(at)
    .all<{ incident_id: string }>();
  for (const { incident_id } of results) {
    try {
      await advance(env, incident_id);
    } catch (e) {
      console.error("escalation failed", incident_id, e);
      await env.DB.prepare(`UPDATE escalations SET next_at = ? WHERE incident_id = ?`).bind(at + RETRY_FAILED_STEP_MS, incident_id).run();
    }
  }
}

async function advance(env: Env, incidentId: string): Promise<void> {
  const esc = await env.DB.prepare(`SELECT step, stopped FROM escalations WHERE incident_id = ?`)
    .bind(incidentId)
    .first<{ step: number; stopped: number }>();
  if (!esc || esc.stopped) return;

  const incident = await getIncident(env, incidentId);
  if (!incident || incident.status !== "triggered") {
    await stopEscalation(env, incidentId);
    return;
  }
  const policy = await loadPolicyForIncident(env, incidentId);
  if (!policy || policy.steps.length === 0) {
    await env.DB.batch([
      addEvent(env, incidentId, "escalation_failed", { message: "Service has no escalation steps" }),
      env.DB.prepare(`UPDATE escalations SET next_at = NULL WHERE incident_id = ?`).bind(incidentId),
    ]);
    return;
  }

  const step = esc.step + 1;
  const { policyStep, nextDelayMs } = planStep(policy, step);
  const users = await resolveTargets(env, policy.steps[policyStep].targets);
  const assignees = [...new Set([...incident.assignees, ...users])];
  const t = now();

  await env.DB.batch([
    env.DB.prepare(`UPDATE incidents SET escalation_step = ?, assignees = ?, updated_at = ? WHERE id = ?`).bind(step, JSON.stringify(assignees), t, incidentId),
    env.DB.prepare(`UPDATE escalations SET step = ?, next_at = ? WHERE incident_id = ?`).bind(step, nextDelayMs == null ? null : t + nextDelayMs, incidentId),
    addEvent(env, incidentId, step === 0 ? "notified" : "escalated", {
      message:
        users.length === 0
          ? `Step ${policyStep + 1}: nobody to page (empty schedule?)`
          : `Step ${policyStep + 1}${step >= policy.steps.length ? ` (repeat ${Math.floor(step / policy.steps.length)})` : ""}`,
      data: { step, policy_step: policyStep, users },
      at: t,
    }),
  ]);

  const updated = { ...incident, escalation_step: step, assignees, updated_at: t };
  await notifyUsers(env, updated, users, "trigger");
  env.wake();
  if (step > 0) await broadcast(env, "incident.updated", updated);
}
