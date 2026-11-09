import { DurableObject } from "cloudflare:workers";
import { addEvent, broadcast, getIncident, notifyUsers } from "./incidents";
import { onCallAt } from "./oncall";
import type { EscalationPolicy, EscalationTarget, Env, Override, Rotation } from "./types";
import { now, parseJson } from "./util";

const MINUTE = 60_000;

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

/**
 * One instance per incident (idFromName(incident id)). It pages step 0 when the incident opens and,
 * while the incident stays triggered, walks the escalation policy on Durable Object alarms.
 * Ack and resolve call stop(), which clears the alarm.
 */
export class Escalator extends DurableObject<Env> {
  async start(incidentId: string): Promise<void> {
    if (await this.ctx.storage.get("incidentId")) return; // already running
    await this.ctx.storage.put({ incidentId, step: -1 });
    await this.advance();
  }

  async stop(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put("stopped", true);
  }

  /** Re-pages the current step now (the "page again" button). */
  async repage(): Promise<void> {
    const step = (await this.ctx.storage.get<number>("step")) ?? 0;
    await this.ctx.storage.put("step", step - 1);
    await this.ctx.storage.delete("stopped");
    await this.advance();
  }

  async status(): Promise<{ step: number; nextAt: number | null; stopped: boolean }> {
    return {
      step: (await this.ctx.storage.get<number>("step")) ?? -1,
      nextAt: await this.ctx.storage.getAlarm(),
      stopped: !!(await this.ctx.storage.get("stopped")),
    };
  }

  async alarm(): Promise<void> {
    await this.advance();
  }

  private async advance(): Promise<void> {
    const incidentId = await this.ctx.storage.get<string>("incidentId");
    if (!incidentId || (await this.ctx.storage.get("stopped"))) return;
    const incident = await getIncident(this.env, incidentId);
    if (!incident || incident.status !== "triggered") {
      await this.ctx.storage.put("stopped", true);
      return;
    }
    const policy = await loadPolicyForIncident(this.env, incidentId);
    if (!policy || policy.steps.length === 0) {
      await addEvent(this.env, incidentId, "escalation_failed", { message: "Service has no escalation steps" }).run();
      return;
    }

    const step = ((await this.ctx.storage.get<number>("step")) ?? -1) + 1;
    const { policyStep, nextDelayMs } = planStep(policy, step);
    const users = await resolveTargets(this.env, policy.steps[policyStep].targets);
    const assignees = [...new Set([...incident.assignees, ...users])];
    const t = now();

    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE incidents SET escalation_step = ?, assignees = ?, updated_at = ? WHERE id = ?`).bind(
        step,
        JSON.stringify(assignees),
        t,
        incidentId,
      ),
      addEvent(this.env, incidentId, step === 0 ? "notified" : "escalated", {
        message:
          users.length === 0
            ? `Step ${policyStep + 1}: nobody to page (empty schedule?)`
            : `Step ${policyStep + 1}${step >= policy.steps.length ? ` (repeat ${Math.floor(step / policy.steps.length)})` : ""}`,
        data: { step, policy_step: policyStep, users },
        at: t,
      }),
    ]);
    await this.ctx.storage.put("step", step);
    if (nextDelayMs != null) await this.ctx.storage.setAlarm(t + nextDelayMs);

    const updated = { ...incident, escalation_step: step, assignees, updated_at: t };
    await notifyUsers(this.env, updated, users, "trigger");
    if (step > 0) await broadcast(this.env, "incident.updated", updated);
  }
}
