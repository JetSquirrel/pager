import { effect, resource, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { IncidentDetail as Detail, IncidentEvent, User } from "../api";
import { api, incidents, me, upsert } from "../store";
import { toast } from "../toast";
import { CustomerNotice } from "./CustomerNotice";
import { ActionMenu, Badge, Btn, Chips, clock, Dot, Fact, Failed, field, FormSheet, isDesktop, Loading, MenuBtn, Meta, Section, SEV_LABEL, StatusBadge, Surface, timeAgo, type Tone, until, Value } from "../ui";

const KIND_LABEL: Record<string, string> = {
  triggered: "Triggered",
  alert_repeated: "Alert fired again",
  notified: "Paged",
  escalated: "Escalated",
  notify_sent: "Delivered",
  notify_failed: "Delivery failed",
  notify_gave_up: "Gave up delivering",
  acknowledged: "Acknowledged",
  snoozed: "Snoozed",
  unsnoozed: "Snooze ended",
  reassigned: "Reassigned",
  resolved: "Resolved",
  note: "Note",
  customer_notice: "Customers notified",
  customer_notice_dry_run: "Customer notice dry run",
  customer_notice_failed: "Customer notice failed",
  escalation_failed: "Escalation failed",
};

const KIND_TONE: Record<string, Tone> = {
  triggered: "critical",
  escalated: "error",
  notify_failed: "critical",
  notify_gave_up: "critical",
  escalation_failed: "critical",
  customer_notice_failed: "critical",
  acknowledged: "warning",
  resolved: "ok",
};

function TimelineItem(props: { event: () => IncidentEvent; last: boolean }) {
  const e = () => props.event();
  const label = () => KIND_LABEL[e().kind] ?? e().kind;
  return (
    <View class="flex-row gap-3">
      {/* A fixed lane: the dots and the line between them share one center. */}
      <View class="w-2 items-center">
        <View class="h-1.5" />
        <Dot tone={KIND_TONE[e().kind] ?? "neutral"} />
        {!props.last && <View class="w-px flex-1 bg-border" />}
      </View>
      <View class={`flex-1 gap-0.5 ${props.last ? "" : "pb-4"}`}>
        <View class="flex-row items-baseline gap-2">
          <Text class="text-sm font-medium text-foreground">{label()}</Text>
          {e().actor_name && <Text class="text-sm text-muted-foreground">{e().actor_name}</Text>}
          <View class="flex-1" />
          <Meta>{clock(e().at)}</Meta>
        </View>
        {e().message && e().message !== label() && <Text class="text-sm text-foreground" selectable>{e().message}</Text>}
      </View>
    </View>
  );
}

export function IncidentDetail(props: { id: string }) {
  const detail = resource(async () => api().incident(props.id));
  const note = signal("");
  const busy = signal<string | null>(null);
  const reassigning = signal(false);
  const noticing = signal(false);
  const mayNotify = () => me()?.role === "admin" || !!me()?.can_notify_customers;
  const people = resource(() => reassigning() || null, async () => (await api().users()).users);

  // A live update reloads the timeline: at once for a change of status, at most once a minute for a repeating alert,
  // since a wide window keeps an incident open all day.
  let seen = 0;
  let status: string | undefined;
  let fetched = 0;
  effect(() => {
    const live = incidents().find((i) => i.id === props.id);
    if (!live || live.updated_at <= seen) return;
    const changed = !!seen && (live.status !== status || Date.now() - fetched > 60_000);
    seen = live.updated_at;
    status = live.status;
    if (changed) {
      fetched = Date.now();
      detail.refetch();
    }
  });

  const run = async (name: string, fn: () => Promise<unknown>) => {
    busy.set(name);
    try {
      const r = (await fn()) as { incident?: Detail["incident"] };
      if (r?.incident) upsert(r.incident);
      detail.refetch();
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    } finally {
      busy.set(null);
    }
  };

  const addNote = () =>
    note().trim() &&
    run("note", async () => {
      await api().note(props.id, note().trim());
      note.set("");
    });

  return (
    <Scroll class="flex-1 bg-background">
      <If when={detail()} else={detail.error() ? <Failed error={detail.error()} onRetry={() => detail.refetch()} /> : <Loading />}>
        {(d) => (
          <View class="w-full max-w-3xl gap-5 self-center p-4">
            <View class="gap-2">
              <View class="flex-row items-center gap-1.5">
                <Badge label={SEV_LABEL[d().incident.severity]} tone={d().incident.severity} />
                <StatusBadge status={d().incident.status} />
                <Meta>#{d().incident.number}</Meta>
              </View>
              <Text class="text-xl font-semibold text-foreground" selectable>
                {d().incident.title}
              </Text>
              <View class="flex-row flex-wrap gap-x-3 gap-y-0.5">
                <Meta>{d().incident.service_name}</Meta>
                <Meta>{d().incident.source || "Unknown source"}</Meta>
                <Meta>Opened {timeAgo(d().incident.created_at)}</Meta>
                {d().incident.alert_count > 1 && <Meta>{d().incident.alert_count} alerts</Meta>}
              </View>
            </View>

            <If when={d().incident.status !== "resolved"}>
              <View class={isDesktop ? "flex-row flex-wrap gap-2" : "gap-2"}>
                <View class="flex-row gap-2">
                {d().incident.status === "triggered" && (
                  <Btn title="Acknowledge" grow={!isDesktop} busy={busy() === "ack"} disabled={!!busy()} onPress={() => run("ack", () => api().acknowledge(props.id))} />
                )}
                <Btn
                  title="Resolve"
                  variant={d().incident.status === "triggered" ? "secondary" : "primary"}
                  grow={!isDesktop}
                  busy={busy() === "resolve"}
                  disabled={!!busy()}
                  onPress={() => run("resolve", () => api().resolve(props.id))}
                />
                </View>
                <View class="flex-row items-center gap-2">
                {d().incident.status === "triggered" && (
                  <Btn title="Page again" variant="ghost" busy={busy() === "repage"} disabled={!!busy()} onPress={() => run("repage", () => api().repage(props.id))} />
                )}
                <ActionMenu
                  trigger={<MenuBtn title="More" testID="incident-more" />}
                  items={[
                    { label: "Snooze 30 min", onSelect: () => run("snooze", () => api().snooze(props.id, 30)) },
                    { label: "Snooze 1 hour", onSelect: () => run("snooze", () => api().snooze(props.id, 60)) },
                    { label: "Snooze 4 hours", onSelect: () => run("snooze", () => api().snooze(props.id, 240)) },
                    ...(d().incident.status === "triggered" && d().escalation.nextAt
                      ? [{ label: "Escalate now", onSelect: () => run("escalate", () => api().escalate(props.id)) }]
                      : []),
                    { label: "Reassign", onSelect: () => reassigning.set(true) },
                    ...(mayNotify() && (d().incident.severity === "critical" || d().incident.severity === "error")
                      ? [{ label: "Notify customers", onSelect: () => noticing.set(true) }]
                      : []),
                  ]}
                />
                </View>
              </View>
            </If>

            <Surface>
              <Fact label="Paged" testID="paged"><Value>{d().assignees.length ? d().assignees.map((a) => a.name).join(", ") : "Nobody yet"}</Value></Fact>
              <If when={d().incident.snoozed_until != null}>
                <Fact label="Snoozed" testID="snoozed"><Value>{`Pages again in ${until(d().incident.snoozed_until!)}`}</Value></Fact>
              </If>
              <Fact label="Escalation" testID="escalation">
                <Value>
                  {d().incident.snoozed_until != null
                    ? "Waiting for the snooze"
                    : d().escalation.nextAt && d().incident.status === "triggered"
                    ? `Next step in ${until(d().escalation.nextAt!)}`
                    : d().incident.status === "triggered"
                      ? "Last step reached"
                      : "Stopped"}
                </Value>
              </Fact>
            </Surface>

            <If when={Object.keys(d().incident.details).length > 0}>
              <Section title="Details">
                <View class="rounded-(--radius) bg-muted p-3">
                  <Text class="font-mono text-xs text-foreground" selectable>
                    {JSON.stringify(d().incident.details, null, 2)}
                  </Text>
                </View>
              </Section>
            </If>

            <Section title="Timeline">
              <View class="px-1">
                <Each of={d().events} key={(e: IncidentEvent) => e.id}>
                  {(e, index) => <TimelineItem event={e} last={index() === d().events.length - 1} />}
                </Each>
              </View>
            </Section>

            <View class="flex-row items-end gap-2">
              <Input
                value={note()}
                onChange={(value) => note.set(value)}
                placeholder="Add a note"
                accessibilityLabel="Note"
                multiline
                class={`flex-1 ${field}`}
              />
              <Btn title="Add note" variant="secondary" busy={busy() === "note"} disabled={!!busy() || !note().trim()} onPress={addNote} />
            </View>
            <CustomerNotice id={props.id} open={noticing()} onClose={() => noticing.set(false)} onSent={() => detail.refetch()} />
            <FormSheet open={reassigning()} onClose={() => reassigning.set(false)} title="Reassign">
              <If when={people()} else={people.error() ? <Failed error={people.error()} onRetry={() => people.refetch()} /> : <Loading />}>
                {(list) => (
                  <Chips
                    testID="reassign-people"
                    options={list().map((u: User) => ({ id: u.id, label: u.name }))}
                    selected={[]}
                    onToggle={(id) => {
                      reassigning.set(false);
                      run("reassign", () => api().reassign(props.id, id));
                    }}
                  />
                )}
              </If>
            </FormSheet>
          </View>
        )}
      </If>
    </Scroll>
  );
}
