import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// "cloudflare:workers" only gives the Durable Object its base class; the tests supply the runtime (test/harness.ts).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stub-workers.ts", import.meta.url)) } },
});
