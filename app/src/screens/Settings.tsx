import { resource, Scroll, signal, Text, View } from "nsh";
import { AlertDialog, Input, Switch, Tab, Tabs } from "nsh/base";
import type { ContactMethod, Severity } from "../api";
import { api, me, session, signOut } from "../store";
import { toast } from "../toast";
import { Btn, SectionTitle } from "../ui";

const field = "rounded-(--radius) border border-border bg-background px-3 py-2.5 text-foreground placeholder:text-muted-foreground";

type Kind = ContactMethod["type"];

const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "ntfy", label: "Push", hint: "Phone & desktop push through the ntfy app (iOS, Android, web). Install ntfy and subscribe to the topic." },
  { value: "tuya", label: "Tuya", hint: "A Tuya siren, smart plug or light that goes off when you're paged and stops when acknowledged." },
  { value: "slack", label: "Slack", hint: "A Slack incoming-webhook URL." },
  { value: "webhook", label: "Webhook", hint: "POSTs JSON to your URL on page, acknowledge and resolve." },
];

const SEVERITIES: Severity[] = ["info", "warning", "error", "critical"];

function describe(cm: ContactMethod): string {
  const c = cm.config as Record<string, string>;
  switch (cm.type) {
    case "ntfy":
      return `${c.server}/${c.topic}`;
    case "tuya":
      return `device ${c.device_id}`;
    case "slack":
      return "Slack webhook";
    default:
      return c.url ?? "";
  }
}

function MethodRow(props: { cm: () => ContactMethod; reload: () => void }) {
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
      title: "Remove this contact method?",
      actions: [
        { label: "Cancel", role: "cancel", id: "cancel" },
        { label: "Remove", role: "destructive", id: "remove" },
      ],
    });
    if (action === "remove") guard(() => api().deleteContactMethod(props.cm().id));
  };
  const cycleSeverity = () => {
    const next = SEVERITIES[(SEVERITIES.indexOf(props.cm().min_severity) + 1) % SEVERITIES.length];
    guard(() => api().updateContactMethod(props.cm().id, { min_severity: next }));
  };
  return (
    <View class="gap-2 rounded-xl border border-border bg-card p-4">
      <Switch
        checked={props.cm().enabled}
        onChange={(checked) => guard(() => api().updateContactMethod(props.cm().id, { enabled: checked }))}
        class="flex-row items-center gap-3"
        trackClass="w-11 rounded-full bg-muted p-0.5 transition-colors checked:bg-primary"
        thumbClass="size-5 rounded-full bg-background shadow-sm transition-transform checked:translate-x-5"
      >
        <View class="flex-1">
          <Text class="font-semibold text-card-foreground">{props.cm().label || props.cm().type}</Text>
          <Text class="text-sm text-muted-foreground" numberOfLines={1}>
            {props.cm().type} · {describe(props.cm())}
          </Text>
        </View>
      </Switch>
      <View class="flex-row flex-wrap gap-2">
        <Btn title="Send test" variant="ghost" onPress={() => guard(() => api().testContactMethod(props.cm().id), "Test page sent")} />
        <Btn title={`Pages: ${props.cm().min_severity}+`} variant="ghost" onPress={cycleSeverity} />
        <Btn title="Remove" variant="ghost" onPress={remove} />
      </View>
    </View>
  );
}

function AddMethod(props: { presets: string[]; onAdded: () => void }) {
  const kind = signal<Kind>("ntfy");
  const label = signal("");
  const a = signal(""); // topic / device id / url
  const b = signal(""); // ntfy server / tuya preset
  const busy = signal(false);

  const config = (): Record<string, unknown> => {
    switch (kind()) {
      case "ntfy":
        return { topic: a(), server: b() || "https://ntfy.sh" };
      case "tuya":
        return { device_id: a(), preset: b() || "siren" };
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
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    } finally {
      busy.set(false);
    }
  };

  return (
    <View class="gap-3 rounded-xl border border-border bg-card p-4">
      <Tabs class="flex-row self-start gap-1 rounded-lg bg-muted p-1">
        {KINDS.map((k) => (
          <Tab selected={kind() === k.value} onPress={() => (kind.set(k.value), a.set(""), b.set(""))} class="group rounded-(--radius) px-3 py-1.5 selected:bg-background">
            <Text class="text-sm text-muted-foreground group-selected:text-foreground">{k.label}</Text>
          </Tab>
        ))}
      </Tabs>
      <Text class="text-sm text-muted-foreground">{KINDS.find((k) => k.value === kind())!.hint}</Text>

      <Input value={label()} onChange={(value) => label.set(value)} placeholder="Label (e.g. Desk siren)" class={field} />
      <Input
        value={a()}
        onChange={(value) => a.set(value)}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={
          kind() === "ntfy" ? "Topic (long and random, e.g. pager-alice-7f3k9q)" : kind() === "tuya" ? "Tuya device id" : "https://…"
        }
        class={field}
      />
      {kind() === "ntfy" && (
        <Input value={b()} onChange={(value) => b.set(value)} autoCapitalize="none" placeholder="Server (default https://ntfy.sh)" class={field} />
      )}
      {kind() === "tuya" && (
        <View class="flex-row flex-wrap gap-2">
          {props.presets.map((p) => (
            <Btn title={p} variant={(b() || "siren") === p ? "primary" : "ghost"} onPress={() => b.set(p)} />
          ))}
        </View>
      )}
      <Btn title={busy() ? "Adding…" : "Add contact method"} disabled={busy() || !a()} onPress={add} />
    </View>
  );
}

export function Settings() {
  const methods = resource(async () => api().contactMethods());
  return (
    <Scroll class="flex-1 bg-background">
      <View class="w-full max-w-3xl gap-3 self-center p-4">
        <View class="gap-1 rounded-xl border border-border bg-card p-4">
          <Text class="text-lg font-semibold text-card-foreground">{me()?.name}</Text>
          <Text class="text-muted-foreground">
            {me()?.email} · {me()?.role}
          </Text>
          <Text class="text-sm text-muted-foreground">{session()?.server}</Text>
        </View>

        <SectionTitle title="How you get paged" />
        <If when={methods()} else={<Text class="text-muted-foreground">{methods.error() ? String(methods.error()) : "Loading…"}</Text>}>
          {(m) => (
            <>
              <If when={m().contact_methods.length > 0} else={<Text class="px-1 text-destructive">No contact methods: you will only see pages while this app is open.</Text>}>
                <Each of={m().contact_methods} key={(c: ContactMethod) => c.id}>
                  {(c) => <MethodRow cm={c} reload={() => methods.refetch()} />}
                </Each>
              </If>
              <SectionTitle title="Add" />
              <AddMethod presets={m().tuya_presets} onAdded={() => methods.refetch()} />
            </>
          )}
        </If>

        <View class="pt-6">
          <Btn title="Sign out" variant="ghost" onPress={() => signOut()} />
        </View>
      </View>
    </Scroll>
  );
}
