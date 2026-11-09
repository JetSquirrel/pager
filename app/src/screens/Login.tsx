import { Scroll, signal, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import { pageInfo } from "../host";
import { signIn } from "../store";
import { Btn, field, Field, Icon } from "../ui";

export function Login() {
  const server = signal("https://");
  const token_ = signal("");
  // Served by the pager itself (web): the server is this page's origin.
  pageInfo().then((p) => p?.origin.startsWith("http") && server() === "https://" && server.set(p.origin));
  const busy = signal(false);
  const error = signal<string | null>(null);

  const submit = async () => {
    if (busy() || !token_()) return;
    busy.set(true);
    error.set(null);
    try {
      await signIn({ server: server(), token: token_() });
    } catch (e) {
      error.set(String((e as Error).message ?? e));
    } finally {
      busy.set(false);
    }
  };

  return (
    <Scroll class="flex-1 bg-background">
      <View class="w-full max-w-sm gap-6 self-center p-6 pt-[env(safe-area-inset-top)]">
        <View class="flex-row items-center gap-2 pt-24">
          <Icon name="bell" size={22} tint={token("foreground")} />
          <Text class="text-xl font-semibold text-foreground">Pager</Text>
        </View>

        <View class="gap-4">
          <Field label="Server">
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
          </Field>

          <Field label="API token" error={error()}>
            <Input
              testID="token"
              value={token_()}
              onChange={(value) => token_.set(value)}
              placeholder="From your admin"
              autoCapitalize="none"
              autoCorrect={false}
              masked
              returnKeyType="go"
              onSubmit={submit}
              class={field}
            />
          </Field>

          <Btn title={busy() ? "Signing in…" : "Sign in"} busy={busy()} disabled={!token_()} onPress={submit} />
        </View>
      </View>
    </Scroll>
  );
}
