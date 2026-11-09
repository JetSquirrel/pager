// The app's components, following the NSH design guides: semantic tokens only, one type and spacing scale,
// 32 pt controls with a pointer, 44 pt targets on touch screens.
import { platform, safeArea, Scroll, Text, token, View, windowSize } from "nsh";
import type { JSX } from "nsh/types";
import { Button, Menu, MenuItem, Sheet, Tab, Tabs, Tooltip } from "nsh/base";
import type { Severity, Status } from "./api";
import { Icon, type IconName } from "./icons";

export { Icon, type IconName } from "./icons";

/** A pointer and a keyboard: compact controls. */
export const isDesktop = platform.idiom === "desktop" || platform.idiom === "mac";
/** Wide enough for the sidebar. */
export const wide = () => windowSize().width >= 720;
/** Wide enough for the incident list and the incident side by side. */
export const split = () => windowSize().width >= 1040;

// ------------------------------------------------------------------ time

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function until(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((ms - now) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

// ------------------------------------------------------------------ state marks

export type Tone = "neutral" | Severity | "ok";

const DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  critical: "bg-sev-critical",
  error: "bg-sev-error",
  warning: "bg-sev-warning",
  info: "bg-sev-info",
  ok: "bg-ok",
};

const INK: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  critical: "text-sev-critical",
  error: "text-sev-error",
  warning: "text-sev-warning",
  info: "text-sev-info",
  ok: "text-ok",
};

const TINT: Record<Tone, string> = {
  neutral: "bg-muted",
  critical: "bg-sev-critical/10",
  error: "bg-sev-error/10",
  warning: "bg-sev-warning/10",
  info: "bg-sev-info/10",
  ok: "bg-ok/10",
};

export const SEV_LABEL: Record<Severity, string> = { critical: "Critical", error: "Error", warning: "Warning", info: "Info" };

const STATUS_TONE: Record<Status, Tone> = { triggered: "critical", acknowledged: "warning", resolved: "ok" };
const STATUS_LABEL: Record<Status, string> = { triggered: "Triggered", acknowledged: "Acknowledged", resolved: "Resolved" };

export function Dot(props: { tone: Tone }) {
  return <View class={`size-2 rounded-full ${DOT[props.tone]}`} />;
}

/** A severity's dot and word: color alone never carries the state. */
export function SeverityMark(props: { severity: Severity }) {
  return (
    <View class="flex-row items-center gap-1.5">
      <Dot tone={props.severity} />
      <Text class={`text-xs font-medium ${INK[props.severity]}`}>{SEV_LABEL[props.severity]}</Text>
    </View>
  );
}

export function Badge(props: { label: string; tone?: Tone }) {
  const tone = () => props.tone ?? "neutral";
  return (
    <View class={`self-start rounded-md px-1.5 py-0.5 ${TINT[tone()]}`}>
      <Text class={`text-xs font-medium ${INK[tone()]}`}>{props.label}</Text>
    </View>
  );
}

export const StatusBadge = (props: { status: Status }) => <Badge label={STATUS_LABEL[props.status]} tone={STATUS_TONE[props.status]} />;

/** Secondary text. */
export function Meta(props: { children: JSX.Element; selectable?: boolean }) {
  return (
    <Text class="text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }} selectable={props.selectable}>
      {props.children}
    </Text>
  );
}

// ------------------------------------------------------------------ controls

const CONTROL = isDesktop ? "min-h-8" : "min-h-11";
const FOCUS = "focus-visible:ring-2 focus-visible:ring-ring";

type Variant = "primary" | "secondary" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary hover:bg-primary/90 active:bg-primary/80",
  secondary: "border border-input bg-card hover:bg-accent active:bg-accent",
  ghost: "hover:bg-accent active:bg-accent",
};

/** Label sizes: a pointer's denser type, a thumb's larger one. */
const LABEL = isDesktop ? "text-sm" : "text-base";

export function Tip(props: { label: string }) {
  return (
    <Tooltip placement="bottom" class="rounded-md border border-border bg-popover px-2 py-1">
      <Text class="text-xs text-popover-foreground">{props.label}</Text>
    </Tooltip>
  );
}

