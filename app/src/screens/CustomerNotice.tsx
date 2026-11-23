// Telling customers what is happening. Only the words typed here leave the pager; see docs/alarm-permissions.md.
import { resource, signal, Text, View } from "nsh";
import { AlertDialog, Input } from "nsh/base";
import { api } from "../store";
import { toast } from "../toast";
import { Btn, Callout, clock, Failed, Field, field, FormSheet, Loading, Meta } from "../ui";

export function CustomerNotice(props: { id: string; open: boolean; onClose: () => void; onSent: () => void }) {
  const info = resource(() => (props.open ? props.id : null), (id: string) => api().customerNotices(id));
  const text = signal("");
  const busy = signal(false);
  const people = (n: number) => `${n} ${n === 1 ? "customer" : "customers"}`;

  const send = async (audience: number, live: boolean) => {
    const { action: answer } = await AlertDialog.show({
      title: live ? `Send to ${people(audience)}?` : "Run a dry run?",
      description: live ? "This can't be taken back." : `Nobody is contacted. The timeline records that ${people(audience)} would have been.`,
      actions: [
        { label: "Cancel", role: "cancel", id: "cancel" },
        { label: live ? "Send" : "Dry run", role: live ? "destructive" : undefined, id: "send" },
      ],
    });
    if (answer !== "send") return;
    busy.set(true);
    try {
      const r = await api().sendCustomerNotice(props.id, text().trim());
      text.set("");
      toast(r.dry_run ? `Dry run: ${people(r.audience)} would be told` : `Sent to ${people(r.audience)}`);
      props.onClose();
      props.onSent();
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    } finally {
      busy.set(false);
    }
  };

  return (
    <FormSheet open={props.open} onClose={props.onClose} title="Notify customers">
      <If when={info()} else={info.error() ? <Failed error={info.error()} onRetry={() => info.refetch()} /> : <Loading />}>
        {(d) => (
          <View class="gap-4">
            <If when={!d().live}>
              <Callout title="Dry run: customer notices are switched off, nobody is contacted." />
            </If>
            <Field label="Message" hint="Customers see this and the service name, nothing else.">
              <Input testID="notice-message" value={text()} onChange={({ value }) => text.set(value)} multiline placeholder="Checkout is failing for some customers. We are working on it." class={field} />
            </Field>
            <If when={d().audience > 0} else={<Callout tone="critical" title="No customers are listed for this service. Add them in Admin." />}>
              <Btn title={d().live ? `Send to ${people(d().audience)}` : `Dry run for ${people(d().audience)}`} busy={busy()} disabled={!text().trim() || !d().allowed} onPress={() => send(d().audience, d().live)} />
            </If>
            {d().notices.map((n) => (
              <View class="gap-0.5">
                <Meta>{`${clock(n.created_at)}  ${n.dry_run ? "Dry run" : people(n.audience)}`}</Meta>
                <Text class="text-sm text-card-foreground select-text">{n.message}</Text>
              </View>
            ))}
          </View>
        )}
      </If>
    </FormSheet>
  );
}
