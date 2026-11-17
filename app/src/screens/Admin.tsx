// Admin: set up who gets paged for what — users, rotations, escalation policies and services
// (with the URLs monitoring tools send alerts to).
import { Clipboard, resource, Scroll, signal, Text, View } from "nsh";
import { Input, Switch } from "nsh/base";
import type { Customer, CustomerChannel, Policy, PolicyTarget, ScheduleDef, Service, User } from "../api";
import { api } from "../store";
import { toast } from "../toast";
import { ActionMenu, Badge, Btn, Callout, Chips, Empty, Failed, Field, field, FormSheet, IconBtn, isDesktop, Loading, MenuBtn, Meta, Page, Row, Section, Segmented, Surface, Value } from "../ui";

interface Data {
  users: User[];
  schedules: ScheduleDef[];
  policies: Policy[];
  services: Service[];
}

async function load(): Promise<Data> {
  const a = api();
  const [u, s, p, v] = await Promise.all([a.users(), a.schedules(), a.policies(), a.services()]);
  return { users: u.users, schedules: s.schedules, policies: p.policies, services: v.services };
}

const fail = (e: unknown) => toast(String((e as Error).message ?? e), "error");

async function copy(text: string, what: string) {
  try {
    await Clipboard.writeText(text);
    toast(`${what} copied`);
  } catch (e) {
    fail(e);
  }
}

const Name = (props: { children: string }) => <Text class="text-sm font-medium text-card-foreground" numberOfLines={1}>{props.children}</Text>;

function AddButton(props: { title: string; onPress: () => void }) {
  return <Btn title={props.title} variant="ghost" icon="plus" onPress={props.onPress} />;
}

// ------------------------------------------------------------------ services

