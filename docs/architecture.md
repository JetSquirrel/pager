# Architecture

## Cloud (Cloudflare)

| Piece | Cloudflare product | Why |
|---|---|---|
| HTTP API, ingest, action links | Worker (Hono) | Global edge, no servers to keep up for the thing that wakes you when servers are down |
| Incidents, users, schedules, policies, contact methods | D1 | Relational data; a partial unique index enforces one open incident per `(service, dedup_key)` |
| Escalation timer | Durable Object `Escalator`, one per incident | DO alarms are durable timers: they survive deploys and restarts and fire exactly where the incident's state lives |
| Live updates | Durable Object `Hub` with hibernating WebSockets | Every client holds one socket; idle sockets cost nothing |
| Delivery | Queue `pager-notify` (+ DLQ) | One message per (incident, user, event); retried with backoff independently of the request that caused it |
| Tuya access token cache | KV | Shared across isolates, expires itself |
| Safety net | Cron (every 5 min) | Starts any escalation that a crashed request failed to start; prunes old delivery receipts |

### Incident lifecycle

1. **Ingest.** `/v1/integrations/{key}/{events|alertmanager|grafana}` parses the payload into `AlertEvent`s
   (`src/ingest.ts`). A trigger whose `(service, dedup_key)` already has an open incident increments `alert_count`
   instead of paging again.
2. **Escalate.** A new incident starts its `Escalator`. Step 0 pages right away: each target resolves to users
   (schedule targets → whoever is on call, overrides first, `src/oncall.ts`). The DO sets an alarm for the next step's
   `delay_min`; after the last step it repeats the policy `repeat` times.
3. **Notify.** Every paged user becomes a queue message; the consumer sends it through each of the user's enabled
   contact methods whose `min_severity` the incident meets (`src/notify/dispatch.ts`). Results are written to the
   incident's timeline (`notify_sent` / `notify_failed`). A message is retried only when *every* method failed, so a
   working channel never double-pages.
4. **Acknowledge / resolve** — from the app, a signed link in a notification, or the integration (`resolve` events,
   Alertmanager `resolved`). This stops the escalator and sends `acknowledge` / `resolve` to everyone who was paged:
   that is what switches Tuya sirens and lights off.

### Paging channels

| Type | Reaches | Notes |
|---|---|---|
| `ntfy` | iOS, Android, desktop, browser | Priority 5 for critical; notification buttons **Acknowledge** / **Resolve** call signed action URLs |
| `tuya` | Physical devices | Commands per event, presets for sirens, plugs and color lights ([hardware-tuya.md](hardware-tuya.md)) |
| `slack` | Slack channel | Incoming webhook with an Acknowledge link |
| `webhook` | Anything | JSON with the incident and signed action links |
| in-app | NSH app while open | WebSocket → toast, list update, desktop window title `(n) Pager` |

Signed action links (`src/actions.ts`) are `incident.user.kind.expiry.hmac`, valid 24 h. A GET shows a confirmation
page (so link unfurlers and mail scanners never acknowledge anything); the POST acts.

## Clients (NSH)

One TSX codebase (`app/`) on [Native Shell](https://nsh.dev): native views on iOS (UIKit), Android, macOS (AppKit),
Windows, Linux (GTK 4) and the web (Wasm).

- `src/store.ts` — session in `Storage`, open incidents in signals, a WebSocket to `/v1/stream` with backoff,
  disconnect in the background / resync on return (`lifecycle()`), polling while offline, window title badge on
  desktops (`nsh/desktop`).
- Screens: sign-in, incidents (triggered / acknowledged with one-tap actions), incident detail (timeline, escalation,
  notes, re-page), on-call (current, next, take over), settings (contact methods, test page).
- `src/host.ts` + `host.js` — on the web the page is NSH's host: it gives the app its origin and URL hash, and shows
  browser notifications (`Notification`) for new pages while the tab is in the background. Granted in `nsh.json`
  `capabilities.host`.
- Layout adapts with `platform.idiom === "desktop"`: tabs on top and a centered column on desktops and the web, a bottom tab bar
  on phones.

### Background paging on phones

NSH does not ship a push-notification API yet. Until the app registers for APNs / FCM itself (a native module through
NSH's `nativeModule` / `host` channel — planned), phones are paged through the `ntfy` channel, whose app handles
background delivery and critical priority. The in-app socket covers the foreground.
