// The board's voice API. It holds the speech provider's keys so the board never does, and it knows nothing of the
// pager: the board acts on what it hears with its own device token, the same way its button does.
//
//   POST /v1/say   {severity, number, title, service, count}  → 16 kHz mono s16le PCM of the announcement
//   POST /v1/hear  16 kHz mono s16le PCM of a held button     → {intent, minutes?, text}
//   GET  /healthz
//
// Both POSTs need "Authorization: Voice <VOICE_TOKEN>".
import { type Speech, SpeechError, wavOf } from "./doubao";
import { parseIntent } from "./intent";
import { announcement, invalidPage, type Lang, type Page } from "./phrase";

/** The longest recording /v1/hear takes: the board stops listening at 6 s. */
export const HEAR_MAX_BYTES = 8 * 16000 * 2;
/** Shorter than this is a tap that slipped, not a sentence. */
export const HEAR_MIN_BYTES = 0.3 * 16000 * 2;
/** The board keeps at most this much announcement; say less rather than be cut off. */
export const SAY_MAX_BYTES = 10 * 16000 * 2;

export interface ServerConfig {
  token: string;
  lang: Lang;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function authorized(req: Request, token: string): boolean {
  const h = req.headers.get("authorization") ?? "";
  if (!h.toLowerCase().startsWith("voice ")) return false;
  const a = new TextEncoder().encode(h.slice(6).trim());
  const b = new TextEncoder().encode(token);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function makeHandler(cfg: ServerConfig, speech: Speech, log: (msg: string) => void = console.log) {
  // The same page is announced again on "repeat" and when the board reconnects: a few recent ones are kept.
  const said = new Map<string, Uint8Array>();

  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/healthz") return new Response("ok");
    if (pathname !== "/v1/say" && pathname !== "/v1/hear") return json({ error: "not found" }, 404);
    if (req.method !== "POST") return json({ error: "use POST" }, 405);
    if (!authorized(req, cfg.token)) return json({ error: "missing or wrong voice token" }, 401);

    try {
      if (pathname === "/v1/say") {
        const body = await req.json().catch(() => null);
        const bad = invalidPage(body);
        if (bad) return json({ error: bad }, 400);
        const p = body as Page;
        const text = announcement({ ...p, service: p.service ?? "", count: p.count ?? 1 }, cfg.lang);
        let pcm = said.get(text);
        if (!pcm) {
          pcm = await speech.synthesize(text);
          if (pcm.length > SAY_MAX_BYTES) pcm = pcm.subarray(0, SAY_MAX_BYTES);
          said.set(text, pcm);
          if (said.size > 16) said.delete(said.keys().next().value!);
        }
        return new Response(pcm as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "application/octet-stream", "X-Sample-Rate": "16000" } });
      }

      const pcm = new Uint8Array(await req.arrayBuffer());
      if (pcm.length > HEAR_MAX_BYTES) return json({ error: "recording longer than 8 s" }, 413);
      if (pcm.length < HEAR_MIN_BYTES) return json({ intent: "none", text: "" });
      const text = await speech.recognize(wavOf(pcm.length & 1 ? pcm.subarray(0, pcm.length - 1) : pcm));
      const intent = parseIntent(text);
      log(`heard ${JSON.stringify(text)} → ${intent.intent}${"minutes" in intent ? ` ${intent.minutes}m` : ""}`);
      return json({ ...intent, text });
    } catch (e) {
      // The board falls back to its button meanings on a 502; it never acts on a guess.
      if (e instanceof SpeechError) {
        log(String(e.message));
        return json({ error: e.message }, 502);
      }
      throw e;
    }
  };
}