function Services(props: { d: () => Data; reload: () => void }) {
  const open = signal(false);
  const name = signal("");
  const policy = signal<string | null>(null);
  const policyName = (id: string) => props.d().policies.find((p) => p.id === id)?.name ?? "?";
  const add = async () => {
    try {
      await api().addService({ name: name(), escalation_policy_id: policy()! });
      name.set("");
      open.set(false);
      props.reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Section title="Services" count={props.d().services.length} right={<AddButton title="New service" onPress={() => open.set(true)} />}>
      <If when={props.d().services.length > 0} else={<Surface><Empty title="No services" hint="A service is where monitoring tools send alerts." /></Surface>}>
        <Surface>
          {props.d().services.map((s) => (
            <Row>
              <View class="flex-1 gap-0.5">
                <View class="flex-row items-center gap-1.5">
                  <Name>{s.name}</Name>
                  {s.open_incidents > 0 && <Badge label={`${s.open_incidents} open`} tone="warning" />}
                </View>
                <Meta>Escalation: {policyName(s.escalation_policy_id)}</Meta>
              </View>
              {s.endpoints && (
                <ActionMenu
                  trigger={<MenuBtn title="Copy URL" icon="copy" testID={`copy-${s.id}`} />}
                  items={[
                    { label: "Alertmanager", onSelect: () => copy(s.endpoints!.alertmanager, "Alertmanager URL") },
                    { label: "Grafana", onSelect: () => copy(s.endpoints!.grafana, "Grafana URL") },
                    { label: "Events API", onSelect: () => copy(s.endpoints!.events, "Events API URL") },
                  ]}
                />
              )}
            </Row>
          ))}
        </Surface>
      </If>
      <FormSheet open={open()} onClose={() => open.set(false)} title="New service">
        <Field label="Name">
          <Input testID="service-name" value={name()} onChange={(v) => name.set(v)} placeholder="Checkout API" class={field} />
        </Field>
        <Field label="Escalation policy" hint={props.d().policies.length === 0 ? "Create an escalation policy first." : undefined}>
          <Chips
            testID="service-policy"
            options={props.d().policies.map((p) => ({ id: p.id, label: p.name }))}
            selected={policy() ? [policy()!] : []}
            onToggle={(id) => policy.set(id)}
          />
        </Field>
        <Btn title="Create service" disabled={!name() || !policy()} onPress={add} />
      </FormSheet>
    </Section>
  );
}

// ------------------------------------------------------------------ escalation policies

function Policies(props: { d: () => Data; reload: () => void }) {
  const open = signal(false);
  const name = signal("");
  const first = signal<string[]>([]);
  const second = signal<string[]>([]);
  const delay = signal("10");
  const repeat = signal("2");

  // Targets are "schedule:<id>" / "user:<id>" in the chips.
  const options = () => [
    ...props.d().schedules.map((s) => ({ id: `schedule:${s.id}`, label: s.name, icon: "calendar" as const })),
    ...props.d().users.map((u) => ({ id: `user:${u.id}`, label: u.name })),
  ];
  const toTargets = (ids: string[]): PolicyTarget[] =>
    ids.map((x) => {
      const [type, id] = x.split(":");
      return { type: type as PolicyTarget["type"], id };
    });
  const toggle = (sig: typeof first) => (id: string) =>
    sig.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  const label = (t: PolicyTarget) =>
    t.type === "schedule"
      ? `on call in ${props.d().schedules.find((s) => s.id === t.id)?.name ?? "?"}`
      : (props.d().users.find((u) => u.id === t.id)?.name ?? "?");

  const add = async () => {
    const steps = [{ delay_min: 0, targets: toTargets(first()) }];
    if (second().length) steps.push({ delay_min: Math.max(1, Number(delay()) || 10), targets: toTargets(second()) });
    try {
      await api().addPolicy({ name: name(), repeat: Math.max(0, Math.min(9, Number(repeat()) || 0)), steps });
      name.set("");
      first.set([]);
      second.set([]);
      open.set(false);
      props.reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Section title="Escalation policies" count={props.d().policies.length} right={<AddButton title="New policy" onPress={() => open.set(true)} />}>
      <If when={props.d().policies.length > 0} else={<Surface><Empty title="No policies" hint="A policy says who is paged, and who next." /></Surface>}>
        <Surface>
          {props.d().policies.map((p) => (
            <Row>
              <View class="flex-1 gap-1">
                <Name>{p.name}</Name>
                {p.steps.map((s, i) => (
                  <Value>{`${i === 0 ? "At once" : `After ${s.delay_min} min`}: ${s.targets.map(label).join(", ")}`}</Value>
                ))}
                <Meta>{p.repeat ? `Repeats ${p.repeat}× until acknowledged` : "Does not repeat"}</Meta>
              </View>
            </Row>
          ))}
        </Surface>
      </If>
      <FormSheet open={open()} onClose={() => open.set(false)} title="New escalation policy">
        <Field label="Name">
          <Input testID="policy-name" value={name()} onChange={(v) => name.set(v)} placeholder="Default" class={field} />
        </Field>
        <Field label="Page at once">
          <Chips testID="policy-first" options={options()} selected={first()} onToggle={toggle(first)} />
        </Field>
        <Field label="Then escalate to" hint="Optional. Used when nobody acknowledges.">
          <Chips testID="policy-second" options={options()} selected={second()} onToggle={toggle(second)} />
        </Field>
        <View class="flex-row gap-3">
          <View class="flex-1">
            <Field label="After minutes">
              <Input value={delay()} onChange={(v) => delay.set(v)} keyboardType="number-pad" class={field} />
            </Field>
          </View>
          <View class="flex-1">
            <Field label="Repeat times">
              <Input value={repeat()} onChange={(v) => repeat.set(v)} keyboardType="number-pad" class={field} />
            </Field>
          </View>
        </View>
        <Btn title="Create policy" disabled={!name() || first().length === 0} onPress={add} />
      </FormSheet>
    </Section>
  );
}

// ------------------------------------------------------------------ rotations

const SHIFTS: { value: string; label: string }[] = [
  { value: "8", label: "8 h" },
  { value: "12", label: "12 h" },
  { value: "24", label: "Daily" },
  { value: "168", label: "Weekly" },
];

function Schedules(props: { d: () => Data; reload: () => void }) {
  const open = signal(false);
  const name = signal("");
  const members = signal<string[]>([]);
  const shift = signal("168");
  const userName = (id: string) => props.d().users.find((u) => u.id === id)?.name ?? "?";
  const add = async () => {
    try {
      await api().addSchedule({ name: name(), rotation: { shift_hours: Number(shift()), users: members() } });
      name.set("");
      members.set([]);
      open.set(false);
      props.reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Section title="Rotations" count={props.d().schedules.length} right={<AddButton title="New rotation" onPress={() => open.set(true)} />}>
      <If when={props.d().schedules.length > 0} else={<Surface><Empty title="No rotations" hint="A rotation takes turns being on call." /></Surface>}>
        <Surface>
          {props.d().schedules.map((s) => (
            <Row>
              <View class="flex-1 gap-1">
                <Name>{s.name}</Name>
                <Value>{s.rotation.users.map(userName).join(" → ")}</Value>
              </View>
              <Meta>{s.rotation.shift_hours % 24 === 0 ? `${s.rotation.shift_hours / 24}-day` : `${s.rotation.shift_hours}-hour`} shifts</Meta>
            </Row>
          ))}
        </Surface>
      </If>
      <FormSheet open={open()} onClose={() => open.set(false)} title="New rotation">
        <Field label="Name">
          <Input testID="schedule-name" value={name()} onChange={(v) => name.set(v)} placeholder="Primary" class={field} />
        </Field>
        <Field label="Who, in order" hint="The first one starts now.">
          <Chips
            testID="rotation-members"
            options={props.d().users.map((u) => ({ id: u.id, label: u.name }))}
            selected={members()}
            onToggle={(id) => members.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]))}
          />
        </Field>
        <Field label="Shift length">
          <Segmented testID="rotation-shift" options={SHIFTS} value={shift()} onChange={(v) => shift.set(v)} />
        </Field>
        <Btn title="Create rotation" disabled={!name() || members().length === 0} onPress={add} />
      </FormSheet>
    </Section>
  );
}

