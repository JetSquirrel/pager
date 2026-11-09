## Cloudflare Free Plan Budget (hard rule)

The pager must run on the Cloudflare Workers Free plan. Past a daily limit every operation of that kind fails until 00:00 UTC, and for a pager that means nobody gets woken up. Its steady state must stay under `TARGET` in `cloud/src/budget.ts`, a fifth of the free plan.

- `cloud/test/budget.test.ts` simulates a busy day and fails over `TARGET`, or when a query scans a large table. Never raise `TARGET` or thin out the simulation to make a change pass. Redesign the change.
- Never wait inside the Durable Object. A pending `setTimeout` or `await` on a long operation stops it hibernating and bills duration the whole time. Wait in the Worker (`longPoll` in `cloud/src/index.ts`) or set the alarm.
- No polling where a push exists. Anything that reaches the Worker on a timer, or once per event, needs a budget argument before it lands: requests a day, rows written per request, what it costs while nobody is looking.
- Rows read are billed per row scanned. No `OFFSET` pagination; keep an index for every `WHERE` on `incidents`, `incident_events`, `outbox` and `escalations`.
- Shed recording, never paging: past `LEAN` or `SHED` the timeline loses detail, but escalations and deliveries always run.

## Durable state

Everything lives in the one `Pager` Durable Object. Anything that must happen later is a row plus `env.wake()`, never a timer in memory. The object loses its memory when it hibernates, so counters and versions are stored. To change the schema append to `MIGRATIONS` in `cloud/src/schema.ts`; never edit an entry that has shipped.

Secrets the pager generates for itself (action-link secret, VAPID keys) stay in the database. A deploy must never replace them: that would cut off every subscribed device.

## Checks

```sh
cd cloud && npx tsc --noEmit && npm test     # unit, integration on real SQLite, the budget day
cd cloud && npx wrangler dev --var BOOTSTRAP_TOKEN:boot &   # then, on fresh state:
BOOT=boot bash scripts/smoke.sh              # sockets and long polls, which the tests cannot cover
cd app && nsh check . && nsh test .
```
