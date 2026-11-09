import { Scroll, signal, Text, View } from "nsh";
import type { Incident } from "../api";
import { acknowledged, api, connection, lastError, refresh, triggered, upsert } from "../store";
import { toast } from "../toast";
import { Btn, Card, Empty, isDesktop, Pill, SectionTitle, SEV_COLOR, STATUS_COLOR, timeAgo } from "../ui";

export function IncidentRow(props: { incident: () => Incident; onOpen: (id: string) => void }) {
  const busy = signal(false);
  const act = async (fn: (id: string) => Promise<{ incident: Incident }>) => {
    busy.set(true);
    try {
      upsert((await fn(props.incident().id)).incident);
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    } finally {
      busy.set(false);
    }
  };
  return (
    <Card onPress={() => props.onOpen(props.incident().id)}>
      <View class="flex-row items-center gap-2">
        <View class="h-3 w-3 rounded-full" style={{ backgroundColor: SEV_COLOR[props.incident().severity] }} />
        <Text class="text-sm text-muted-foreground">
          #{props.incident().number} · {props.incident().service_name ?? ""} · {timeAgo(props.incident().created_at)}
        </Text>
        <View class="flex-1" />
        <Pill label={props.incident().status} color={STATUS_COLOR[props.incident().status]} />
      </View>
      <Text class="text-base font-semibold text-card-foreground" numberOfLines={3}>
        {props.incident().title}
      </Text>
      {props.incident().alert_count > 1 && (
        <Text class="text-sm text-muted-foreground">{props.incident().alert_count} alerts</Text>
      )}
      <View class="flex-row gap-2 pt-1">
        {props.incident().status === "triggered" && (
          <Btn title="Acknowledge" variant="danger" grow disabled={busy()} onPress={() => act(api().acknowledge)} />
        )}
        <Btn title="Resolve" variant="ghost" grow disabled={busy()} onPress={() => act(api().resolve)} />
      </View>
    </Card>
  );
}

export function Incidents(props: { onOpen: (id: string) => void }) {
  return (
    <Scroll class="flex-1 bg-background">
      <View class={`w-full gap-3 self-center p-4 ${isDesktop ? "max-w-3xl" : ""}`}>
        <View class="flex-row items-center gap-2">
          <View
            class="h-2 w-2 rounded-full"
            style={{ backgroundColor: connection() === "live" ? "#16a34a" : connection() === "connecting" ? "#ca8a04" : "#9ca3af" }}
          />
          <Text class="text-sm text-muted-foreground">
            {connection() === "live" ? "Live" : connection() === "connecting" ? "Connecting…" : "Offline — refreshing every 30s"}
          </Text>
          <View class="flex-1" />
          <Text class="text-sm font-semibold text-primary" onPress={() => refresh()} role="button">
            Refresh
          </Text>
        </View>

        {lastError() && <Text class="text-destructive">{lastError()}</Text>}

        <SectionTitle title={`Triggered (${triggered().length})`} />
        <If when={triggered().length > 0} else={<Empty title="All quiet" hint="Nothing is waiting for an acknowledgement." />}>
          <Each of={triggered()} key={(i: Incident) => i.id}>
            {(i) => <IncidentRow incident={i} onOpen={props.onOpen} />}
          </Each>
        </If>

        <If when={acknowledged().length > 0}>
          <SectionTitle title={`Acknowledged (${acknowledged().length})`} />
          <Each of={acknowledged()} key={(i: Incident) => i.id}>
            {(i) => <IncidentRow incident={i} onOpen={props.onOpen} />}
          </Each>
        </If>
      </View>
    </Scroll>
  );
}
