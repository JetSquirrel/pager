// Runs the voice service: `bun run src/main.ts` (or `deno serve` / any runtime with fetch and Bun.serve's shape).
import { doubao } from "./doubao";
import type { Lang } from "./phrase";
import { makeHandler } from "./server";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    console.error(`${name} is not set (see voice/README.md)`);
    process.exit(1);
  }
  return v;
};

const token = env("VOICE_TOKEN");
if (token.length < 16) {
  console.error("VOICE_TOKEN must be at least 16 characters: anyone who has it can make the board's voice service talk");
  process.exit(1);
}
const lang = env("VOICE_LANG", "zh");
if (lang !== "zh" && lang !== "en") {
  console.error("VOICE_LANG must be zh or en");
  process.exit(1);
}

const handle = makeHandler(
  { token, lang: lang as Lang },
  doubao({
    appId: env("DOUBAO_APP_ID"),
    accessToken: env("DOUBAO_ACCESS_TOKEN"),
    voice: env("DOUBAO_VOICE", "BV001_streaming"),
    ttsUrl: env("DOUBAO_TTS_URL", "https://openspeech.bytedance.com/api/v1/tts"),
    ttsCluster: env("DOUBAO_TTS_CLUSTER", "volcano_tts"),
    asrUrl: env("DOUBAO_ASR_URL", "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"),
    asrResource: env("DOUBAO_ASR_RESOURCE", "volc.bigasr.auc_turbo"),
    speed: Number(env("DOUBAO_SPEED", "1.15")),
  }),
);

const port = Number(env("PORT", "8790"));
Bun.serve({ port, hostname: env("HOST", "0.0.0.0"), fetch: handle, maxRequestBodySize: 1024 * 1024 });
console.log(`pager voice on :${port} (${lang})`);
