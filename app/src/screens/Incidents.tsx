import { batch, resource, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { Incident, Service, Severity } from "../api";
import { acknowledged, api, connection, incidents, lastError, me, refresh, triggered, upsert } from "../store";
import { toast } from "../toast";
import { Badge, Btn, Callout, Chips, Dot, Empty, Failed, Field, field, FormSheet, IconBtn, isDesktop, Loading, Meta, Row, Section, Segmented, SEV_LABEL, SeverityMark, Surface, timeAgo, type Tone, until } from "../ui";

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

type Filter = "mine" | "all" | "history";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "mine", label: "Mine" },
  { value: "all", label: "All" },
  { value: "history", label: "History" },
];

const filter = signal<Filter>("mine");

const message = (e: unknown) => String((e as Error).message ?? e);

function IncidentRow(props: { incident: () => Incident; selected: boolean; onOpen: (id: string) => void }) {
  const busy = signal(false);
  const i = () => props.incident();
  const act = async (fn: (id: string) => Promise<{ incident: Incident }>) => {
    busy.set(true);
    try {
      upsert((await fn(i().id)).incident);
    } catch (e) {
      toast(message(e), "error");
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
          {i().snoozed_until != null && <Badge label={`Snoozed ${until(i().snoozed_until!)}`} />}
        </View>
      </View>
      <If when={i().status === "triggered"}>
        <Btn title="Acknowledge" variant="secondary" compact busy={busy()} onPress={() => act(api().acknowledge)} />
      </If>
      <If when={i().status === "acknowledged"}>
        <Btn title="Resolve" variant="secondary" compact busy={busy()} onPress={() => act(api().resolve)} />
      </If>
    </Row>
  );
}

const SEVERITIES: { value: Severity; label: string }[] = (["critical", "error", "warning", "info"] as const).map((value) => ({ value, label: SEV_LABEL[value] }));

function NewIncident(props: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const services = resource(() => props.open || null, async () => (await api().services()).services);
  const service = signal<string | null>(null);
  const title = signal("");
  const severity = signal<Severity>("critical");
  const busy = signal(false);
  const create = async () => {
    busy.set(true);
    try {
      const { incident } = await api().openIncident({ service_id: service()!, title: title().trim(), severity: severity() });
      upsert(incident);
      title.set("");
      props.onClose();
      props.onCreated(incident.id);
    } catch (e) {
      toast(message(e), "error");
    } finally {
      busy.set(false);
    }
  };
  return (
    <FormSheet open={props.open} onClose={props.onClose} title="New incident">
      <Field label="What is wrong">
        <Input testID="incident-title" value={title()} onChange={(v) => title.set(v)} placeholder="Checkout is returning 500s" class={field} />
      </Field>
      <Field label="Service">
        <If when={services()} else={services.error() ? <Failed error={services.error()} onRetry={() => services.refetch()} /> : <Loading />}>
          {(list) => <Chips testID="incident-service" options={list().map((s: Service) => ({ id: s.id, label: s.name }))} selected={service() ? [service()!] : []} onToggle={(id) => service.set(id)} />}
        </If>
      </Field>
      <Field label="Severity">
        <Segmented testID="incident-severity" options={SEVERITIES} value={severity()} onChange={(v) => severity.set(v)} />
      </Field>
      <Btn title="Page the on-call" busy={busy()} disabled={!title().trim() || !service()} onPress={create} />
    </FormSheet>
  );
}

export function Incidents(props: { selected?: string | null; onOpen: (id: string) => void }) {
  const creating = signal(false);
  const acking = signal(false);
  const history = resource(() => (filter() === "history" ? "resolved" : null), async () => (await api().incidents("resolved", 50)).incidents);

  const scope = (items: Incident[]) => (filter() === "mine" ? items.filter((i) => i.assignees.includes(me()?.id ?? "")) : items);
  const paging = () => scope(triggered());
  const working = () => scope(acknowledged());
  const others = () => incidents().length - paging().length - working().length;

  const ackAll = async () => {
    acking.set(true);
    try {
      const done = await api().bulk("acknowledge", paging().map((i) => i.id));
      batch(() => done.incidents.forEach(upsert));
    } catch (e) {
      toast(message(e), "error");
    } finally {
      acking.set(false);
    }
  };

  const list = (items: Incident[]) => (
    <Surface>
      <Each of={items} key={(i: Incident) => i.id}>
        {(i) => <IncidentRow incident={i} selected={props.selected === i().id} onOpen={props.onOpen} />}
      </Each>
    </Surface>
  );

  return (
    <Scroll class="flex-1 bg-background">
      <View class="w-full max-w-3xl gap-4 self-center p-3">
        <View class="flex-row items-center gap-1">
          <View class={isDesktop ? "" : "flex-1"}>
            <Segmented testID="incident-filter" options={FILTERS} value={filter()} onChange={(v) => filter.set(v)} />
          </View>
          {isDesktop && <View class="flex-1" />}
          <IconBtn icon="plus" label="New incident" testID="new-incident" onPress={() => creating.set(true)} />
          <IconBtn icon="refresh" label="Refresh" onPress={() => (filter() === "history" ? history.refetch() : refresh())} />
        </View>

        <If when={lastError()}>
          <Callout tone="critical" title={lastError()!} />
        </If>

        <If
          when={filter() !== "history"}
          else={
            <If when={history()} else={history.error() ? <Failed error={history.error()} onRetry={() => history.refetch()} /> : <Loading />}>
              {(items) => <If when={items().length > 0} else={<Empty icon="check" title="No resolved incidents" />}>{list(items())}</If>}
            </If>
          }
        >
          <If when={paging().length + working().length > 0} else={<Empty icon="check" title="All quiet" hint={others() > 0 ? `${others()} open for others` : "Nothing is open."} />}>
            <Section
              title="Triggered"
              count={paging().length}
              right={paging().length > 1 ? <Btn title="Acknowledge all" variant="ghost" compact busy={acking()} onPress={ackAll} /> : undefined}
            >
              <If when={paging().length > 0} else={<Surface><Empty title="All quiet" hint="Nothing is waiting for an acknowledgement." /></Surface>}>
                {list(paging())}
              </If>
            </Section>

            <If when={working().length > 0}>
              <Section title="Acknowledged" count={working().length}>
                {list(working())}
              </Section>
            </If>
          </If>
        </If>
      </View>
      <NewIncident open={creating()} onClose={() => creating.set(false)} onCreated={props.onOpen} />
    </Scroll>
  );
}
