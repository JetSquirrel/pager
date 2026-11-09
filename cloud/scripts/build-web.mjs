// Packages the NSH app for the web and puts it where the Worker serves it (/app/).
// Usage: npm run build:web   (needs the `nsh` CLI on PATH)
import { execSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const app = join(root, "app");
const out = join(root, "cloud", "public", "app");

execSync("nsh package . --target web", { cwd: app, stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
cpSync(join(app, ".nsh", "out", "Pager"), out, { recursive: true });
console.log(`web app copied to ${out}`);
