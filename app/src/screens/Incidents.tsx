import { Scroll, signal, Text, View } from "nsh";
import type { Incident } from "../api";
import { acknowledged, api, connection, incidents, lastError, refresh, triggered, upsert } from "../store";
import { toast } from "../toast";
import { Btn, Callout, Dot, Empty, IconBtn, isDesktop, Meta, Section, SeverityMark, Surface, Row, timeAgo, type Tone } from "../ui";

const LIVE: Record<"live" | "connecting" | "offline", { label: string; tone: Tone }> = {
  live: { label: "Live", tone: "ok" },
  connecting: { label: "Connecting…", tone: "warning" },
  offline: { label: "Offline, retrying", tone: "neutral" },
};

export function LiveStatus() {
  return (
    <View class="flex-row items-center gap-1.5">
      <Dot tone={LIVE[connection()].tone} />
      <Meta>{LIVE[connection()].label}</Meta>
    </View>
  );
}

function IncidentRow(props: { incident: () => Incident; selected: boolean; onOpen: (id: string) => void }) {
  const busy = signal(false);
  const i = () => props.incident();
  const act = async (fn: (id: string) => Promise<{ incident: Incident }>) => {
    busy.set(true);
    try {
      upsert((await fn(i().id)).incident);
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    } finally {
      busy.set(false);
    }
  };
  return (
    <Row selected={props.selected} onPress={() => props.onOpen(i().id)}>
      <View class="flex-1 gap-1">
        <Text class={`font-medium text-card-foreground ${isDesktop ? "text-sm" : "text-base"}`} numberOfLines={2}>
          {i().title}
        </Text>
        <View class="flex-row flex-wrap items-center gap-x-2.5 gap-y-0.5">
          <SeverityMark severity={i().severity} />
          <Meta>#{i().number}</Meta>
          {i().service_name && <Meta>{i().service_name}</Meta>}
          {i().alert_count > 1 && <Meta>{i().alert_count} alerts</Meta>}
          <Meta>{timeAgo(i().created_at)}</Meta>
        </View>
      </View>
      <If
        when={i().status === "triggered"}
        else={<Btn title="Resolve" variant="secondary" compact busy={busy()} onPress={() => act(api().resolve)} />}
      >
        <Btn title="Acknowledge" variant="secondary" compact busy={busy()} onPress={() => act(api().acknowledge)} />
      </If>
    </Row>
  );
}

export function Incidents(props: { selected?: string | null; onOpen: (id: string) => void }) {
  const list = (items: Incident[]) => (
    <Surface>
      <Each of={items} key={(i: Incident) => i.id}>
        {(i) => <IncidentRow incident={i} selected={props.selected === i().id} onOpen={props.onOpen} />}
      </Each>
    </Surface>
  );
  return (
    <Scroll class="flex-1 bg-background">
      <View class="w-full max-w-3xl gap-5 self-center p-3">
        <If when={lastError()}>
          <Callout tone="critical" title={lastError()!} />
        </If>

        <If when={incidents().length > 0} else={<Empty icon="check" title="All quiet" hint="Nothing is open." />}>
          <Section title="Triggered" count={triggered().length} right={<IconBtn icon="refresh" label="Refresh" onPress={() => refresh()} />}>
            <If when={triggered().length > 0} else={<Surface><Empty title="All quiet" hint="Nothing is waiting for an acknowledgement." /></Surface>}>
              {list(triggered())}
            </If>
          </Section>

          <If when={acknowledged().length > 0}>
            <Section title="Acknowledged" count={acknowledged().length}>
              {list(acknowledged())}
            </Section>
          </If>
        </If>
      </View>
    </Scroll>
  );
}
