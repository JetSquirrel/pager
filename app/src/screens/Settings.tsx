import { Clipboard, resource, signal, Text, token, View } from "nsh";
import { AlertDialog, Input, Switch } from "nsh/base";
import type { ContactMethod, HardwarePager, Severity, TuyaDevice } from "../api";
import { pushEnable, pushState } from "../host";
import { api, me, session, signOut } from "../store";
import { toast } from "../toast";
import { ActionMenu, Badge, Btn, Callout, Chips, Dot, Failed, Field, field, FormSheet, Icon, IconBtn, type IconName, isDesktop, Loading, MenuBtn, Meta, Page, Row, Section, Segmented, SEV_LABEL, Surface, timeAgo } from "../ui";

type Kind = ContactMethod["type"];

const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "ntfy", label: "Push", hint: "Phone and desktop push through the ntfy app. Install ntfy and subscribe to the topic." },
  { value: "tuya", label: "Tuya", hint: "A Tuya siren, plug or light that goes off when you're paged and stops when acknowledged." },
  { value: "slack", label: "Slack", hint: "A Slack incoming webhook." },
  { value: "webhook", label: "Webhook", hint: "POSTs JSON to your URL on page, acknowledge and resolve." },
];

const ICON: Record<string, IconName> = { ntfy: "phone", tuya: "zap", slack: "hash", webhook: "link", webpush: "monitor" };

const SEVERITIES: Severity[] = ["info", "warning", "error", "critical"];

const DELAYS = [0, 2, 5, 10, 15];
/** A board writes last_seen every five minutes while it is polling. */
const boardOnline = (d: HardwarePager) => d.last_seen_at !== null && Date.now() - d.last_seen_at < 11 * 60_000;

/** Read once and shared, so a section that changes one of these updates the others. */
const loadBoards = () => resource(async () => api().hardwarePagers());
const loadPush = () => resource(pushState);
type Boards = ReturnType<typeof loadBoards>;
type Push = ReturnType<typeof loadPush>;

const delayLabel = (min: number) => (min ? `After ${min} min` : "At once");

function describe(cm: ContactMethod): string {
  const c = cm.config as Record<string, string>;
  switch (cm.type) {
    case "ntfy":
      return `${c.server}/${c.topic}`;
    case "tuya":
      return `Device ${c.device_id}`;
    case "slack":
      return "Slack webhook";
    case "webpush":
      return "This browser, even when Pager is closed";
    default:
      return c.url ?? "";
  }
}

function MethodRow(props: { cm: () => ContactMethod; reload: () => void }) {
  const cm = () => props.cm();
  const name = () => cm().label || cm().type;
  const guard = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
      props.reload();
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    }
  };
  const remove = async () => {
    const action = await AlertDialog.show({
      title: `Remove ${name()}?`,
      description: "It stops getting pages. Its settings are not kept.",
      actions: [
        { label: "Cancel", role: "cancel", id: "cancel" },
        { label: "Remove", role: "destructive", id: "remove" },
      ],
    });
    if (action === "remove") guard(() => api().deleteContactMethod(cm().id));
  };
  return (
    <Row>
      <View class="flex-1 gap-2">
        <View class="flex-row items-center gap-3">
          <Icon name={ICON[cm().type] ?? "bell"} size={16} tint={token("muted-foreground")} />
          <View class="flex-1">
            <Text class="text-sm font-medium text-card-foreground" numberOfLines={1}>{name()}</Text>
            <Text class="text-xs text-muted-foreground" numberOfLines={1}>{describe(cm())}</Text>
            <If when={cm().last_error}>
              <Text class="text-xs text-destructive" numberOfLines={2}>{cm().last_error}</Text>
            </If>
          </View>
          <Switch
            checked={cm().enabled}
            accessibilityLabel={`Page ${name()}`}
            onChange={(checked) => guard(() => api().updateContactMethod(cm().id, { enabled: checked }))}
            trackClass="w-9 rounded-full bg-input p-0.5 transition-colors checked:bg-primary"
            thumbClass="size-4 rounded-full bg-card shadow-sm transition-transform checked:translate-x-4"
          />
        </View>
        <View class="flex-row flex-wrap items-center gap-1.5 pl-7">
          <ActionMenu
            trigger={<MenuBtn title={`${SEV_LABEL[cm().min_severity]} and up`} testID={`severity-${cm().id}`} />}
            items={SEVERITIES.map((s) => ({
              label: `${SEV_LABEL[s]} and up`,
              checked: s === cm().min_severity,
              onSelect: () => guard(() => api().updateContactMethod(cm().id, { min_severity: s })),
            }))}
          />
          <ActionMenu
            trigger={<MenuBtn title={delayLabel(cm().delay_min)} testID={`delay-${cm().id}`} />}
            items={DELAYS.map((min) => ({
              label: delayLabel(min),
              checked: min === cm().delay_min,
              onSelect: () => guard(() => api().updateContactMethod(cm().id, { delay_min: min })),
            }))}
          />
          <Btn title="Send test" variant="ghost" onPress={() => guard(() => api().testContactMethod(cm().id), "Test page sent")} />
          <View class="flex-1" />
          <IconBtn icon="trash" label={`Remove ${name()}`} onPress={remove} />
        </View>
      </View>
    </Row>
  );
}