export function Btn(props: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  grow?: boolean;
  /** The quieter label of a button repeated down a list. */
  compact?: boolean;
  testID?: string;
}) {
  const v = () => props.variant ?? "primary";
  return (
    <Button
      testID={props.testID}
      onPress={() => !props.busy && props.onPress()}
      disabled={props.disabled}
      accessibilityLabel={props.title}
      class={`flex-row items-center justify-center gap-1.5 rounded-(--radius) px-3 disabled:opacity-50 ${CONTROL} ${FOCUS} ${VARIANT[v()]}`}
      style={props.grow ? { flex: 1 } : undefined}
    >
      <If when={props.busy} else={props.icon && <Icon name={props.icon} size={15} tint={token(v() === "primary" ? "primary-foreground" : "foreground")} />}>
        <View class={`size-3.5 rounded-full border-2 animate-spin ${v() === "primary" ? "border-primary-foreground/30 border-t-primary-foreground" : "border-foreground/20 border-t-foreground"}`} />
      </If>
      <Text class={`font-medium ${props.compact ? "text-sm" : LABEL} ${v() === "primary" ? "text-primary-foreground" : "text-foreground"}`}>{props.title}</Text>
    </Button>
  );
}

export function IconBtn(props: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
  return (
    <Button
      testID={props.testID}
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      tooltip={isDesktop ? <Tip label={props.label} /> : undefined}
      class={`items-center justify-center rounded-(--radius) hover:bg-accent active:bg-accent disabled:opacity-50 ${isDesktop ? "size-8" : "size-11"} ${FOCUS}`}
    >
      <Icon name={props.icon} size={isDesktop ? 16 : 20} tint={token("muted-foreground")} />
    </Button>
  );
}

/** The trigger of a menu: looks like a secondary button, and says it opens something. */
export function MenuBtn(props: { title: string; testID?: string; icon?: IconName }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.title}
      class={`flex-row items-center gap-1.5 self-start rounded-(--radius) border border-input bg-card px-3 hover:bg-accent active:bg-accent ${CONTROL} ${FOCUS}`}
    >
      {props.icon && <Icon name={props.icon} size={15} tint={token("foreground")} />}
      <Text class={`font-medium text-foreground ${LABEL}`}>{props.title}</Text>
      <Icon name="down" size={13} tint={token("muted-foreground")} />
    </View>
  );
}

export type MenuAction = { label: string; onSelect: () => void; checked?: boolean };

/** A compact list of actions: a popup with a pointer, a sheet on touch screens. */
export function ActionMenu(props: { trigger: JSX.Element; items: MenuAction[] }) {
  return (
    <Menu
      align="start"
      offset={4}
      margin={8}
      trigger={props.trigger}
      backdropClass="bg-scrim"
      popupClass={
        isDesktop
          ? "min-w-44 rounded-(--radius) border border-border bg-popover p-1 shadow-lg"
          : "rounded-t-xl bg-popover p-2"
      }
      popupStyle={isDesktop ? undefined : { paddingBottom: safeArea().bottom + 8 }}
    >
      {props.items.map((item) => (
        <MenuItem onSelect={item.onSelect} class={`flex-row items-center gap-2 rounded-md px-2 hover:bg-accent active:bg-accent focus-visible:bg-accent ${CONTROL}`}>
          <Text class={`flex-1 text-popover-foreground ${LABEL}`}>{item.label}</Text>
          {item.checked && <Icon name="check" size={15} tint={token("foreground")} />}
        </MenuItem>
      ))}
    </Menu>
  );
}

/** One choice among a few short options. Stretches on touch screens, hugs its labels with a pointer. */
export function Segmented<T extends string>(props: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; testID?: string }) {
  return (
    <Tabs testID={props.testID} class={`flex-row gap-0.5 rounded-(--radius) bg-muted p-0.5 ${isDesktop ? "self-start" : ""}`}>
      {props.options.map((o) => (
        <Tab
          selected={props.value === o.value}
          onPress={() => props.onChange(o.value)}
          class={`group items-center justify-center rounded-md hover:bg-accent selected:bg-card ${isDesktop ? "min-h-7 px-3" : "min-h-10 flex-1 px-1"} ${FOCUS}`}
        >
          <Text class="text-sm font-medium text-muted-foreground group-selected:text-foreground" numberOfLines={1}>
            {o.label}
          </Text>
        </Tab>
      ))}
    </Tabs>
  );
}