// ------------------------------------------------------------------ people

function People(props: { d: () => Data; reload: () => void }) {
  const open = signal(false);
  const email = signal("");
  const name = signal("");
  const role = signal<"responder" | "admin">("responder");
  const issued = signal<{ name: string; token: string } | null>(null);
  const add = async () => {
    try {
      const r = await api().addUser({ email: email(), name: name() || email(), role: role() });
      issued.set({ name: name() || email(), token: r.token });
      email.set("");
      name.set("");
      open.set(false);
      props.reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Section title="People" count={props.d().users.length} right={<AddButton title="Add person" onPress={() => open.set(true)} />}>
      <View class="gap-2">
        <If when={issued()}>
          {(t) => (
            <Callout title={`Token for ${t().name}, shown once`}>
              <Text class="font-mono text-xs text-foreground" selectable>{t().token}</Text>
              <View class="flex-row gap-2">
                <Btn title="Copy token" variant="secondary" icon="copy" onPress={() => copy(t().token, "Token")} />
                <Btn title="Done" variant="ghost" onPress={() => issued.set(null)} />
              </View>
            </Callout>
          )}
        </If>
        <Surface>
          {props.d().users.map((u) => (
            <Row>
              <View class="flex-1 gap-0.5">
                <Name>{u.name}</Name>
                <Meta>{u.email}</Meta>
              </View>
              <If when={u.role === "admin"} else={
                <View class="flex-row items-center gap-2">
                  <Meta>Customer notices</Meta>
                  <Switch
                    checked={!!u.can_notify_customers}
                    accessibilityLabel={`${u.name} may notify customers`}
                    onChange={(checked) => api().updateUser(u.id, { can_notify_customers: checked }).then(props.reload, fail)}
                    trackClass="w-9 rounded-full bg-input p-0.5 transition-colors checked:bg-primary"
                    thumbClass="size-4 rounded-full bg-card shadow-sm transition-transform checked:translate-x-4"
                  />
                </View>
              }>
                <Badge label="Admin" />
              </If>
            </Row>
          ))}
        </Surface>
      </View>
      <FormSheet open={open()} onClose={() => open.set(false)} title="Add person">
        <Field label="Email">
          <Input testID="user-email" value={email()} onChange={(v) => email.set(v)} placeholder="alice@example.com" autoCapitalize="none" keyboardType="email-address" class={field} />
        </Field>
        <Field label="Name">
          <Input testID="user-name" value={name()} onChange={(v) => name.set(v)} placeholder="Alice" class={field} />
        </Field>
        <Field label="Role">
          <Segmented options={[{ value: "responder", label: "Responder" }, { value: "admin", label: "Admin" }]} value={role()} onChange={(v) => role.set(v as "responder" | "admin")} />
        </Field>
        <Btn title="Add person" disabled={!email()} onPress={add} />
      </FormSheet>
    </Section>
  );
}

// ------------------------------------------------------------------ customers

const CHANNELS: { value: CustomerChannel; label: string; field: string; key: string }[] = [
  { value: "webhook", label: "Webhook", field: "URL", key: "url" },
  { value: "slack", label: "Slack", field: "Webhook URL", key: "webhook_url" },
  { value: "ntfy", label: "ntfy", field: "Topic", key: "topic" },
];

function Customers(props: { d: () => Data }) {
  const list = resource(async () => api().customers());
  const open = signal(false);
  const name = signal("");
  const channel = signal<CustomerChannel>("webhook");
  const target = signal("");
  const service = signal<string | null>(null);
  const meta = () => CHANNELS.find((c) => c.value === channel())!;
  const add = async () => {
    try {
      await api().addCustomer({ name: name().trim(), type: channel(), config: { [meta().key]: target().trim() }, service_id: service() });
      name.set("");
      target.set("");
      service.set(null);
      open.set(false);
      list.refetch();
    } catch (e) {
      fail(e);
    }
  };
  const serviceName = (id: string | null) => (id ? (props.d().services.find((s) => s.id === id)?.name ?? "?") : "All services");
  return (
    <Section title="Customers" count={list()?.customers.length} right={<AddButton title="Add customer" onPress={() => open.set(true)} />}>
      <If when={list()} else={list.error() ? <Failed error={list.error()} onRetry={() => list.refetch()} /> : <Loading />}>
        {(l) => (
          <View class="gap-2">
            <If when={!l().live}>
              <Callout title="Dry run: notices reach nobody until CUSTOMER_NOTIFY is on." />
            </If>
            <If when={l().customers.length > 0} else={<Surface><Empty title="No customers" hint="They hear from you only when someone sends a notice." /></Surface>}>
              <Surface>
                {l().customers.map((c: Customer) => (
                  <Row>
                    <View class="flex-1 gap-0.5">
                      <Name>{c.name}</Name>
                      <Meta>{`${c.type}  ${serviceName(c.service_id)}`}</Meta>
                    </View>
                    <IconBtn icon="trash" label={`Remove ${c.name}`} onPress={() => api().deleteCustomer(c.id).then(() => list.refetch(), fail)} />
                  </Row>
                ))}
              </Surface>
            </If>
          </View>
        )}
      </If>
      <FormSheet open={open()} onClose={() => open.set(false)} title="Add customer">
        <Field label="Name">
          <Input testID="customer-name" value={name()} onChange={(v) => name.set(v)} placeholder="Acme Inc" class={field} />
        </Field>
        <Field label="Channel">
          <Segmented testID="customer-channel" options={CHANNELS} value={channel()} onChange={(v) => (channel.set(v), target.set(""))} />
        </Field>
        <Field label={meta().field}>
          <Input testID="customer-target" value={target()} onChange={(v) => target.set(v)} autoCapitalize="none" autoCorrect={false} class={field} />
        </Field>
        <Field label="Service" hint="None selected means every service.">
          <Chips testID="customer-service" options={props.d().services.map((s) => ({ id: s.id, label: s.name }))} selected={service() ? [service()!] : []} onToggle={(id) => service.update((v) => (v === id ? null : id))} />
        </Field>
        <Btn title="Add customer" disabled={!name().trim() || !target().trim()} onPress={add} />
      </FormSheet>
    </Section>
  );
}

// ------------------------------------------------------------------ usage

const count = (n: number) => n.toLocaleString("en-US");

/** Today's use of the Cloudflare free plan. Past a daily limit the pager cannot page anyone until 00:00 UTC. */
function Usage(props: { usage: () => Awaited<ReturnType<ReturnType<typeof api>["usage"]>> }) {
  const u = () => props.usage();
  const row = (label: string, used: number, limit: number) => (
    <Row>
      <Text class="flex-1 text-sm text-card-foreground">{label}</Text>
      <Meta>{`${count(used)} of ${count(limit)}`}</Meta>
    </Row>
  );
  return (
    <Section title="Free plan today">
      <Surface>
        {row("Requests", u().requests, u().free.requests)}
        {row("Rows read", u().rowsRead, u().free.rowsRead)}
        {row("Rows written", u().rowsWritten, u().free.rowsWritten)}
      </Surface>
    </Section>
  );
}

type Tab = "services" | "policies" | "rotations" | "people" | "customers" | "usage";

const TABS: { value: Tab; label: string }[] = [
  { value: "services", label: "Services" },
  { value: "policies", label: "Policies" },
  { value: "rotations", label: "Rotations" },
  { value: "people", label: "People" },
  { value: "customers", label: "Customers" },
  { value: "usage", label: "Usage" },
];

export function Admin() {
  const data = resource(load);
  const usage = resource(async () => api().usage());
  const reload = () => data.refetch();
  const tab = signal<Tab>("services");
  return (
    <Page>
      <View class="gap-4">
        <If when={usage() && usage()!.pressure !== "ok"}>
          <Callout tone="critical" title="Free plan running out today: repeats and receipts are no longer recorded." />
        </If>
        {/* Six sections do not fit across a phone: they scroll instead of being cut short. */}
        <If when={isDesktop} else={<Scroll horizontal scrollbar={false}><Segmented hug options={TABS} value={tab()} onChange={(v) => tab.set(v)} testID="admin-tabs" /></Scroll>}>
          <Segmented options={TABS} value={tab()} onChange={(v) => tab.set(v)} testID="admin-tabs" />
        </If>
        <If when={data()} else={data.error() ? <Failed error={data.error()} onRetry={reload} /> : <Loading />}>
          {(d) => (
            <>
              <If when={tab() === "services"}><Services d={d} reload={reload} /></If>
              <If when={tab() === "policies"}><Policies d={d} reload={reload} /></If>
              <If when={tab() === "rotations"}><Schedules d={d} reload={reload} /></If>
              <If when={tab() === "people"}><People d={d} reload={reload} /></If>
              <If when={tab() === "customers"}><Customers d={d} /></If>
              <If when={tab() === "usage"}>
                <If when={usage()} else={<Loading />}>{(u) => <Usage usage={u} />}</If>
              </If>
            </>
          )}
        </If>
      </View>
    </Page>
  );
}
