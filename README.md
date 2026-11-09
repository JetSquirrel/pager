# Pager

An SRE on-call pager. Alerts come in from Prometheus Alertmanager, Grafana or anything that speaks
PagerDuty's Events API v2; the pager opens an incident, finds who is on call, pages them on every device they have,
escalates until someone acknowledges, and turns sirens off when they do.

| Part | What | Where |
|---|---|---|
| Cloud | Cloudflare Worker + D1 + Durable Objects + Queues + KV | [`cloud/`](cloud) |
| Clients | One [NSH (Native Shell)](https://nsh.dev) TSX app: iOS, Android, macOS, Windows, Linux, web | [`app/`](app) |
| Hardware | Tuya sirens, smart plugs and lights, driven through Tuya Cloud | [`docs/hardware-tuya.md`](docs/hardware-tuya.md) |

```
 Alertmanager / Grafana / curl ──► Worker /v1/integrations/{key}/…
                                       │  dedup (service, dedup_key) in D1
                                       ▼
                                 Escalator DO (1 per incident, alarms)
                                       │ step N: schedules → on-call user
                                       ▼
                                 Queue pager-notify ──► ntfy push · Slack · webhook · Tuya device
                                       │
            Hub DO (WebSockets) ◄──────┘ live updates ──► NSH app (mobile / desktop / web)
```

See [docs/architecture.md](docs/architecture.md) for the design.

## Quick start (local)

```sh
cd cloud
npm install
cp .dev.vars.example .dev.vars          # set BOOTSTRAP_TOKEN, ACTION_SECRET
npm run db:migrate:local
npm run dev                              # http://127.0.0.1:8787
bash scripts/smoke.sh                    # end-to-end check against a fresh local DB
npm test                                 # unit tests
```

Then the app (needs the [`nsh` CLI](https://nsh.dev/docs/installation.md), tested with 0.3.0):

```sh
cd app
nsh check .                # type check
nsh test .                 # headless UI tests (API stubbed)
nsh run .                  # desktop window on this machine
nsh run . --target web     # browser
nsh run . --target ios     # simulator (macOS)
nsh run . --target android # device/emulator
```

Sign in with the server URL and the token from `POST /v1/setup`.

The web build is also served by the Worker itself: `npm run build:web` (in `cloud/`) packages it into
`cloud/public/app/`, and `wrangler dev` / `deploy` serve it at `/app/` — the sign-in screen fills in the server from
the page's origin, the tab raises browser notifications for new pages while it is in the background, and
`/app/#/incidents/<id>` (the link in push notifications) opens that incident.

## Deploy to Cloudflare

```sh
cd cloud
npx wrangler d1 create pager                 # put the id in wrangler.jsonc
npx wrangler kv namespace create CACHE       # put the id in wrangler.jsonc
npx wrangler queues create pager-notify
npx wrangler queues create pager-notify-dlq
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler secret put ACTION_SECRET
npx wrangler secret put TUYA_CLIENT_ID       # optional, for Tuya devices
npx wrangler secret put TUYA_CLIENT_SECRET
npm run db:migrate
npm run deploy                               # builds the web app, then wrangler deploy
```

Set `PUBLIC_URL` (and `TUYA_ENDPOINT` for your Tuya data center) in `wrangler.jsonc`.

## First-time setup

After creating the first admin, everything else can be done in the app's **Admin** tab (people and their tokens,
rotations, escalation policies, services with copyable Alertmanager / Grafana / Events URLs), or with the API:

```sh
B=https://pager.example.com
# 1. first admin (works once)
curl -X POST $B/v1/setup -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -d '{"email":"you@corp.com","name":"You"}'
# → {"token": "..."}   use it as $T below and to sign in to the app
# 2. a weekly rotation, a policy that pages it then escalates to a lead after 10 minutes, a service
curl -X POST $B/v1/schedules -H "Authorization: Bearer $T" \
  -d '{"name":"Primary","rotation":{"shift_hours":168,"users":["usr_a","usr_b"]}}'
curl -X POST $B/v1/escalation-policies -H "Authorization: Bearer $T" \
  -d '{"name":"Default","repeat":2,"steps":[{"delay_min":0,"targets":[{"type":"schedule","id":"sch_..."}]},{"delay_min":10,"targets":[{"type":"user","id":"usr_lead"}]}]}'
curl -X POST $B/v1/services -H "Authorization: Bearer $T" -d '{"name":"API","escalation_policy_id":"pol_..."}'
# → {"integration_key": "..."}
```

Point Alertmanager at it:

```yaml
receivers:
  - name: pager
    webhook_configs:
      - url: https://pager.example.com/v1/integrations/<integration_key>/alertmanager
        send_resolved: true
```

Or send an event by hand:

```sh
curl -X POST $B/v1/integrations/<key>/events -d '{"event_action":"trigger","dedup_key":"disk-db1",
  "payload":{"summary":"Disk 95% on db1","severity":"critical","source":"db1"}}'
```

## API

All under `/v1`, `Authorization: Bearer <token>`.

| Method | Path | |
|---|---|---|
| POST | `/setup` | First admin (bootstrap token) |
| POST | `/integrations/{key}/events` · `/alertmanager` · `/grafana` | Ingest (no auth; the key is the secret) |
| GET/POST | `/actions/{signed}` | One-tap ack/resolve links in notifications |
| GET | `/me` · POST `/me/rotate-token` | |
| GET | `/stream` | WebSocket of live incident updates (`?token=`) |
| GET | `/incidents?status=open\|triggered\|acknowledged\|resolved\|all` | |
| POST | `/incidents` | Open one by hand |
| GET | `/incidents/{id}` | Incident, timeline, escalation state |
| POST | `/incidents/{id}/acknowledge` · `/resolve` · `/notes` · `/repage` | |
| GET | `/oncall` | Who is on call now and next |
| GET/POST/PUT | `/schedules`, `/schedules/{id}/overrides` | Rotations and take-overs |
| GET/POST/PUT | `/escalation-policies`, `/{id}/preview` | |
| GET/POST | `/services` | |
| GET/POST/DELETE | `/users` | Admin |
| GET/POST/PATCH/DELETE | `/contact-methods`, `/{id}/test` | Your own paging channels |
| GET | `/tuya/presets`, `/tuya/devices/{id}/status` | |
