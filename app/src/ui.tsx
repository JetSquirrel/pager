// Shared look: buttons, badges, cards, time formatting.
import { platform, Text, View } from "nsh";
import type { JSX } from "nsh/types";
import { Button } from "nsh/base";
import type { Severity, Status } from "./api";

/** Desktop behavior: macOS, Windows, Linux, and browsers with a mouse and a wide window. */
export const isDesktop = platform.idiom === "desktop";

export const SEV_COLOR: Record<Severity, string> = {
  critical: "#dc2626",
  error: "#ea580c",
  warning: "#ca8a04",
  info: "#2563eb",
};

export const STATUS_COLOR: Record<Status, string> = {
  triggered: "#dc2626",
  acknowledged: "#ca8a04",
  resolved: "#16a34a",
};

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
  return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

export function Pill(props: { label: string; color: string }) {
  return (
    <View class="self-start rounded-full px-2 py-0.5" style={{ backgroundColor: props.color + "22" }}>
      <Text class="text-xs font-semibold uppercase" style={{ color: props.color }}>
        {props.label}
      </Text>
    </View>
  );
}

type Variant = "primary" | "danger" | "success" | "ghost";

const VARIANT: Record<Variant, { bg: string; fg: string }> = {
  primary: { bg: "bg-primary active:bg-primary/80 disabled:opacity-50", fg: "text-primary-foreground" },
  danger: { bg: "bg-destructive active:opacity-80 disabled:opacity-50", fg: "text-white" },
  success: { bg: "bg-ok active:opacity-80 disabled:opacity-50", fg: "text-white" },
  ghost: { bg: "border border-border bg-background active:bg-muted disabled:opacity-50", fg: "text-foreground" },
};

export function Btn(props: { title: string; onPress: () => void; variant?: Variant; disabled?: boolean; grow?: boolean }) {
  const v = VARIANT[props.variant ?? "primary"];
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      class={`items-center rounded-(--radius) px-4 py-3 ${v.bg}`}
      style={props.grow ? { flex: 1 } : undefined}
    >
      <Text class={`text-base font-semibold ${v.fg}`}>{props.title}</Text>
    </Button>
  );
}

export function Card(props: { children: JSX.Element; onPress?: () => void }) {
  return (
    <View
      onPress={props.onPress}
      role={props.onPress ? "button" : undefined}
      class="gap-2 rounded-xl border border-border bg-card p-4 active:bg-muted"
    >
      {props.children}
    </View>
  );
}

export function SectionTitle(props: { title: string }) {
  return <Text class="px-1 pt-4 text-sm font-semibold uppercase text-muted-foreground">{props.title}</Text>;
}

export function Empty(props: { title: string; hint?: string }) {
  return (
    <View class="items-center gap-1 py-12">
      <Text class="text-lg font-semibold text-foreground">{props.title}</Text>
      {props.hint && <Text class="text-center text-muted-foreground">{props.hint}</Text>}
    </View>
  );
}