function AddMethod(props: { open: boolean; onClose: () => void; presets: string[]; onAdded: () => void }) {
  const kind = signal<Kind>("ntfy");
  const label = signal("");
  const a = signal(""); // topic / device id / url
  const b = signal(""); // ntfy server / tuya preset
  const busy = signal(false);
  const tuya = resource(() => (props.open && kind() === "tuya") || null, async () => api().tuyaDevices());

  const config = (): Record<string, unknown> => {
    switch (kind()) {
      case "ntfy":
        return { topic: a(), server: b() || "https://ntfy.sh" };
      case "tuya":
        return { device_id: a(), preset: b() || "auto" };
      case "slack":
        return { webhook_url: a() };
      default:
        return { url: a() };
    }
  };

  const add = async () => {
    busy.set(true);
    try {
      await api().addContactMethod({ type: kind(), label: label(), config: config() });
      label.set("");
      a.set("");
      b.set("");
      props.onAdded();
      props.onClose();
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    } finally {
      busy.set(false);
    }
  };

  return (
    <FormSheet open={props.open} onClose={props.onClose} title="Add contact method">
      <View class="gap-1.5">
        <Segmented options={KINDS} value={kind()} onChange={(v) => (kind.set(v), a.set(""), b.set(""))} />
        <Text class="text-xs text-muted-foreground">{KINDS.find((k) => k.value === kind())!.hint}</Text>
      </View>
      <Field label="Label">
        <Input value={label()} onChange={(value) => label.set(value)} placeholder="Desk siren" class={field} />
      </Field>
      <If when={kind() === "tuya" && tuya()?.configured && tuya()!.devices.length > 0}>
        <Field label="Your devices">
          <Chips
            testID="tuya-devices"
            options={tuya()!.devices.map((d: TuyaDevice) => ({ id: d.id, label: d.online ? d.name : `${d.name} (offline)` }))}
            selected={a() ? [a()] : []}
            onToggle={(id) => {
              a.set(id);
              if (!label()) label.set(tuya()!.devices.find((d: TuyaDevice) => d.id === id)!.name);
            }}
          />
        </Field>
      </If>
      <Field label={kind() === "ntfy" ? "Topic" : kind() === "tuya" ? "Device ID" : "URL"} hint={kind() === "ntfy" ? "Long and random, like pager-alice-7f3k9q." : undefined}>
        <Input value={a()} onChange={(value) => a.set(value)} autoCapitalize="none" autoCorrect={false} placeholder={kind() === "ntfy" || kind() === "tuya" ? "" : "https://…"} class={field} />
      </Field>
      <If when={kind() === "ntfy"}>
        <Field label="Server">
          <Input value={b()} onChange={(value) => b.set(value)} autoCapitalize="none" placeholder="https://ntfy.sh" class={field} />
        </Field>
      </If>
      <If when={kind() === "tuya"}>
        <Field label="Commands" hint="Auto reads what the device can do and rings it as loud as it goes.">
          <Chips testID="tuya-preset" options={props.presets.map((p) => ({ id: p, label: p === "auto" ? "Auto" : p }))} selected={[b() || "auto"]} onToggle={(id) => b.set(id)} />
        </Field>
      </If>
      <Btn title={busy() ? "Adding…" : "Add"} testID="save-method" busy={busy()} disabled={!a()} onPress={add} />
    </FormSheet>
  );
}

