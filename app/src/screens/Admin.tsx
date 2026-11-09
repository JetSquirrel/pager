// Admin: set up who gets paged for what — users, rotations, escalation policies and services
// (with the URLs monitoring tools send alerts to).
import { Clipboard, resource, Scroll, signal, Text, View } from "nsh";
import type { JSX } from "nsh/types";
import { Button, Input } from "nsh/base";
import type { Policy, PolicyTarget, ScheduleDef, Service, User } from "../api";
import { api } from "../store";
import { toast } from "../toast";
import { Btn, SectionTitle } from "../ui";

const field = "rounded-(--radius) border border-border bg-background px-3 py-2.5 text-foreground placeholder:text-muted-foreground";

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

/** A row of toggle chips. */
function Chips(props: { testID?: string; options: { id: string; label: string }[]; selected: string[]; onToggle: (id: string) => void }) {
  return (
    <View testID={props.testID} class="flex-row flex-wrap gap-2">
      {props.options.map((o) => (
        <Button
          onPress={() => props.onToggle(o.id)}
          class={`rounded-full border px-3 py-1.5 ${props.selected.includes(o.id) ? "border-primary bg-primary" : "border-border bg-background active:bg-muted"}`}
        >
          <Text class={`text-sm ${props.selected.includes(o.id) ? "text-primary-foreground" : "text-foreground"}`}>
            {props.selected.includes(o.id) && props.selected.length > 1 ? `${props.selected.indexOf(o.id) + 1}. ` : ""}
            {o.label}
          </Text>
        </Button>
      ))}
    </View>
  );
}

function Panel(props: { children: JSX.Element }) {
  return <View class="gap-3 rounded-xl border border-border bg-card p-4">{props.children}</View>;
}

// ------------------------------------------------------------------ services

