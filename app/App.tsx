// Pager — the on-call client for iOS, Android, macOS, Windows, Linux and the web, from one NSH TSX codebase.
import { effect, mount, signal, Text, View } from "nsh";
import { Button, createNavStack, NavPage, NavStack, Tab, Tabs } from "nsh/base";
import { Admin } from "./src/screens/Admin";
import { IncidentDetail } from "./src/screens/IncidentDetail";
import { Incidents } from "./src/screens/Incidents";
import { Login } from "./src/screens/Login";
import { OnCall } from "./src/screens/OnCall";
import { Settings } from "./src/screens/Settings";
import { boot, deepLink, me, ready, session, triggered } from "./src/store";
import { Toaster } from "./src/toast";
import { isDesktop } from "./src/ui";

type Route = { name: "home" } | { name: "incident"; id: string };
type Section = "incidents" | "oncall" | "settings" | "admin";

const TITLES: Record<Section, string> = { incidents: "Incidents", oncall: "On call", settings: "Settings", admin: "Admin" };

const nav = createNavStack<Route>([{ name: "home" }]);
const section = signal<Section>("incidents");

const open = (id: string) => nav.push({ name: "incident", id });

function Header(props: { title: string; back?: boolean }) {
  return (
    <View class="flex-row items-center gap-3 border-b border-border bg-background px-4 py-3 pt-[env(safe-area-inset-top)]">
      {props.back && (
        <Button onPress={() => nav.pop()} class="rounded-(--radius) px-2 py-1 active:bg-muted">
          <Text class="text-base text-primary">‹ Back</Text>
        </Button>
      )}
      <Text class="text-lg font-semibold text-foreground">{props.title}</Text>
    </View>
  );
}

function SectionTabs() {
  const item = (value: Section, label: () => string) => (
    <Tab selected={section() === value} onPress={() => section.set(value)} class="group flex-1 items-center rounded-(--radius) px-3 py-2 selected:bg-background">
      <Text class="text-sm font-medium text-muted-foreground group-selected:text-foreground">{label()}</Text>
    </Tab>
  );
  return (
    <View class={`border-border bg-background px-3 py-2 ${isDesktop ? "border-b" : "border-t pb-[env(safe-area-inset-bottom)]"}`}>
      <Tabs class="flex-row gap-1 rounded-lg bg-muted p-1">
        {item("incidents", () => (triggered().length ? `Incidents (${triggered().length})` : "Incidents"))}
        {item("oncall", () => "On call")}
        {item("settings", () => "Settings")}
        {me()?.role === "admin" && item("admin", () => "Admin")}
      </Tabs>
    </View>
  );
}

function Home() {
  const title = () => TITLES[section()];
  return (
    <NavPage title={title()} header={<Header title={title()} />}>
      <View class="flex-1 bg-background">
        {/* Tabs sit on top on desktops and the web, at the thumb on phones. */}
        {isDesktop && <SectionTabs />}
        <View class="flex-1">
          {section() === "incidents" ? (
            <Incidents onOpen={open} />
          ) : section() === "oncall" ? (
            <OnCall />
          ) : section() === "admin" ? (
            <Admin />
          ) : (
            <Settings />
          )}
        </View>
        {!isDesktop && <SectionTabs />}
      </View>
    </NavPage>
  );
}

function IncidentPage(props: { id: string }) {
  return (
    <NavPage title="Incident" header={<Header title="Incident" back />}>
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
      <If when={ready()} else={<View class="flex-1 items-center justify-center"><Text class="text-muted-foreground">Loading…</Text></View>}>
        <If when={session()} else={<Login />}>
          <NavStack state={nav} style={{ flex: 1 }}>
            {(route) => (route.name === "home" ? <Home /> : <IncidentPage id={route.id} />)}
          </NavStack>
        </If>
      </If>
      <Toaster />
    </View>
  );
}

mount(App);
