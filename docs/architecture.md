# Architecture

## Cloud (Cloudflare, free plan)

```
 Alertmanager / Grafana / curl ─┐                        ┌─ ntfy, Slack, webhook, Tuya, Web Push
 NSH app, hardware pagers ──────┤                        │
                                ▼                        │
                 Worker ──► Durable Object `Pager` (SQLite) ──► one alarm: escalations + outbox
                 holds long polls   incidents, people, schedules, sockets, usage
```

| Piece | What it is | Why |
|---|---|---|
| Worker (`src/index.ts`) | Forwards `/v1/*` to the object; holds hardware long polls | A Worker is billed for CPU, so waiting here costs nothing |
| `Pager` (`src/pager.ts`) | One SQLite-backed Durable Object with all state | A deploy creates it; an incident, its escalation and its pages are written together |
| API (`src/api.ts`, Hono) | Runs inside the object | Reads and writes are synchronous local SQL |
| Alarm | One timer, aimed at the next due escalation or delivery | Survives deploys and restarts; replaces per-incident timers, a queue and a cron |
| Sockets | WebSocket hibernation, `ping` answered by the runtime | Idle clients cost nothing and never wake the object |

There is nothing to provision: `wrangler deploy` creates the object, the schema migrates itself (`src/schema.ts`), and the
action-link secret and the Web Push key pair are generated on first use and stored with the data. Because they live
there, redeploying from any machine cannot rotate them and cut off subscribed phones.

### Staying inside the free plan

This is a hard rule, in [AGENTS.md](../AGENTS.md). `src/budget.ts` holds the limits; `test/budget.test.ts` simulates a
busy day and fails above a fifth of the plan, and also fails if a query scans a large table.

- **No polling where a push exists, and no waiting inside the object.** A pending `setTimeout` or `await` stops a
  Durable Object from hibernating: one hardware pager long-polling inside it would use about 11,000 of the 13,000 GB-s a
  day. So the object answers over a hibernating socket and the Worker does the waiting (`longPoll` in `src/index.ts`).
- **Rows read are billed.** Hot queries use indexes; `incidents_open` keeps hardware polls off the incident history.
- **The object meters itself.** `GET /v1/usage` and the Admin tab show today's use; `GET /v1/health` reports `budget`.
- **Paging is never shed.** Past 40% of a daily limit the timeline stops recording repeats, past 70% delivery receipts.
  Alert counts, escalations and pages carry on.

### Incident lifecycle

1. **Ingest.** `/v1/integrations/{key}/{events|alertmanager|grafana}` parses the payload into `AlertEvent`s
   (`src/ingest.ts`). A trigger whose `(service, dedup_key)` already has an open incident increments `alert_count`.
2. **Escalate.** A new incident gets a row in `escalations` and pages step 0 in the same turn. Schedule targets resolve
   to whoever is on call, overrides first (`src/oncall.ts`). The alarm runs later steps at `next_at`; after the last
   step the policy repeats `repeat` times.
3. **Notify.** Each paged user's matching contact methods become rows in `outbox` (`src/notify/dispatch.ts`). A row is
   one method, so a failed siren is retried (5 s to 60 s, six tries) without paging the phone that already rang. The
   first failure and the final give-up go on the timeline; so does a paged person nothing can reach.
4. **Acknowledge / resolve**, from the app, a signed link or the integration. This stops the escalation and queues
   `acknowledge` / `resolve` to everyone paged: that is what switches sirens off and clears notifications on other devices.

### Paging channels

| Type | Reaches | Notes |
|---|---|---|
| `webpush` | Browsers, Android, iPhone from the Home Screen | No third party. RFC 8291 and 8292 in `src/notify/webpush.ts`; `app/web/sw.js` shows Acknowledge and Resolve buttons |
| `ntfy` | iOS, Android, desktop | For the native apps until they register for APNs and FCM |
| `tuya` | Physical devices | Commands per event, presets for sirens, plugs and color lights ([hardware-tuya.md](hardware-tuya.md)) |
| `slack` | Slack channel | Incoming webhook with an Acknowledge link |
| `webhook` | Anything | JSON with the incident and signed action links |
| in-app | NSH app while open | WebSocket: toast, list update, desktop window title `(n) Pager` |

Signed action links (`src/actions.ts`) are `incident.user.kind.expiry.hmac`, valid 24 h. A GET shows a confirmation
page, so link unfurlers and mail scanners never acknowledge anything; the POST acts.

## Clients (NSH)

One TSX codebase (`app/`) on [Native Shell](https://nsh.dev): iOS, Android, macOS, Windows, Linux (GTK 4) and the web (Wasm).

- `src/store.ts`: session in `Storage`, open incidents in signals, a WebSocket to `/v1/stream` with backoff, polling only while it is down.
- `src/host.ts` + `host.js`: on the web the page is NSH's host. It gives the app its origin and URL hash, and subscribes the browser to Web Push. Granted in `nsh.json` `capabilities.host`.
- Layout adapts with `platform.idiom === "desktop"`: tabs on top on desktops and the web, a bottom tab bar on phones.
