// In-app toasts for new pages (nsh/base ToastStack, following the NSH docs' pattern).
import { Overlay, safeArea, signal, Text, View } from "nsh";
import { Toast, type ToastEntry, ToastManager, ToastStack } from "nsh/base";
import type { Severity } from "./api";
import { Dot } from "./ui";

type Value = { title: string; severity: Severity };

const manager = new ToastManager();
const shown = signal<ToastEntry[]>([]);
const expanded = signal(false);
const sync = () => shown.set(manager.visible(3));

setInterval(() => {
  if (manager.advance(expanded()).changed) sync();
}, 50);

export function toast(title: string, severity: Severity = "info") {
  manager.push(crypto.randomUUID(), { title, severity } satisfies Value, { timeout: severity === "critical" ? 15000 : 6000 });
  sync();
}

export function Toaster() {
  return (
    <Overlay class="inset-x-0 top-0 items-center p-4" style={{ paddingTop: safeArea().top + 8 }}>
      <ToastStack
        placement="topCenter"
        class="w-80"
        onExpandedChange={(e) => expanded.set(e)}
        onCancel={() => {
          const newest = shown().filter((t) => t.status !== "ending").at(-1);
          if (newest) {
            manager.dismiss(newest.id);
            sync();
          }
        }}
      >
        <Each of={shown()} key={(t: ToastEntry) => t.id}>
          {(t) => (
            <Toast
              transitionStatus={t().status}
              accessibilityLabel={(t().value as Value).title}
              onDismissRequest={() => {
                manager.dismiss(t().id);
                sync();
              }}
              class="flex-row items-center gap-2.5 rounded-(--radius) border border-border bg-popover px-3 py-2.5 shadow-lg transition-all duration-200"
              startingClass="opacity-0 -translate-y-4"
              endingClass="opacity-0 scale-95"
            >
              <Dot tone={(t().value as Value).severity} />
              <Text class="flex-1 text-sm font-medium text-popover-foreground" numberOfLines={2}>
                {(t().value as Value).title}
              </Text>
            </Toast>
          )}
        </Each>
      </ToastStack>
    </Overlay>
  );
}
