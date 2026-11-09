import { resource, Text, View } from "nsh";
import type { OnCall as OnCallData, Shift } from "../api";
import { api, me } from "../store";
import { toast } from "../toast";
import { ActionMenu, Badge, clock, Empty, Failed, Loading, MenuBtn, Meta, Page, Row, Surface, until } from "../ui";

type Sched = OnCallData["schedules"][number];

function NextShift(props: { shift: () => Shift }) {
  return (
    <Row>
      <Text class="flex-1 text-sm text-card-foreground" numberOfLines={1}>
        {props.shift().user?.name ?? "Unknown"}
      </Text>
      <Meta>{clock(props.shift().starts_at)}</Meta>
    </Row>
  );
}

function Schedule(props: { schedule: () => Sched; reload: () => void }) {
  const s = () => props.schedule();
  const mine = () => s().current?.user_id === me()?.id;
  const take = async (ms: number | "shift") => {
    const start = Date.now();
    const end = ms === "shift" ? (s().current?.ends_at ?? start + 3_600_000) : start + ms;
    try {
      await api().takeShift(s().id, start, end);
      props.reload();
      toast(`You are on call for ${s().name}`);
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    }
  };
  return (
    <Surface>
      <View class="flex-row items-center gap-3 p-3">
        <View class="flex-1 gap-1">
          <Meta>{s().name}</Meta>
          <View class="flex-row items-center gap-1.5">
            <Text class="text-lg font-semibold text-card-foreground" numberOfLines={1}>
              {s().current?.user?.name ?? "Nobody"}
            </Text>
            {mine() && <Badge label="You" />}
            {s().current?.override && <Badge label="Override" />}
          </View>
          {s().current && <Meta>Ends in {until(s().current!.ends_at)}</Meta>}
        </View>
        <If when={!mine()}>
          <ActionMenu
            trigger={<MenuBtn title="Take over" testID={`take-over-${s().id}`} />}
            items={[
              { label: "For 1 hour", onSelect: () => take(3_600_000) },
              { label: "For 4 hours", onSelect: () => take(4 * 3_600_000) },
              { label: "Until the shift ends", onSelect: () => take("shift") },
            ]}
          />
        </If>
      </View>
      <Each of={s().next.slice(0, 4)} key="index">
        {(n) => <NextShift shift={n} />}
      </Each>
    </Surface>
  );
}

export function OnCall() {
  const data = resource(async () => api().oncall());
  return (
    <Page>
      <If when={data()} else={data.error() ? <Failed error={data.error()} onRetry={() => data.refetch()} /> : <Loading />}>
        {(d) => (
          <If
            when={d().schedules.length > 0}
            else={<Empty icon="calendar" title="No rotations" hint={me()?.role === "admin" ? "Create one in Admin." : "An admin can create one."} />}
          >
            <View class="gap-3">
              <Each of={d().schedules} key={(s: Sched) => s.id}>
                {(s) => <Schedule schedule={s} reload={() => data.refetch()} />}
              </Each>
            </View>
          </If>
        )}
      </If>
    </Page>
  );
}
