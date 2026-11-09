# Alarm permissions

Two separate questions: can a page get through to the people on call, and who may tell customers.

## Getting through to the person on call

| Where | What it takes | State |
|---|---|---|
| Browser or Home Screen app | Notification permission, and on iPhone the app added to the Home Screen | Web Push, sent with `Urgency: high`. Critical and error pages stay on screen until answered |
| Android | The ntfy app, with Instant delivery and Override Do Not Disturb on for the topic | ntfy priority 5 for critical |
| iPhone in silent or Focus mode | Apple's Critical Alerts entitlement and a native APNs client | **Not available.** NSH 0.3 has no native push module, and Web Push cannot override Silent or Focus |
| Native Android alarm channel, full-screen intent | A native module | **Not available**, same reason |
| Tuya siren or T5AI board | Nothing on the phone: it rings regardless | Works when the phone cannot |

**Settings → Alarm check** shows what would stop a critical page. A method that fails keeps its error until it next works.

If nothing can reach anyone in a critical incident's current step, the policy moves on after 30 seconds rather than
waiting out the step's delay. A hardware pager counts as reachable.

## Telling customers

A customer is someone outside the team, listed by an admin in **Admin → Customers**, reached by webhook, Slack or ntfy.
Email and SMS go through a webhook to whatever gateway you use; the pager has no provider of its own.

| Rule | Why |
|---|---|
| `CUSTOMER_NOTIFY` is `off` by default: every send is a dry run, written on the timeline, reaching nobody | Turning it on is a deliberate deploy |
| A person sends each notice. Nothing is automatic | An alert storm must not become a customer storm |
| Admins may send. Responders only if an admin allows it (`can_notify_customers`) | Speaking to customers is a separate authority from responding |
| Only open critical or error incidents | The name of the feature is emergency |
| Only the message and the service name leave | Alert titles and details hold hostnames, paths and sometimes secrets |
| One notice per incident per 5 minutes, 20 a day | A double tap must not message everyone twice |

Risks that remain once it is on: whoever holds the permission speaks for the company with no second approver, a notice
cannot be recalled, and a customer webhook is only as trustworthy as whoever owns it. Every send, dry or real, is on
the incident's timeline with who sent it.

## Lost admin token

From any machine logged in to Cloudflare:

```sh
npx wrangler secret put BOOTSTRAP_TOKEN
curl -X POST $B/v1/recover -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -d '{"email":"you@corp.com"}'
```

This issues a new token and retires the old one.