/** Toggle pills. Several selected show their order, which is what a rotation or an escalation step uses. */
export function Chips(props: {
  testID?: string;
  options: { id: string; label: string; icon?: IconName }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const on = (id: string) => props.selected.includes(id);
  return (
    <View testID={props.testID} class="flex-row flex-wrap gap-1.5">
      {props.options.map((o) => (
        <Button
          onPress={() => props.onToggle(o.id)}
          selected={on(o.id)}
          class={`flex-row items-center gap-1.5 rounded-full border px-3 ${isDesktop ? "min-h-7" : "min-h-11"} ${FOCUS} ${on(o.id) ? "border-primary bg-primary" : "border-input bg-card hover:bg-accent active:bg-accent"}`}
        >
          {o.icon && <Icon name={o.icon} size={13} tint={token(on(o.id) ? "primary-foreground" : "muted-foreground")} />}
          <Text class={`text-sm ${on(o.id) ? "text-primary-foreground" : "text-foreground"}`}>
            {on(o.id) && props.selected.length > 1 ? `${props.selected.indexOf(o.id) + 1}. ` : ""}
            {o.label}
          </Text>
        </Button>
      ))}
    </View>
  );
}

/** The classes of an Input. */
export const field = `rounded-(--radius) border border-input bg-background px-2.5 text-foreground placeholder:text-muted-foreground focus:border-ring ${
  isDesktop ? "min-h-8 py-1.5 text-sm" : "min-h-11 py-2.5 text-base"
}`;

/** A form field: its label above, help or an error below. */
export function Field(props: { label: string; hint?: string; error?: string | null; children: JSX.Element }) {
  return (
    <View class="gap-1.5">
      <Text class="text-sm font-medium text-foreground">{props.label}</Text>
      {props.children}
      <If when={props.error}>
        <Text class="text-xs text-destructive">{props.error}</Text>
      </If>
      <If when={props.hint}>
        <Text class="text-xs text-muted-foreground">{props.hint}</Text>
      </If>
    </View>
  );
}

// ------------------------------------------------------------------ surfaces

/** A scrolling page with a readable width. */
export function Page(props: { children: JSX.Element }) {
  return (
    <Scroll class="flex-1 bg-background">
      <View class={`w-full max-w-3xl gap-6 self-center ${isDesktop ? "p-4" : "p-3"}`}>{props.children}</View>
    </Scroll>
  );
}

/** The bar at the top of a pane. */
export function Header(props: { title: string; onBack?: () => void; right?: JSX.Element }) {
  return (
    <View class="border-b border-border bg-background pt-[env(safe-area-inset-top)]">
      <View class={`flex-row items-center gap-1 ${props.onBack ? "pl-1 pr-3" : "px-4"} ${isDesktop ? "min-h-12" : "min-h-14"}`}>
        {props.onBack && <IconBtn icon="back" label="Back" onPress={props.onBack} />}
        <Text class="flex-1 text-base font-semibold text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.right}
      </View>
    </View>
  );
}

/** A titled group on a page, `right` at its trailing edge. */
export function Section(props: { title: string; count?: number; right?: JSX.Element; children: JSX.Element }) {
  return (
    <View class="gap-2">
      <View class="min-h-7 flex-row items-center gap-2 px-1">
        <Text class="text-sm font-semibold text-foreground">{props.title}</Text>
        <If when={props.count !== undefined}>
          <Meta>{props.count}</Meta>
        </If>
        <View class="flex-1" />
        {props.right}
      </View>
      {props.children}
    </View>
  );
}

/** The one flat surface a group of rows sits on. */
export function Surface(props: { children: JSX.Element }) {
  return <View class="overflow-hidden rounded-(--radius) border border-border bg-card">{props.children}</View>;
}

/** A row of a Surface, a hairline above all but the first. */
export function Row(props: { onPress?: () => void; selected?: boolean; label?: string; testID?: string; children: JSX.Element }) {
  return (
    <View
      testID={props.testID}
      onPress={props.onPress}
      role={props.onPress ? "button" : undefined}
      accessibilityLabel={props.label}
      accessibilityState={props.onPress ? { selected: !!props.selected } : undefined}
      class={`flex-row items-center gap-3 border-t border-border px-3 py-2.5 first:border-t-0 ${isDesktop ? "min-h-10" : "min-h-12"} ${props.selected ? "bg-accent" : props.onPress ? "hover:bg-accent/60 active:bg-accent" : ""}`}
    >
      {props.children}
    </View>
  );
}

/** A label and its value, on one row. */
export function Fact(props: { label: string; testID?: string; children: JSX.Element }) {
  return (
    <Row testID={props.testID}>
      <Text class="w-24 text-sm text-muted-foreground">{props.label}</Text>
      <View class="flex-1">{props.children}</View>
    </Row>
  );
}

export const Value = (props: { children: JSX.Element }) => <Text class="text-sm text-card-foreground">{props.children}</Text>;

/** A notice that needs attention, with what to do about it. */
export function Callout(props: { tone?: "critical" | "warning"; title: string; children?: JSX.Element }) {
  const tone = () => props.tone ?? "warning";
  return (
    <View class={`flex-row items-start gap-2.5 rounded-(--radius) border border-border p-3 ${TINT[tone()]}`}>
      <View class="pt-0.5">
        <Icon name="alert" size={15} tint={token(tone() === "critical" ? "sev-critical" : "sev-warning")} />
      </View>
      <View class="flex-1 gap-2">
        <Text class="text-sm font-medium text-foreground">{props.title}</Text>
        {props.children}
      </View>
    </View>
  );
}

export function Empty(props: { title: string; hint?: string; icon?: IconName; children?: JSX.Element }) {
  return (
    <View class="items-center gap-1.5 px-4 py-8">
      {props.icon && <Icon name={props.icon} size={22} tint={token("muted-foreground")} />}
      <Text class="text-sm font-medium text-foreground">{props.title}</Text>
      {props.hint && <Text class="text-center text-sm text-muted-foreground">{props.hint}</Text>}
      {props.children}
    </View>
  );
}

export function Loading() {
  return (
    <View class="items-center py-10">
      <View class="size-5 rounded-full border-2 border-foreground/15 border-t-muted-foreground animate-spin" accessibilityLabel="Loading" />
    </View>
  );
}

export function Failed(props: { error: unknown; onRetry: () => void }) {
  return (
    <Empty icon="alert" title="Couldn't load this" hint={String((props.error as Error)?.message ?? props.error)}>
      <View class="pt-2">
        <Btn title="Try again" variant="secondary" onPress={props.onRetry} />
      </View>
    </Empty>
  );
}

/** A longer task beside the page: from the right in a wide window, from the bottom on a phone. */
export function FormSheet(props: { open: boolean; onClose: () => void; title: string; children: JSX.Element }) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      side={wide() ? "right" : "bottom"}
      backdropClass="bg-scrim"
      popupClass={wide() ? "w-96 border-l border-border bg-card" : "max-h-[88%] rounded-t-xl bg-card"}
    >
      {/* A bottom sheet sizes to its content, so nothing here may depend on flex-1 unless it is full height. */}
      <View class={wide() ? "flex-1 pt-[env(safe-area-inset-top)]" : "shrink"}>
        <View class={`flex-row items-center border-b border-border pl-4 pr-1 ${isDesktop ? "min-h-12" : "min-h-14"}`}>
          <Text class="flex-1 text-base font-semibold text-card-foreground">{props.title}</Text>
          <IconBtn icon="close" label="Close" onPress={props.onClose} />
        </View>
        <Scroll class={wide() ? "flex-1" : "shrink grow-0"}>
          <View class="gap-4 p-4" style={{ paddingBottom: safeArea().bottom + 16 }}>{props.children}</View>
        </Scroll>
      </View>
    </Sheet>
  );
}