/** Web only: page this browser or home-screen app while Pager is closed. Gone once it is on, its row takes over. */
function ThisDevice(props: { methods: ContactMethod[]; push: Push; onAdded: () => void }) {
  const state = props.push;
  const busy = signal(false);
  const paged = () => props.methods.some((m) => m.type === "webpush" && m.config.endpoint === state()?.endpoint);
  const enable = async () => {
    busy.set(true);
    try {
      const sub = await pushEnable((await api().pushKey()).publicKey);
      if (!sub) throw new Error("This browser did not answer.");
      if ("error" in sub) throw new Error(sub.error);
      await api().addContactMethod({ type: "webpush", label: sub.label, config: { endpoint: sub.endpoint, keys: sub.keys } });
      await state.refetch();
      props.onAdded();
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
      // The browser's answer may have changed the permission Alarm check is showing.
      state.refetch();
    } finally {
      busy.set(false);
    }
  };
  return (
    <If when={state()?.supported && !(state()?.endpoint && paged())}>
      <If when={!state()?.ios || state()?.standalone} else={<Callout title="To be paged on this iPhone, add Pager to the Home Screen and open it from there." />}>
        <View class={isDesktop ? "self-start" : ""}>
          <Btn title={busy() ? "Turning on…" : "Page me on this device"} busy={busy()} variant="secondary" icon="monitor" onPress={enable} />
        </View>
      </If>
    </If>
  );
}

/** Would a critical page get through right now? Everything here is something the person can fix. */
function AlarmCheck(props: { methods: ContactMethod[]; boards: Boards; push: Push }) {
  const browser = props.push;
  const live = () => props.methods.filter((m) => m.enabled);
  const failing = () => live().filter((m) => m.last_error);
  const devices = () => props.boards()?.devices ?? [];
  const online = () => devices().filter(boardOnline);
  const offline = () => devices().filter((d) => !boardOnline(d));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const reach = () =>
    [
      ...(live().length ? [plural(live().length, "method", "methods")] : []),
      ...(online().length ? [plural(online().length, "hardware pager", "hardware pagers")] : []),
    ].join(" and ");
  const permission = () => browser()?.permission;
  return (
    <Section title="Alarm check">
      <Surface>
        <Row testID="alarm-reach">
          <Dot tone={reach() ? "ok" : "critical"} />
          <Text class="flex-1 text-sm text-card-foreground">{reach() ? `Critical pages ring ${reach()}` : "Critical pages reach nothing while the app is closed"}</Text>
        </Row>
        {failing().map((m) => (
          <Row testID="alarm-failing">
            <Dot tone="critical" />
            <Text class="flex-1 text-sm text-card-foreground">{`${m.label || m.type}: last delivery failed`}</Text>
          </Row>
        ))}
        {offline().map((d) => (
          <Row testID="alarm-board-offline">
            <Dot tone="critical" />
            <Text class="flex-1 text-sm text-card-foreground">{`${d.name}: not connected, it will not ring`}</Text>
          </Row>
        ))}
        <If when={permission() && permission() !== "unsupported"}>
          <Row testID="alarm-browser">
            <Dot tone={permission() === "granted" ? "ok" : permission() === "denied" ? "critical" : "warning"} />
            <Text class="flex-1 text-sm text-card-foreground">
              {permission() === "granted" ? "This browser may show alarms" : permission() === "denied" ? "This browser blocks alarms: allow notifications for this site" : "This browser has not been asked yet"}
            </Text>
          </Row>
        </If>
        <If when={browser()?.ios && !browser()?.standalone}>
          <Row>
            <Dot tone="warning" />
            <Text class="flex-1 text-sm text-card-foreground">On iPhone, alarms need Pager on the Home Screen</Text>
          </Row>
        </If>
        <If when={props.methods.some((m) => m.type === "ntfy" && m.enabled)}>
          <Row>
            <Dot tone="neutral" />
            <Text class="flex-1 text-sm text-card-foreground">In the ntfy app, turn on Instant delivery and Override Do Not Disturb for this topic</Text>
          </Row>
        </If>
      </Surface>
    </Section>
  );
}

