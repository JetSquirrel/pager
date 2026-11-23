# Pager voice

Voice mode for the T5AI hardware pager ([`hardware/pager-t5ai`](../hardware/pager-t5ai)). The board reads a new page
out loud between siren cycles, and you answer it by holding the button and speaking:

| Say | Does |
|---|---|
| 收到 · 确认 · 我来 · "ack" · "on it" | Acknowledge every page ringing on the board, as a tap does |
| 稍后 · 二十分钟后再提醒 · 推迟一个小时 · "snooze 15 minutes" | Snooze them, for the time said (30 minutes if none, 240 at most) |
| 已解决 · 修好了 · "resolved" · "fixed" | Resolve **the incident the board announced**, and only that one |
| 再说一遍 · 什么 · "repeat" | Read it out again |

A rising chirp means it was done. Two low chirps mean it was not understood, or nothing changed, and the page rings
again. Words are matched, not guessed: "还没解决", "关闭警报", or "收到，等会解决" resolve nothing.

This service sits between the board and Doubao speech (Volcengine). It holds the Doubao keys so the board never
does, and it never talks to the pager: the board acts on the answer with its own device token, as its button does.
Audio never reaches the pager's Worker, so voice adds nothing to its free-plan budget except a request per spoken
command.

```
board ──POST /v1/say  {page}──► voice ──► Doubao TTS      (16 kHz PCM back to the board)
board ──POST /v1/hear  PCM ───► voice ──► Doubao ASR      ({intent, minutes?, text} back)
board ──POST /v1/device/ack | snooze | resolve?id= ──► pager Worker
```

## What it never does

- **Hold up a page.** The siren never waits for speech. If this service is down, the board rings as it always did, and
  holding the button means what it means without voice: snooze for 30 minutes.
- **Listen when nobody asked.** The microphone is kept only while the button is held, at most 6 seconds.
- **Act on a guess.** An unclear sentence is `none`; resolving has to be the only thing said.

What does leave: the incident's title, number, severity and service go to Doubao to be spoken, and what you say while
holding the button goes to Doubao to be recognized.

## Run it

Needs [Bun](https://bun.sh) and a Volcengine speech app with **TTS** (`volcano_tts`) and the big-model **file
recognition, flash edition** (`volc.bigasr.auc_turbo`) enabled. Run it anywhere the board can reach: a machine on the
same network, or a small VPS behind HTTPS.

```sh
cd voice
bun install
VOICE_TOKEN=$(openssl rand -hex 16) \
DOUBAO_APP_ID=... DOUBAO_ACCESS_TOKEN=... \
bun run src/main.ts                     # pager voice on :8790 (zh)
bun test                                # intents, phrases, the API, Doubao requests (no network)
```

| Variable | Default | |
|---|---|---|
| `VOICE_TOKEN` | (required) | Shared with the board, 16+ characters |
| `DOUBAO_APP_ID`, `DOUBAO_ACCESS_TOKEN` | (required) | From the Volcengine speech console |
| `VOICE_LANG` | `zh` | `zh` or `en`: the language of the announcement (commands are understood in both) |
| `DOUBAO_VOICE` | `BV001_streaming` | Any voice type your app has |
| `DOUBAO_SPEED` | `1.15` | Speaking speed |
| `PORT`, `HOST` | `8790`, `0.0.0.0` | |
| `DOUBAO_TTS_URL`, `DOUBAO_TTS_CLUSTER`, `DOUBAO_ASR_URL`, `DOUBAO_ASR_RESOURCE` | Doubao's | For another region or resource |

Then on the board's serial console:

```
pager_voice http://192.168.1.20:8790 <VOICE_TOKEN>
pager_reboot                            # a hold becomes 0.8 s, so a quick "收到" counts
```

`pager_show` prints the voice service; `pager_voice off` turns it off. **Send test** on the board in the app's Settings rings it and reads out
"Test ring", which checks the speaker and the service end to end.

## API

Both POSTs take `Authorization: Voice <VOICE_TOKEN>`.

| | |
|---|---|
| `POST /v1/say` | `{"severity":"critical","number":7,"title":"Disk 95% on db1","service":"API","count":1}` → 16 kHz mono s16le PCM (at most 10 s). Recent announcements are kept, so a repeat costs no second synthesis. |
| `POST /v1/hear` | 16 kHz mono s16le PCM, 0.3 to 8 s → `{"intent":"snooze","minutes":20,"text":"二十分钟后再提醒我"}`; `intent` is `ack`, `snooze`, `resolve`, `repeat` or `none` |
| `GET /healthz` | `ok` |

A `502` means Doubao failed; the board then falls back to its button meanings.
