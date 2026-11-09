import { resource, Scroll, Text, View } from "nsh";
import { AlertDialog } from "nsh/base";
import type { OnCall as OnCallData, Shift } from "../api";
import { api, me } from "../store";
import { toast } from "../toast";
import { Btn, clock, Empty, SectionTitle, until } from "../ui";

type Sched = OnCallData["schedules"][number];

function ShiftLine(props: { shift: () => Shift }) {
  return (
    <View class="flex-row justify-between gap-2">
      <Text class="text-card-foreground">{props.shift().user?.name ?? "unknown"}</Text>
      <Text class="text-muted-foreground">{clock(props.shift().starts_at)}</Text>
    </View>
  );
}

export function OnCall() {
  const data = resource(async () => api().oncall());

  const takeOver = async (s: Sched) => {
    const action = await AlertDialog.show({
      title: `Take over ${s.name}?`,
      description: "You will be on call instead of the current person.",
      actions: [
        { label: "For 1 hour", id: "1" },
        { label: "For 4 hours", id: "4" },
        { label: "Until the shift ends", id: "shift" },
        { label: "Cancel", role: "cancel", id: "cancel" },
      ],
    });
    if (!action || action === "cancel") return;
    const start = Date.now();
    const end = action === "shift" ? (s.current?.ends_at ?? start + 3_600_000) : start + Number(action) * 3_600_000;
    try {
      await api().takeShift(s.id, start, end);
      data.refetch();
      toast(`You are on call for ${s.name}`);
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    }
  };

  return (
    <Scroll class="flex-1 bg-background">
      <View class="w-full max-w-3xl gap-3 self-center p-4">
        <If when={data()} else={<Text class="p-2 text-muted-foreground">{data.error() ? String(data.error()) : "Loading…"}</Text>}>
          {(d) => (
            <If when={d().schedules.length > 0} else={<Empty title="No schedules" hint="An admin can create one with the API." />}>
              <Each of={d().schedules} key={(s: Sched) => s.id}>
                {(s) => (
                  <View class="gap-2 rounded-xl border border-border bg-card p-4">
                    <Text class="text-sm font-semibold uppercase text-muted-foreground">{s().name}</Text>
                    <View class="flex-row items-center gap-2">
                      <Text class="flex-1 text-xl font-bold text-card-foreground">
                        {s().current?.user?.name ?? "Nobody"}
                        {s().current?.user_id === me()?.id ? " (you)" : ""}
                      </Text>
                      {s().current?.override && <Text class="text-xs text-muted-foreground">override</Text>}
                    </View>
                    {s().current && <Text class="text-muted-foreground">for {until(s().current!.ends_at)} more</Text>}
                    {s().current?.user_id !== me()?.id && <Btn title="Take over" variant="ghost" onPress={() => takeOver(s())} />}
                    <If when={s().next.length > 0}>
                      <SectionTitle title="Next" />
                      <Each of={s().next.slice(0, 4)} key="index">
                        {(n) => <ShiftLine shift={n} />}
                      </Each>
                    </If>
                  </View>
                )}
              </Each>
            </If>
          )}
        </If>
      </View>
    </Scroll>
  );
}