/** T5AI boards that ring on their own: their token is shown once, to type into the serial console. */
function HardwarePagers(props: { list: Boards }) {
  const list = props.list;
  const issued = signal<string | null>(null);
  const busy = signal(false);
  const add = async () => {
    busy.set(true);
    try {
      issued.set((await api().addHardwarePager("T5AI pager")).token);
      list.refetch();
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    } finally {
      busy.set(false);
    }
  };
  const remove = (d: HardwarePager) => api().deleteHardwarePager(d.id).then(() => list.refetch(), (e) => toast(String(e.message ?? e), "error"));
  const test = (d: HardwarePager) => api().testHardwarePager(d.id).then(() => toast(`Test ring sent to ${d.name}`), (e) => toast(String(e.message ?? e), "error"));
  return (
    <Section title="Hardware pagers" count={list()?.devices.length} right={<Btn title="Add" testID="add-board" variant="ghost" icon="plus" busy={busy()} onPress={add} />}>
      <View class="gap-2">
        <If when={issued()}>
          {(t) => (
            <Callout title="Token, shown once. On the board: pager_token">
              <Text class="font-mono text-xs text-foreground" selectable>{t()}</Text>
              <View class="flex-row gap-2">
                <Btn title="Copy token" variant="secondary" icon="copy" onPress={() => Clipboard.writeText(t()).then(() => toast("Token copied"))} />
                <Btn title="Done" variant="ghost" onPress={() => issued.set(null)} />
              </View>
            </Callout>
          )}
        </If>
        <If when={list()?.devices.length}>
          <Surface>
            {list()!.devices.map((d: HardwarePager) => (
              <Row>
                <Dot tone={boardOnline(d) ? "ok" : "critical"} />
                <View class="flex-1 gap-0.5">
                  <Text class="text-sm font-medium text-card-foreground" numberOfLines={1}>{d.name}</Text>
                  <Meta>{boardOnline(d) ? "Online" : d.last_seen_at ? `Last seen ${timeAgo(d.last_seen_at)}` : "Never connected"}{d.firmware ? `  ${d.firmware}` : ""}</Meta>
                </View>
                <If when={boardOnline(d)}>
                  <Btn title="Send test" testID={`test-board-${d.id}`} variant="ghost" onPress={() => test(d)} />
                </If>
                <IconBtn icon="trash" label={`Remove ${d.name}`} onPress={() => remove(d)} />
              </Row>
            ))}
          </Surface>
        </If>
      </View>
    </Section>
  );
}

export function Settings() {
  const methods = resource(async () => api().contactMethods());
  const boards = loadBoards();
  const push = loadPush();
  const adding = signal(false);
  return (
    <Page>
      <Section title="Account">
        <Surface>
          <Row>
            <View class="flex-1 gap-0.5">
              <View class="flex-row items-center gap-1.5">
                <Text class="text-sm font-medium text-card-foreground" numberOfLines={1}>{me()?.name}</Text>
                <If when={me()?.role === "admin"}>
                  <Badge label="Admin" />
                </If>
              </View>
              <Meta>{me()?.email}</Meta>
              <Meta selectable>{session()?.server}</Meta>
            </View>
            <Btn title="Sign out" variant="secondary" onPress={() => signOut()} />
          </Row>
        </Surface>
      </Section>

      {/* Waits for the boards too: until they load, a board-only setup would flash "reach nothing". */}
      <If when={methods() && (boards() || boards.error())}>{() => <AlarmCheck methods={methods()!.contact_methods} boards={boards} push={push} />}</If>

      <Section title="How you get paged" right={<Btn title="Add" testID="add-method" variant="ghost" icon="plus" onPress={() => adding.set(true)} />}>
        <If when={methods()} else={methods.error() ? <Failed error={methods.error()} onRetry={() => methods.refetch()} /> : <Loading />}>
          {(m) => (
            <View class="gap-2">
              <If when={m().contact_methods.length > 0}>
                <Surface>
                  <Each of={m().contact_methods} key={(c: ContactMethod) => c.id}>
                    {(c) => <MethodRow cm={c} reload={() => methods.refetch()} />}
                  </Each>
                </Surface>
              </If>
              <ThisDevice methods={m().contact_methods} push={push} onAdded={() => methods.refetch()} />
              <AddMethod open={adding()} onClose={() => adding.set(false)} presets={m().tuya_presets} onAdded={() => methods.refetch()} />
            </View>
          )}
        </If>
      </Section>

      <HardwarePagers list={boards} />
    </Page>
  );
}
