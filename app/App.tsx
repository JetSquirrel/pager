// Pager — the on-call client for iOS, Android, macOS, Windows, Linux and the web, from one NSH TSX codebase.
import { computed, effect, mount, signal, Text, token, View } from "nsh";
import { createNavStack, NavPage, NavStack, Tab, Tabs } from "nsh/base";
import { Admin } from "./src/screens/Admin";
import { IncidentDetail } from "./src/screens/IncidentDetail";
import { Incidents, LiveStatus } from "./src/screens/Incidents";
import { Login } from "./src/screens/Login";
import { OnCall } from "./src/screens/OnCall";
import { Settings } from "./src/screens/Settings";
import { acknowledged, boot, deepLink, me, ready, session, triggered } from "./src/store";
import { Toaster } from "./src/toast";
import { Empty, Header, Icon, type IconName, isDesktop, Loading, Meta, split, wide } from "./src/ui";

type Route = { name: "home" } | { name: "incident"; id: string };
type Section = "incidents" | "oncall" | "settings" | "admin";

const SECTIONS: { value: Section; label: string; icon: IconName }[] = [
  { value: "incidents", label: "Incidents", icon: "bell" },
  { value: "oncall", label: "On call", icon: "calendar" },
  { value: "settings", label: "Settings", icon: "sliders" },
  { value: "admin", label: "Admin", icon: "shield" },
];

const nav = createNavStack<Route>([{ name: "home" }]);
const section = signal<Section>("incidents");
/** The incident open beside the list in a wide window, by id so a re-sort keeps it. */
const selected = signal<string | null>(null);

const open = (id: string) => {
  if (wide()) {
    section.set("incidents");
    selected.set(id);
  } else {
    nav.push({ name: "incident", id });
  }
};

const visible = () => SECTIONS.filter((s) => s.value !== "admin" || me()?.role === "admin");
const title = () => SECTIONS.find((s) => s.value === section())!.label;

function Count(props: { value: number; floating?: boolean }) {
  return (
    <View testID="triggered-count" class={`min-w-4 items-center rounded-full bg-sev-critical px-1 ${props.floating ? "absolute -right-2 -top-1" : ""}`}>
      <Text class="text-xs font-semibold text-on-alert" style={{ fontVariant: ["tabular-nums"] }}>
        {props.value}
      </Text>
    </View>
  );
}

function Sidebar() {
  return (
    <View class="w-52 border-r border-sidebar-border bg-sidebar pt-[env(safe-area-inset-top)]">
      <View class={`flex-row items-center gap-2 px-4 ${isDesktop ? "min-h-12" : "min-h-14"}`}>
        <Icon name="bell" size={17} tint={token("sidebar-foreground")} />
        <Text class="text-base font-semibold text-sidebar-foreground">Pager</Text>
      </View>
      <Tabs class="gap-0.5 px-2">
        {visible().map((s) => (
          <Tab
            selected={section() === s.value}
            onPress={() => section.set(s.value)}
            accessibilityLabel={s.value === "incidents" && triggered().length ? `${s.label}, ${triggered().length} triggered` : s.label}
            class={`group flex-row items-center gap-2 rounded-md px-2 hover:bg-sidebar-accent selected:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring ${isDesktop ? "min-h-8" : "min-h-11"}`}
          >
            <Icon name={s.icon} size={16} tint={token(section() === s.value ? "sidebar-foreground" : "muted-foreground")} />
            <Text class="flex-1 text-sm font-medium text-muted-foreground group-selected:text-sidebar-foreground">{s.label}</Text>
            {s.value === "incidents" && triggered().length > 0 && <Count value={triggered().length} />}
          </Tab>
        ))}
      </Tabs>
      <View class="flex-1" />
      <View class="gap-1 border-t border-sidebar-border p-4">
        <Text class="text-sm font-medium text-sidebar-foreground line-clamp-1">
          {me()?.name}
        </Text>
        <LiveStatus />
      </View>
    </View>
  );
}

