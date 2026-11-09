import { defineConfig } from "vitest/config";

// Unit tests of the pure modules. "cloudflare:workers" is only imported by the Durable Object classes; stub it.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  resolve: { alias: { "cloudflare:workers": new URL("./test/stub-workers.ts", import.meta.url).pathname } },
});