function Services(props: { d: () => Data; reload: () => void }) {
  const name = signal("");
  const policy = signal<string | null>(null);
  const policyName = (id: string) => props.d().policies.find((p) => p.id === id)?.name ?? "?";
  const add = async () => {
    try {
      await api().addService({ name: name(), escalation_policy_id: policy()! });
      name.set("");
      props.reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <SectionTitle title="Services" />
      {props.d().services.map((s) => (
        <Panel>
          <View class="flex-row items-center gap-2">
            <Text class="flex-1 text-lg font-semibold text-card-foreground">{s.name}</Text>
            <Text class="text-sm text-muted-foreground">{s.open_incidents} open</Text>
          </View>
          <Text class="text-muted-foreground">Escalation: {policyName(s.escalation_policy_id)}</Text>
          {s.endpoints && (
            <View class="flex-row flex-wrap gap-2">
              <Btn title="Copy Alertmanager URL" variant="ghost" onPress={() => copy(s.endpoints!.alertmanager, "Alertmanager URL")} />
              <Btn title="Copy Grafana URL" variant="ghost" onPress={() => copy(s.endpoints!.grafana, "Grafana URL")} />
              <Btn title="Copy Events API URL" variant="ghost" onPress={() => copy(s.endpoints!.events, "Events API URL")} />
            </View>
          )}
        </Panel>
      ))}
      <Panel>
        <Text class="font-semibold text-card-foreground">New service</Text>
        <Input testID="service-name" value={name()} onChange={(v) => name.set(v)} placeholder="Name (e.g. Checkout API)" class={field} />
        <Text class="text-sm text-muted-foreground">Escalation policy</Text>
        {props.d().policies.length === 0 ? (
          <Text class="text-sm text-muted-foreground">Create an escalation policy first.</Text>
        ) : (
          <Chips
            testID="service-policy"
            options={props.d().policies.map((p) => ({ id: p.id, label: p.name }))}
            selected={policy() ? [policy()!] : []}
            onToggle={(id) => policy.set(id)}
          />
        )}
        <Btn title="Create service" disabled={!name() || !policy()} onPress={add} />
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------ escalation policies

function Policies(props: { d: () => Data; reload: () => void }) {
  const name = signal("");
  const first = signal<string[]>([]);
  const second = signal<string[]>([]);
  const delay = signal("10");
  const repeat = signal("2");

  // Targets are "schedule:<id>" / "user:<id>" in the chips.
  const options = () => [
    ...props.d().schedules.map((s) => ({ id: `schedule:${s.id}`, label: `🗓 ${s.name}` })),
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
      props.reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      <SectionTitle title="Escalation policies" />
      {props.d().policies.map((p) => (
        <Panel>
          <Text class="text-lg font-semibold text-card-foreground">{p.name}</Text>
          {p.steps.map((s, i) => (
            <Text class="text-card-foreground">
              {i === 0 ? "At once" : `After ${s.delay_min} min`}: {s.targets.map(label).join(", ")}
            </Text>
          ))}
          <Text class="text-sm text-muted-foreground">
            {p.repeat ? `Repeats ${p.repeat}× until acknowledged` : "Does not repeat"}
          </Text>
        </Panel>
      ))}
      <Panel>
        <Text class="font-semibold text-card-foreground">New escalation policy</Text>
        <Input testID="policy-name" value={name()} onChange={(v) => name.set(v)} placeholder="Name (e.g. Default)" class={field} />
        <Text class="text-sm text-muted-foreground">Page at once</Text>
        <Chips testID="policy-first" options={options()} selected={first()} onToggle={toggle(first)} />
        <Text class="text-sm text-muted-foreground">If nobody acknowledges, escalate to (optional)</Text>
        <Chips testID="policy-second" options={options()} selected={second()} onToggle={toggle(second)} />
        <View class="flex-row gap-2">
          <View class="flex-1 gap-1">
            <Text class="text-sm text-muted-foreground">after minutes</Text>
            <Input value={delay()} onChange={(v) => delay.set(v)} keyboardType="number-pad" class={field} />
          </View>
          <View class="flex-1 gap-1">
            <Text class="text-sm text-muted-foreground">repeat times</Text>
            <Input value={repeat()} onChange={(v) => repeat.set(v)} keyboardType="number-pad" class={field} />
          </View>
        </View>
        <Btn title="Create policy" disabled={!name() || first().length === 0} onPress={add} />
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------ schedules

function Schedules(props: { d: () => Data; reload: () => void }) {
  const name = signal("");
  const members = signal<string[]>([]);
  const shift = signal("168");
  const userName = (id: string) => props.d().users.find((u) => u.id === id)?.name ?? "?";
  const add = async () => {
    try {
      await api().addSchedule({ name: name(), rotation: { shift_hours: Number(shift()), users: members() } });
      name.set("");
      members.set([]);
      props.reload();
    } catch (e) {
      fail(e);
    }
  };
  const SHIFTS = [
    { id: "8", label: "8 h" },
    { id: "12", label: "12 h" },
    { id: "24", label: "Daily" },
    { id: "168", label: "Weekly" },
  ];
  return (
    <>
      <SectionTitle title="Rotations" />
      {props.d().schedules.map((s) => (
        <Panel>
          <Text class="text-lg font-semibold text-card-foreground">{s.name}</Text>
          <Text class="text-card-foreground">{s.rotation.users.map(userName).join(" → ")}</Text>
          <Text class="text-sm text-muted-foreground">
            {s.rotation.shift_hours % 24 === 0 ? `${s.rotation.shift_hours / 24}-day` : `${s.rotation.shift_hours}-hour`} shifts
          </Text>
        </Panel>
      ))}
      <Panel>
        <Text class="font-semibold text-card-foreground">New rotation</Text>
        <Input testID="schedule-name" value={name()} onChange={(v) => name.set(v)} placeholder="Name (e.g. Primary)" class={field} />
        <Text class="text-sm text-muted-foreground">Who, in order (the first one starts now)</Text>
        <Chips
          testID="rotation-members"
          options={props.d().users.map((u) => ({ id: u.id, label: u.name }))}
          selected={members()}
          onToggle={(id) => members.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]))}
        />
        <Text class="text-sm text-muted-foreground">Shift length</Text>
        <Chips testID="rotation-shift" options={SHIFTS} selected={[shift()]} onToggle={(id) => shift.set(id)} />
        <Btn title="Create rotation" disabled={!name() || members().length === 0} onPress={add} />
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------ users

function Users(props: { d: () => Data; reload: () => void }) {
  const email = signal("");
  const name = signal("");
  const admin = signal(false);
  const issued = signal<{ name: string; token: string } | null>(null);
  const add = async () => {
    try {
      const r = await api().addUser({ email: email(), name: name() || email(), role: admin() ? "admin" : "responder" });
      issued.set({ name: name() || email(), token: r.token });
      email.set("");
      name.set("");
      props.reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <SectionTitle title="People" />
      <Panel>
        {props.d().users.map((u) => (
          <View class="flex-row items-center gap-2">
            <Text class="flex-1 text-card-foreground">{u.name}</Text>
            <Text class="text-sm text-muted-foreground">
              {u.email}
              {u.role === "admin" ? " · admin" : ""}
            </Text>
          </View>
        ))}
      </Panel>
      <If when={issued()}>
        {(t) => (
          <View class="gap-2 rounded-xl border border-ok bg-card p-4">
            <Text class="font-semibold text-card-foreground">Token for {t().name} — shown once</Text>
            <Text class="font-mono text-sm text-card-foreground" selectable>
              {t().token}
            </Text>
            <View class="flex-row gap-2">
              <Btn title="Copy token" variant="ghost" onPress={() => copy(t().token, "Token")} />
              <Btn title="Done" variant="ghost" onPress={() => issued.set(null)} />
            </View>
          </View>
        )}
      </If>
      <Panel>
        <Text class="font-semibold text-card-foreground">Add a person</Text>
        <Input testID="user-email" value={email()} onChange={(v) => email.set(v)} placeholder="Email" autoCapitalize="none" keyboardType="email-address" class={field} />
        <Input testID="user-name" value={name()} onChange={(v) => name.set(v)} placeholder="Name" class={field} />
        <Chips
          options={[
            { id: "responder", label: "Responder" },
            { id: "admin", label: "Admin" },
          ]}
          selected={[admin() ? "admin" : "responder"]}
          onToggle={(id) => admin.set(id === "admin")}
        />
        <Btn title="Add person" disabled={!email()} onPress={add} />
      </Panel>
    </>
  );
}

export function Admin() {
  const data = resource(load);
  const reload = () => data.refetch();
  return (
    <Scroll class="flex-1 bg-background">
      <View class="w-full max-w-3xl gap-3 self-center p-4">
        <If when={data()} else={<Text class="p-2 text-muted-foreground">{data.error() ? String(data.error()) : "Loading…"}</Text>}>
          {(d) => (
            <>
              <Services d={d} reload={reload} />
              <Policies d={d} reload={reload} />
              <Schedules d={d} reload={reload} />
              <Users d={d} reload={reload} />
            </>
          )}
        </If>
      </View>
    </Scroll>
  );
}
