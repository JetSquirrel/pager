import { effect, resource, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { IncidentDetail as Detail, IncidentEvent } from "../api";
import { api, incidents, upsert } from "../store";
import { toast } from "../toast";
import { Btn, clock, Pill, SectionTitle, SEV_COLOR, STATUS_COLOR, timeAgo, until } from "../ui";

const KIND_LABEL: Record<string, string> = {
  triggered: "Triggered",
  alert_repeated: "Alert fired again",
  notified: "Paged",
  escalated: "Escalated",
  notify_sent: "Delivered",
  notify_failed: "Delivery failed",
  notify_gave_up: "Gave up delivering",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  note: "Note",
  escalation_failed: "Escalation failed",
};

const KIND_COLOR: Record<string, string> = {
  triggered: "#dc2626",
  escalated: "#ea580c",
  notify_failed: "#dc2626",
  notify_gave_up: "#dc2626",
  escalation_failed: "#dc2626",
  acknowledged: "#ca8a04",
  resolved: "#16a34a",
};

function TimelineItem(props: { event: () => IncidentEvent }) {
  return (
    <View class="flex-row gap-3">
      <View class="items-center">
        <View class="mt-1.5 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: KIND_COLOR[props.event().kind] ?? "#9ca3af" }} />
        <View class="w-px flex-1 bg-border" />
      </View>
      <View class="flex-1 gap-0.5 pb-4">
        <Text class="font-semibold text-foreground">
          {KIND_LABEL[props.event().kind] ?? props.event().kind}
          {props.event().actor_name ? `   ${props.event().actor_name}` : ""}
        </Text>
        {props.event().message && <Text class="text-foreground">{props.event().message}</Text>}
        <Text class="text-xs text-muted-foreground">{clock(props.event().at)}</Text>
      </View>
    </View>
  );
}

export function IncidentDetail(props: { id: string }) {
  const detail = resource(async () => api().incident(props.id));
  const note = signal("");
  const busy = signal(false);

  // A live update for this incident (from the socket) reloads the timeline.
  let seen = 0;
  effect(() => {
    const live = incidents().find((i) => i.id === props.id);
    if (live && live.updated_at > seen) {
      if (seen) detail.refetch();
      seen = live.updated_at;
    }
  });

  const run = async (fn: () => Promise<unknown>) => {
    busy.set(true);
    try {
      const r = (await fn()) as { incident?: Detail["incident"] };
      if (r?.incident) upsert(r.incident);
      detail.refetch();
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    } finally {
      busy.set(false);
    }
  };

  const addNote = () =>
    note().trim() &&
    run(async () => {
      await api().note(props.id, note().trim());
      note.set("");
    });

  return (
    <Scroll class="flex-1 bg-background">
      <If when={detail()} else={<Text class="p-6 text-muted-foreground">{detail.error() ? String(detail.error()) : "Loading…"}</Text>}>
        {(d) => (
          <View class="w-full max-w-3xl gap-4 self-center p-4">
            <View class="gap-2">
              <View class="flex-row items-center gap-2">
                <Pill label={d().incident.severity} color={SEV_COLOR[d().incident.severity]} />
                <Pill label={d().incident.status} color={STATUS_COLOR[d().incident.status]} />
                <Text class="text-sm text-muted-foreground">#{d().incident.number}</Text>
              </View>
              <Text class="text-2xl font-bold text-foreground">{d().incident.title}</Text>
              <Text class="text-muted-foreground">
                {`${d().incident.service_name}   ${d().incident.source || "unknown source"}   opened ${timeAgo(d().incident.created_at)}`}
              </Text>
              {d().incident.alert_count > 1 && <Text class="text-muted-foreground">{d().incident.alert_count} alerts folded in</Text>}
            </View>

            <View class="flex-row flex-wrap gap-2">
              {d().incident.status === "triggered" && (
                <Btn title="Acknowledge" variant="danger" grow disabled={busy()} onPress={() => run(() => api().acknowledge(props.id))} />
              )}
              {d().incident.status !== "resolved" && (
                <Btn title="Resolve" variant="success" grow disabled={busy()} onPress={() => run(() => api().resolve(props.id))} />
              )}
              {d().incident.status === "triggered" && (
                <Btn title="Page again" variant="ghost" disabled={busy()} onPress={() => run(() => api().repage(props.id))} />
              )}
            </View>

            <SectionTitle title="Escalation" />
            <View class="gap-1 rounded-xl border border-border bg-card p-4">
              <Text class="text-card-foreground">
                Paged: {d().assignees.length ? d().assignees.map((a) => a.name).join(", ") : "nobody yet"}
              </Text>
              <Text class="text-muted-foreground">
                {d().escalation.nextAt && d().incident.status === "triggered"
                  ? `Escalates to the next step in ${until(d().escalation.nextAt!)}`
                  : d().incident.status === "triggered"
                    ? "Last escalation step reached"
                    : "Escalation stopped"}
              </Text>
            </View>

            {Object.keys(d().incident.details).length > 0 && (
              <>
                <SectionTitle title="Details" />
                <View class="rounded-xl border border-border bg-card p-4">
                  <Text class="font-mono text-xs text-card-foreground" selectable>
                    {JSON.stringify(d().incident.details, null, 2)}
                  </Text>
                </View>
              </>
            )}

            <SectionTitle title="Timeline" />
            <View>
              <Each of={d().events} key={(e: IncidentEvent) => e.id}>
                {(e) => <TimelineItem event={e} />}
              </Each>
            </View>

            <View class="flex-row items-end gap-2">
              <Input
                value={note()}
                onChange={(value) => note.set(value)}
                placeholder="Add a note"
                multiline
                class="flex-1 rounded-(--radius) border border-border bg-background px-3 py-2 text-foreground placeholder:text-muted-foreground"
              />
              <Btn title="Add" variant="ghost" disabled={busy() || !note().trim()} onPress={addNote} />
            </View>
          </View>
        )}
      </If>
    </Scroll>
  );
}
