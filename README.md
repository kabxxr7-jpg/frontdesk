# frontdesk

A phone front desk for appointment businesses. It answers calls on a real number, answers questions from the business's own fact sheet, books into Google Calendar without double booking, emails the caller a confirmation with a code, takes a deposit through Stripe Checkout, routes emergencies to a person, and sends every call's summary to a CRM and the team through n8n.

The same engine is re-skinned for a new business from a short brief: `npm run reskin -- briefs/<name>.json` writes the business data, the agent prompt, the Vapi and Retell configurations and a demo page.

## What is real and what is not

Each line says what has actually been run, and when. Nothing is marked done before it ran.

| Part | Status | Evidence |
|---|---|---|
| Phone line and voice agent | **Real, live on Vapi since 7 Nov 2026** | A US number on Vapi; a real call from a phone booked an appointment end to end (code PEFW, 7 Nov 2026, 23:02 IST) |
| Google Calendar (service account) | **Real, verified 7 Nov 2026** | That call's booking created an event in the real calendar; an earlier signed test booking and its cancel also ran |
| Confirmation email (Resend) | **Real, verified 7 Nov 2026** | The caller's confirmation with the code arrived in a real inbox. Sent from Resend's shared test sender until the domain is verified |
| Team summary after each call | **Real, verified 7 Nov 2026** | Vapi's end-of-call report produced one summary email to the team inbox |
| Stripe deposit | **Real, test mode.** Checkout page verified 7 Nov 2026; the paid webhook is not yet verified on a live call | A booking opened a real Stripe Checkout session (test mode; live keys are refused). No money moves |
| Browser call | **Real, verified 8 Nov 2026** | "Talk to Ava in your browser" on the demo page (Vapi web SDK, public key restricted to the site); tested on a phone on mobile data |
| Call recordings | **Off** | Recording is switched off on the assistant; the demo is calling the line, not listening to a recording |
| Retell | Built and tested in code, not funded | The same agent runs on Retell with `npm run retell:setup`; no Retell number was bought |
| n8n to HubSpot / team email / GoHighLevel | Workflow written, not yet connected; GoHighLevel off (no trial account) | `deploy/n8n/` |
| Hosting | The server runs on a Mac behind a named Cloudflare tunnel at kabiirlabs.com and desk.kabiirlabs.com (since 8 Nov 2026), started by launchd at login and restarted after a crash (`deploy/launchd/`). Down whenever the Mac is off or asleep | The droplet setup in `deploy/` is written but not used |
| Transfers to a person | Simulated on the demo: the business's numbers are fictional, so the agent says where it would connect and flags the call | `TRANSFERS_LIVE=true` turns real transfers on |
| The business | **Fictional.** Brightside Family Dental and Rapid Rooter Plumbing are invented: names, staff, prices, addresses, phone numbers | `briefs/` |

## Measured

| What | Result | How |
|---|---|---|
| Double booking under load | 20 simultaneous bookings for the same dentist and time: 1 booked, 19 refused with 3 alternatives each, 260 ms in all | a race script against a local server, 7 Nov 2026 |
| Tool latency to the real calendar | 1.2-1.7 s per tool call (availability, book, cancel) over a public tunnel | 7 Nov 2026, one run of each |
| Re-skin | 0.02 s per business for the generated files (about 0.4 s for the whole command); dental and plumber both regenerated and pass their tests, 8 Nov 2026 | `npm run reskin` |
| Cost per call minute | About $0.13 on Vapi (a 3 min 04 s call cost $0.39) | Vapi call log, 7 Nov 2026 |

## How a call flows

1. The voice platform (Vapi, or Retell) answers the number and runs the agent with `businesses/<slug>/prompt.md`.
2. When the model needs data it calls a tool. Vapi POSTs a `tool-calls` message to `/vapi` carrying a shared-secret header; Retell POSTs `{ name, args, call }` to `/tools/<name>` with an `X-Retell-Signature` (HMAC of the raw body and a timestamp, 5-minute window, replay memory). Requests without valid auth are refused.
3. The server checks the signature, runs the tool, and answers `{ ok, message, ... }`; the model reads `message` to the caller. Business problems (time taken, closed, no notice) come back as HTTP 200 with alternatives.
4. Booking: availability = business hours and staff schedules, minus bookings in SQLite, minus blocks typed into the real calendar. The slot is written to SQLite (a unique index stops two bookings of one person at one time) and then to Google Calendar. The caller gets an email with a four-character code and, where the service needs one, a deposit link.
5. Urgent wording ("knocked-out tooth", "I smell gas") is caught in code in every tool that carries the caller's words; nothing is booked and the caller is routed to a person.
6. After the call Vapi sends its end-of-call report (Retell: `call_ended` and `call_analyzed`); the server builds one summary per call and sends it to n8n (HubSpot, team email, GoHighLevel), or straight to the team inbox when n8n is down.
7. Every call ends at 5 minutes, so a stranger cannot run up the bill. On Retell, calls past a daily cap are also rejected through the inbound webhook.

## Run locally

```bash
npm ci
npm test               # 153 tests
npm run typecheck
cp .env.example .env   # fill in; docs/ACCOUNTS.md has the click steps
npm start
npm run check:live     # checks each configured account for real, prints no secrets
```

## Run the live line (Mac or any machine)

```bash
cloudflared tunnel --url http://127.0.0.1:8080       # or a named tunnel on your domain; put its https address in PUBLIC_BASE_URL
npm run build:public && npm start                    # the server also serves the demo pages at / and /demos/<slug>/
npm run vapi:setup -- --attach                       # assistant from BUSINESS_DIR, pointed at your Vapi number
```

## Deploy (droplet, optional)

```bash
ssh root@<ip> 'bash -s' < deploy/setup-droplet.sh   # Docker, firewall, swap, keys-only SSH
deploy/push.sh root@<ip>                            # code, .env, Google key; starts Caddy + server + n8n
npm run retell:setup -- --attach +1XXXXXXXXXX       # Retell agent and number, if you use Retell
```

Caddy serves the demo page on the domain, the server on `desk.<domain>` and n8n on `n8n.<domain>`, with HTTPS.

## Layout

| Path | What |
|---|---|
| `briefs/` | Short business briefs (input to the re-skin) |
| `businesses/<slug>/` | Generated: `business.json`, `prompt.md`, Vapi and Retell JSON, `site/index.html` |
| `src/` | Server, Vapi adapter, tools, scheduler, SQLite store, Google Calendar, Resend, Stripe, post-call summary, re-skin, demo page |
| `scripts/` | `serve.ts`, `reskin.ts`, `vapi-setup.ts`, `retell-setup.ts`, `check-live.ts`, `build-public.ts` |
| `deploy/` | Caddyfile, droplet setup, push script, n8n workflow; `docker-compose.yml` at the root |
| `docs/` | Account click steps, go-live runbook, vendor sources and costs |

## Limits

- One process and one SQLite file. Fine for one business per server; several servers would need a shared database.
- The emergency check matches phrases. It misses wordings it does not list and is a routing aid, not triage.
- Speech-to-text of email addresses is error-prone; the agent spells addresses back, and a failed email is flagged in the team summary.
- The prompt has been checked only by tests of the tools, not yet on real calls (this line changes after the first calls).

## License

MIT. Every business in `briefs/` is fictional.
