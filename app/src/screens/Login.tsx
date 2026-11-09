import { Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { pageInfo } from "../host";
import { signIn } from "../store";
import { Btn } from "../ui";

const field = "rounded-(--radius) border border-border bg-background px-3 py-3 text-base text-foreground placeholder:text-muted-foreground";

export function Login() {
  const server = signal("https://");
  const token = signal("");
  // Served by the pager itself (web): the server is this page's origin.
  pageInfo().then((p) => p?.origin.startsWith("http") && server() === "https://" && server.set(p.origin));
  const busy = signal(false);
  const error = signal<string | null>(null);

  const submit = async () => {
    busy.set(true);
    error.set(null);
    try {
      await signIn({ server: server(), token: token() });
    } catch (e) {
      error.set(String((e as Error).message ?? e));
    } finally {
      busy.set(false);
    }
  };

  return (
    <Scroll class="flex-1 bg-background">
      <View class="w-full max-w-md gap-4 self-center p-6 pt-[env(safe-area-inset-top)]">
        <View class="gap-1 pt-16">
          <Text class="text-4xl font-bold text-foreground">Pager</Text>
          <Text class="text-muted-foreground">On-call alerts on your phone, desktop, browser and Tuya devices.</Text>
        </View>

        <Text class="font-semibold text-foreground">Server</Text>
        <Input
          testID="server"
          value={server()}
          onChange={(value) => server.set(value)}
          placeholder="https://pager.example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          class={field}
        />

        <Text class="font-semibold text-foreground">API token</Text>
        <Input
          testID="token"
          value={token()}
          onChange={(value) => token.set(value)}
          placeholder="Paste the token your admin gave you"
          autoCapitalize="none"
          autoCorrect={false}
          masked
          returnKeyType="go"
          onSubmit={submit}
          class={field}
        />

        {error() && <Text class="text-destructive">{error()}</Text>}

        <Btn title={busy() ? "Signing in…" : "Sign in"} onPress={submit} disabled={busy() || !token()} />
      </View>
    </Scroll>
  );
}
