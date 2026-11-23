// Doubao speech (Volcengine): text to speech over the HTTP TTS API, and recognition of a short recording over the
// big-model "flash" file API, which answers in one request. A spoken command is a few seconds long, so there is
// nothing for a stream to win, and the board stays a plain HTTP client.
//
//   TTS  POST https://openspeech.bytedance.com/api/v1/tts                          (cluster volcano_tts)
//   ASR  POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash (resource volc.bigasr.auc_turbo)

export const SAMPLE_RATE = 16000;

export interface DoubaoConfig {
  appId: string;
  accessToken: string;
  voice: string;
  ttsUrl: string;
  ttsCluster: string;
  asrUrl: string;
  asrResource: string;
  /** Speaking speed, 0.8 to 2; a little over 1 keeps the announcement short. */
  speed: number;
}

export interface Speech {
  /** 16 kHz mono signed 16-bit little-endian PCM. */
  synthesize(text: string): Promise<Uint8Array>;
  /** What was said in a WAV recording; "" for silence. */
  recognize(wav: Uint8Array): Promise<string>;
}

export class SpeechError extends Error {}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export function doubao(cfg: DoubaoConfig, fetchFn: Fetch = fetch): Speech {
  return {
    async synthesize(text) {
      const res = await fetchFn(cfg.ttsUrl, {
        method: "POST",
        // The semicolon is Doubao's, not a typo.
        headers: { "Content-Type": "application/json", Authorization: `Bearer;${cfg.accessToken}` },
        body: JSON.stringify({
          app: { appid: cfg.appId, token: cfg.accessToken, cluster: cfg.ttsCluster },
          user: { uid: "pager-voice" },
          audio: { voice_type: cfg.voice, encoding: "pcm", rate: SAMPLE_RATE, speed_ratio: cfg.speed },
          request: { reqid: crypto.randomUUID(), text, operation: "query" },
        }),
      });
      const j = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: string } | null;
      if (!j || j.code !== 3000 || typeof j.data !== "string") {
        throw new SpeechError(`Doubao TTS ${j?.code ?? res.status}: ${j?.message ?? res.statusText}`);
      }
      return pcmOf(Buffer.from(j.data, "base64"));
    },

    async recognize(wav) {
      const res = await fetchFn(cfg.asrUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-App-Key": cfg.appId,
          "X-Api-Access-Key": cfg.accessToken,
          "X-Api-Resource-Id": cfg.asrResource,
          "X-Api-Request-Id": crypto.randomUUID(),
          "X-Api-Sequence": "-1",
        },
        body: JSON.stringify({
          user: { uid: "pager-voice" },
          audio: { data: Buffer.from(wav).toString("base64"), format: "wav" },
          request: { model_name: "bigmodel" },
        }),
      });
      const status = res.headers.get("X-Api-Status-Code");
      if (status === "20000003") return ""; // silence
      const j = (await res.json().catch(() => null)) as { result?: { text?: string } } | null;
      if (status !== "20000000" || !j) {
        throw new SpeechError(`Doubao ASR ${status ?? res.status}: ${res.headers.get("X-Api-Message") ?? res.statusText}`);
      }
      return j.result?.text ?? "";
    },
  };
}

/** Raw PCM from what the TTS returned: as is, or the data chunk when it came wrapped in WAV. */
export function pcmOf(bytes: Uint8Array): Uint8Array {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "data") return bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    at += 8 + size + (size & 1);
  }
  return new Uint8Array(0);
}

/** 16 kHz mono 16-bit PCM wrapped as a WAV file. */
export function wavOf(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
