# frontdesk

A phone front desk for appointment businesses. It answers calls on a real number, answers questions from the business's own fact sheet, books into Google Calendar without double booking, emails the caller a confirmation with a code, takes a deposit through Stripe Checkout, routes emergencies to a person, and sends every call's summary to a CRM and the team through n8n.

The same engine is re-skinned for a new business from a short brief: `npm run reskin -- briefs/<name>.json` writes the business data, the agent prompt, the Retell configuration and a demo page.

## What is real and what is not

Each line says what has actually been run, and when. Nothing is marked done before it ran.

| Part | Status | Evidence |
|---|---|---|
| Google Calendar (service account) | **Real, verified 7 Nov 2026** | A signed booking sent over the public internet created an event in the real calendar; the cancel deleted it |
| Retell agent and LLM | **Created on Retell, 7 Nov 2026**; no call made yet | Created through the API and read back: six tools, 5-minute call limit, GPT-4.1 |
| Phone number | Not bought yet | |
| Confirmation email (Resend) | Code and tests only | |
| Stripe deposit | Code and tests only (test mode enforced: live keys are refused) | |
| n8n to HubSpot / team email / GoHighLevel | Workflow written, not yet imported | `deploy/n8n/` |
| Transfers to a person | Simulated on the demo: the business's numbers are fictional, so the agent says where it would connect and flags the call | `TRANSFERS_LIVE=true` turns real transfers on |
| The business | **Fictional.** Brightside Family Dental and Rapid Rooter Plumbing are invented: names, staff, prices, addresses, phone numbers | `briefs/` |

## Measured

| What | Result | How |
|---|---|---|
| Double booking under load | 20 simultaneous bookings for the same dentist and time: 1 booked, 19 refused with 3 alternatives each, 260 ms in all | a race script against a local server, 7 Nov 2026 |
| Tool latency to the real calendar | 1.2-1.7 s per tool call (availability, book, cancel) over a public tunnel | 7 Nov 2026, one run of each |
| Re-skin | Under 0.1 s per business for the generated files; dental and plumber both pass their tests | `npm run reskin` |

## How a call flows

1. Retell answers the number and runs the agent with `businesses/<slug>/prompt.md`.
2. When the model needs data it calls a tool: Retell POSTs `{ name, args, call }` to `/tools/<name>` with an `X-Retell-Signature` (HMAC of the raw body and a timestamp, 5-minute window, replay memory).
3. The server checks the signature, runs the tool, and answers `{ ok, message, ... }`; the model reads `message` to the caller. Business problems (time taken, closed, no notice) come back as HTTP 200 with alternatives.
4. Booking: availability = business hours and staff schedules, minus bookings in SQLite, minus blocks typed into the real calendar. The slot is written to SQLite (a unique index stops two bookings of one person at one time) and then to Google Calendar. The caller gets an email with a four-character code and, where the service needs one, a deposit link.
5. Urgent wording ("knocked-out tooth", "I smell gas") is caught in code in every tool that carries the caller's words; nothing is booked and the caller is routed to a person.
6. After the call Retell sends `call_ended` and `call_analyzed`; the server builds one summary per call and sends it to n8n (HubSpot, team email, GoHighLevel), or straight to the team inbox when n8n is down.
7. Calls past a daily cap are rejected through Retell's inbound webhook, and every call ends at 5 minutes, so a stranger cannot run up the bill.

## Run locally

```bash
npm ci
npm test               # 129 tests
npm run typecheck
cp .env.example .env   # fill in; docs/ACCOUNTS.md has the click steps
npm start
npm run check:live     # checks each configured account for real, prints no secrets
```

## Deploy (droplet)

```bash
ssh root@<ip> 'bash -s' < deploy/setup-droplet.sh   # Docker, firewall, swap, keys-only SSH
deploy/push.sh root@<ip>                            # code, .env, Google key; starts Caddy + server + n8n
npm run retell:setup -- --attach +1XXXXXXXXXX       # agent and number
```

Caddy serves the demo page on the domain, the server on `desk.<domain>` and n8n on `n8n.<domain>`, with HTTPS.

## Layout

| Path | What |
|---|---|
| `briefs/` | Short business briefs (input to the re-skin) |
| `businesses/<slug>/` | Generated: `business.json`, `prompt.md`, Retell JSON, `site/index.html` |
| `src/` | Server, tools, scheduler, SQLite store, Google Calendar, Resend, Stripe, post-call summary, re-skin, demo page |
| `scripts/` | `serve.ts`, `reskin.ts`, `retell-setup.ts`, `check-live.ts`, `build-public.ts` |
| `deploy/` | Caddyfile, droplet setup, push script, n8n workflow; `docker-compose.yml` at the root |
| `docs/` | Account click steps, go-live runbook, vendor sources and costs |

## Limits

- One process and one SQLite file. Fine for one business per server; several servers would need a shared database.
- The emergency check matches phrases. It misses wordings it does not list and is a routing aid, not triage.
- Speech-to-text of email addresses is error-prone; the agent spells addresses back, and a failed email is flagged in the team summary.
- The prompt has been checked only by tests of the tools, not yet on real calls (this line changes after the first calls).

## License

MIT. Every business in `briefs/` is fictional.
