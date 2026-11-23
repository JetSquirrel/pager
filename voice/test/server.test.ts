import { describe, expect, it } from "bun:test";
import { doubao, pcmOf, type Speech, SpeechError, wavOf } from "../src/doubao";
import { announcement, clip } from "../src/phrase";
import { HEAR_MAX_BYTES, makeHandler, SAY_MAX_BYTES } from "../src/server";

const TOKEN = "t".repeat(24);
const page = { severity: "critical", number: 7, title: "Disk 95% on db1", service: "API", count: 1 };

function fake(heard = "收到") {
  const calls = { say: [] as string[], hear: [] as Uint8Array[] };
  const speech: Speech = {
    async synthesize(text) {
      calls.say.push(text);
      return new Uint8Array(3200);
    },
    async recognize(wav) {
      calls.hear.push(wav);
      return heard;
    },
  };
  return { calls, handle: makeHandler({ token: TOKEN, lang: "zh" }, speech, () => {}) };
}

const post = (path: string, body: BodyInit, token = TOKEN) =>
  new Request(`http://voice${path}`, { method: "POST", body, headers: { Authorization: `Voice ${token}` } });

describe("voice service", () => {
  it("needs the voice token", async () => {
    const { handle } = fake();
    expect((await handle(post("/v1/say", JSON.stringify(page), "wrong"))).status).toBe(401);
    expect((await handle(new Request("http://voice/v1/hear", { method: "POST", body: "x" }))).status).toBe(401);
    expect((await handle(new Request("http://voice/healthz"))).status).toBe(200);
  });

  it("announces a page as PCM, and synthesizes the same words once", async () => {
    const { handle, calls } = fake();
    const res = await handle(post("/v1/say", JSON.stringify(page)));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Sample-Rate")).toBe("16000");
    expect((await res.arrayBuffer()).byteLength).toBe(3200);
    await handle(post("/v1/say", JSON.stringify(page)));
    expect(calls.say).toEqual(["严重告警。7号事件，API：Disk 95% on db1。"]);
  });

  it("refuses a page it cannot say", async () => {
    const { handle } = fake();
    expect((await handle(post("/v1/say", JSON.stringify({ ...page, severity: "loud" })))).status).toBe(400);
    expect((await handle(post("/v1/say", JSON.stringify({ ...page, title: "" })))).status).toBe(400);
    expect((await handle(post("/v1/say", "not json"))).status).toBe(400);
  });

  it("hears a recording as WAV and answers with the command", async () => {
    const { handle, calls } = fake("二十分钟后再提醒我");
    const res = await handle(post("/v1/hear", new Uint8Array(32000)));
    expect(await res.json()).toEqual({ intent: "snooze", minutes: 20, text: "二十分钟后再提醒我" });
    expect(calls.hear[0].length).toBe(44 + 32000);
  });

  it("does not send a slip of the button to recognition, and refuses an endless one", async () => {
    const { handle, calls } = fake();
    expect(await (await handle(post("/v1/hear", new Uint8Array(1000)))).json()).toEqual({ intent: "none", text: "" });
    expect((await handle(post("/v1/hear", new Uint8Array(HEAR_MAX_BYTES + 2)))).status).toBe(413);
    expect(calls.hear).toEqual([]);
  });

  it("answers 502 when the provider fails, so the board falls back to its button", async () => {
    const handle = makeHandler(
      { token: TOKEN, lang: "en" },
      { synthesize: async () => { throw new SpeechError("Doubao TTS 3050: quota"); }, recognize: async () => "" },
      () => {},
    );
    expect((await handle(post("/v1/say", JSON.stringify(page)))).status).toBe(502);
  });
});

describe("phrases", () => {
  it("says the others waiting and cuts a long title at a word", () => {
    expect(announcement({ ...page, severity: "warning", count: 3 } as never, "en")).toBe(
      "Warning. Incident 7, API: Disk 95% on db1. 2 more waiting.",
    );
    expect(clip("checkout latency p99 above two seconds for the last fifteen minutes in eu-west")).toBe(
      "checkout latency p99 above two seconds for the",
    );
    expect([...clip("支付".repeat(40))].length).toBe(48);
  });
});

describe("doubao", () => {
  const cfg = {
    appId: "app", accessToken: "tok", voice: "BV001_streaming", ttsUrl: "https://tts", ttsCluster: "volcano_tts",
    asrUrl: "https://asr", asrResource: "volc.bigasr.auc_turbo", speed: 1.15,
  };

  it("asks TTS for 16 kHz PCM and decodes it", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const speech = doubao(cfg, async (url, init) => {
      sent = { url, init };
      return Response.json({ code: 3000, data: Buffer.from([1, 2, 3, 4]).toString("base64") });
    });
    expect([...(await speech.synthesize("你好"))]).toEqual([1, 2, 3, 4]);
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe("Bearer;tok");
    const body = JSON.parse(sent!.init.body as string);
    expect(body.audio).toEqual({ voice_type: "BV001_streaming", encoding: "pcm", rate: 16000, speed_ratio: 1.15 });
    expect(body.request).toMatchObject({ text: "你好", operation: "query" });
  });

  it("turns a TTS refusal into a SpeechError", async () => {
    const speech = doubao(cfg, async () => Response.json({ code: 3001, message: "invalid voice" }));
    await expect(speech.synthesize("x")).rejects.toBeInstanceOf(SpeechError);
  });

  it("reads the ASR status from its headers", async () => {
    const ok = doubao(cfg, async () =>
      Response.json({ result: { text: "已解决" } }, { headers: { "X-Api-Status-Code": "20000000" } }));
    expect(await ok.recognize(wavOf(new Uint8Array(10)))).toBe("已解决");
    const silent = doubao(cfg, async () => new Response("{}", { headers: { "X-Api-Status-Code": "20000003" } }));
    expect(await silent.recognize(wavOf(new Uint8Array(10)))).toBe("");
    const bad = doubao(cfg, async () =>
      new Response("{}", { headers: { "X-Api-Status-Code": "45000001", "X-Api-Message": "bad audio" } }));
    await expect(bad.recognize(wavOf(new Uint8Array(10)))).rejects.toThrow("bad audio");
  });

  it("unwraps PCM from a WAV and leaves raw PCM alone", () => {
    const pcm = new Uint8Array([9, 8, 7, 6]);
    expect([...pcmOf(wavOf(pcm))]).toEqual([9, 8, 7, 6]);
    expect([...pcmOf(pcm)]).toEqual([9, 8, 7, 6]);
  });

  it("keeps the announcement within what the board holds", () => {
    expect(SAY_MAX_BYTES).toBe(320000);
  });
});
