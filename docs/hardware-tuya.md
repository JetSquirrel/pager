# Tuya hardware

Any Tuya-compatible device a user can see in the Tuya / Smart Life app can be a pager: a siren that sounds, a light
that turns red, a plug that powers a rotating beacon. The Worker drives it through the Tuya Cloud OpenAPI
(`cloud/src/notify/tuya.ts`); nothing runs on the device.

## One-time setup (per organisation)

1. Create a cloud project at [platform.tuya.com](https://platform.tuya.com) (Cloud → Development → Create Cloud
   Project), "Smart Home" development method, in the data center your devices use.
2. Subscribe it to the **IoT Core** API service.
3. **Devices → Link App Account**: link the Tuya / Smart Life account that owns the devices (scan the QR code).
4. Copy the project's **Access ID** and **Access Secret**:
   ```sh
   npx wrangler secret put TUYA_CLIENT_ID
   npx wrangler secret put TUYA_CLIENT_SECRET
   ```
5. Set `TUYA_ENDPOINT` in `wrangler.jsonc` to your data center:

   | Data center | Endpoint |
   |---|---|
   | China | `https://openapi.tuyacn.com` |
   | Western America | `https://openapi.tuyaus.com` |
   | Eastern America | `https://openapi-ueaz.tuyaus.com` |
   | Central Europe | `https://openapi.tuyaeu.com` |
   | Western Europe | `https://openapi-weaz.tuyaeu.com` |
   | India | `https://openapi.tuyain.com` |

## Adding a device (per user)

In the app: **Settings → Add → Tuya**, pick the device from the list (or paste its id), leave the commands on **Auto**,
then **Send test**: the device goes off and is cleared 15 seconds later.

Auto reads the device's specification from Tuya and builds the commands: a siren at its loudest and longest, a color
light red for critical and amber otherwise, anything else with a switch turned on. A preset or custom commands are
checked against the same specification when you save, so a code the device does not have is refused then instead of
failing during a page.

Or with the API:

```sh
curl -X POST $B/v1/contact-methods -H "Authorization: Bearer $T" -d '{
  "type": "tuya", "label": "Desk siren", "min_severity": "error",
  "config": { "device_id": "vdevo1234567890", "preset": "auto" }
}'
```

### Presets

| Preset | Device category | On page | On ack / resolve |
|---|---|---|---|
| `siren` | Siren alarm (`sgbj`) | `AlarmSwitch: true` | `AlarmSwitch: false` |
| `plug` | Smart plug (`cz`) | `switch_1: true` | `switch_1: false` |
| `light` | Color light (`dj`) | on, amber; **red for critical** | off |

### Custom commands

Any device works with its own data points. Look them up under Tuya platform → Devices → Debug Device (or
`GET /v1/tuya/devices/{id}/status`), then give the commands yourself:

```json
{
  "device_id": "…",
  "on_trigger": [{ "code": "switch_led", "value": true }, { "code": "bright_value_v2", "value": 1000 }],
  "on_clear":   [{ "code": "switch_led", "value": false }],
  "by_severity": {
    "critical": [{ "code": "AlarmSwitch", "value": true }, { "code": "AlarmPeriod", "value": 60 }]
  }
}
```

The clear commands are sent on acknowledge, resolve, snooze and reassign to every user that was paged, regardless of their
`min_severity`, so nothing keeps ringing after someone has picked it up.

## When a device stops answering

Before paging, the Worker asks Tuya whether the device is online: an offline siren is a failed delivery on the
incident's timeline, retried and then given up on out loud, because Tuya would accept the command either way.

Every 30 minutes the Worker checks each enabled device. One that has gone offline shows in **Settings → Alarm check**,
and its owner hears about it once on their other channels.

## T5AI board

Register one under **Settings → Hardware pagers**; the token is shown once, for `pager_token` on the serial console.

| Button | Effect |
|---|---|
| Press | Acknowledge everything paging you |
| Hold 2 s | Snooze it for 30 minutes |

A press that cannot reach the server rings again rather than staying silent. After 5 minutes without the server the
board chirps once a minute.