function BottomTabs() {
  return (
    <Tabs class="flex-row border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
      {visible().map((s) => (
        <Tab
          selected={section() === s.value}
          onPress={() => section.set(s.value)}
          accessibilityLabel={s.value === "incidents" && triggered().length ? `${s.label}, ${triggered().length} triggered` : s.label}
          class="group min-h-14 flex-1 items-center justify-center gap-0.5"
        >
          <View>
            <Icon name={s.icon} size={22} tint={token(section() === s.value ? "foreground" : "muted-foreground")} />
            {s.value === "incidents" && triggered().length > 0 && <Count value={triggered().length} floating />}
          </View>
          <Text class="text-xs font-medium text-muted-foreground group-selected:text-foreground">{s.label}</Text>
        </Tab>
      ))}
    </Tabs>
  );
}

function Screen() {
  return (
    <>
      <If when={section() === "oncall"}>
        <OnCall />
      </If>
      <If when={section() === "settings"}>
        <Settings />
      </If>
      <If when={section() === "admin"}>
        <Admin />
      </If>
    </>
  );
}

/** The open incident a wide window shows until the responder picks another. */
const first = computed(() => triggered()[0]?.id ?? acknowledged()[0]?.id ?? null);

/** List and incident side by side when they fit; the incident replaces the list when they don't. */
function IncidentsPane() {
  const shown = () => selected() ?? (split() ? first() : null);
  return (
    <View class="flex-1 flex-row">
      <If when={split() || !selected()}>
        <View class={split() ? "w-[400px] border-r border-border" : "flex-1"}>
          <Header title="Incidents" />
          <Incidents selected={shown()} onOpen={open} />
        </View>
      </If>
      <If when={split() || selected()}>
        <View class="flex-1">
          <If when={shown()} else={<Empty icon="check" title="Nothing open" />}>
            <Header title="Incident" onBack={split() ? undefined : () => selected.set(null)} />
            {/* Keyed by id: another incident gets a fresh timeline and an empty note. */}
            <Each of={shown() ? [shown()!] : []} key={(id: string) => id}>
              {(id) => <IncidentDetail id={id()} />}
            </Each>
          </If>
        </View>
      </If>
    </View>
  );
}

function WideFrame() {
  return (
    <View class="flex-1 flex-row bg-background">
      <Sidebar />
      <View class="flex-1">
        <If
          when={section() === "incidents"}
          else={
            <>
              <Header title={title()} />
              <Screen />
            </>
          }
        >
          <IncidentsPane />
        </If>
      </View>
    </View>
  );
}

function Home() {
  return (
    <NavPage title={title()} header={<Header title={title()} right={section() === "incidents" ? <LiveStatus /> : undefined} />}>
      <View class="flex-1 bg-background">
        <View class="flex-1">
          <If when={section() === "incidents"} else={<Screen />}>
            <Incidents onOpen={open} />
          </If>
        </View>
        <BottomTabs />
      </View>
    </NavPage>
  );
}

function IncidentPage(props: { id: string }) {
  return (
    <NavPage title="Incident" header={<Header title="Incident" onBack={() => nav.pop()} />}>
      <IncidentDetail id={props.id} />
    </NavPage>
  );
}

function App() {
  boot();
  // Opened from a notification link: show that incident once signed in.
  effect(() => {
    const id = deepLink();
    if (id && session()) {
      deepLink.set(null);
      open(id);
    }
  });
  return (
    <View class="flex-1 bg-background">
      <If when={ready()} else={<View class="flex-1 justify-center"><Loading /></View>}>
        <If when={session()} else={<Login />}>
          <If
            when={wide()}
            else={
              <NavStack state={nav} style={{ flex: 1 }}>
                {(route) => (route.name === "home" ? <Home /> : <IncidentPage id={route.id} />)}
              </NavStack>
            }
          >
            <WideFrame />
          </If>
        </If>
      </If>
      <Toaster />
    </View>
  );
}

mount(App);
