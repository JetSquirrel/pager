#!/usr/bin/env bash
# End-to-end smoke test against a running `wrangler dev` (fresh local DB).
# Usage: BASE=http://127.0.0.1:8787 BOOT=boot scripts/smoke.sh
set -euo pipefail
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}"
BASE=${BASE:-http://127.0.0.1:8787}
BOOT=${BOOT:-boot}
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(eval('o'+process.argv[1]))})" "$1"; }
step() { echo; echo "== $*"; }

step setup
TOKEN=$(curl -sf -X POST "$BASE/v1/setup" -H "Authorization: Bearer $BOOT" -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","name":"Alice"}' | j .token)
A="Authorization: Bearer $TOKEN"
ME=$(curl -sf "$BASE/v1/me" -H "$A" | j .user.id); echo "me=$ME"

step "second user + schedule + policy + service"
BOB=$(curl -sf -X POST "$BASE/v1/users" -H "$A" -H 'Content-Type: application/json' -d '{"email":"bob@example.com","name":"Bob"}' | j .user_id)
SCH=$(curl -sf -X POST "$BASE/v1/schedules" -H "$A" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Primary\",\"rotation\":{\"shift_hours\":168,\"users\":[\"$ME\",\"$BOB\"]}}" | j .id)
POL=$(curl -sf -X POST "$BASE/v1/escalation-policies" -H "$A" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Default\",\"repeat\":1,\"steps\":[{\"delay_min\":0,\"targets\":[{\"type\":\"schedule\",\"id\":\"$SCH\"}]},{\"delay_min\":5,\"targets\":[{\"type\":\"user\",\"id\":\"$BOB\"}]}]}" | j .id)
KEY=$(curl -sf -X POST "$BASE/v1/services" -H "$A" -H 'Content-Type: application/json' \
  -d "{\"name\":\"API\",\"escalation_policy_id\":\"$POL\"}" | j .integration_key)
curl -sf "$BASE/v1/oncall" -H "$A" | j '.schedules[0].current.user.name'
curl -sf "$BASE/v1/escalation-policies/$POL/preview" -H "$A"; echo

step "webhook contact method (to an unreachable URL, so delivery fails and is recorded)"
curl -sf -X POST "$BASE/v1/contact-methods" -H "$A" -H 'Content-Type: application/json' \
  -d '{"type":"webhook","label":"local","config":{"url":"http://127.0.0.1:9/hook"}}'; echo

step "trigger twice (dedup) via Events v2"
EV='{"event_action":"trigger","dedup_key":"db-disk","payload":{"summary":"Disk 95% on db1","severity":"critical","source":"db1"}}'
curl -sf -X POST "$BASE/v1/integrations/$KEY/events" -H 'Content-Type: application/json' -d "$EV"; echo
curl -sf -X POST "$BASE/v1/integrations/$KEY/events" -H 'Content-Type: application/json' -d "$EV"; echo

step "alertmanager"
curl -sf -X POST "$BASE/v1/integrations/$KEY/alertmanager" -H 'Content-Type: application/json' \
  -d '{"alerts":[{"status":"firing","labels":{"alertname":"HighErrorRate","instance":"api-1","severity":"warning"},"annotations":{},"fingerprint":"f1"}]}'; echo

sleep 2
step "open incidents"
curl -sf "$BASE/v1/incidents" -H "$A" | j '.incidents.map(i=>`#${i.number} ${i.status} ${i.severity} x${i.alert_count} ${i.title} assignees=${i.assignees.length}`).join("\n")'
INC=$(curl -sf "$BASE/v1/incidents?status=triggered" -H "$A" | j '.incidents.find(i=>i.dedup_key=="db-disk").id')

step "acknowledge + note + resolve"
curl -sf -X POST "$BASE/v1/incidents/$INC/acknowledge" -H "$A" | j .incident.status
curl -sf -X POST "$BASE/v1/incidents/$INC/notes" -H "$A" -H 'Content-Type: application/json' -d '{"message":"Rotating logs"}' >/dev/null
curl -sf -X POST "$BASE/v1/integrations/$KEY/events" -H 'Content-Type: application/json' -d '{"event_action":"resolve","dedup_key":"db-disk"}'; echo
sleep 1
curl -sf "$BASE/v1/incidents/$INC" -H "$A" | j '.events.map(e=>`${e.kind} ${e.actor_name??""} ${e.message}`).join("\n")'
curl -sf "$BASE/v1/incidents/$INC" -H "$A" | j '.escalation'

echo; echo "SMOKE OK"
