# frontdesk

A phone front desk for appointment businesses. It answers calls on a real number, answers questions from the business's own fact sheet, books into Google Calendar without double booking, emails the caller a confirmation with a code, takes a deposit through Stripe Checkout, routes emergencies to a person, and sends every call's summary to a CRM and the team through n8n.

The same engine is re-skinned for a new business from a short brief: `npm run reskin -- briefs/<name>.json`.

> Status (7 Nov 2026): built and tested locally (118 tests). Not yet live. This file is updated with dated evidence as each part goes live.

## Run locally

```bash
npm ci
npm test
cp .env.example .env    # fill in; see docs/ACCOUNTS.md
npm start
```

## Layout

| Path | What |
|---|---|
| `briefs/` | Short business briefs (input to the re-skin) |
| `businesses/<slug>/` | Generated: `business.json`, `prompt.md`, Retell JSON, `site/index.html` |
| `src/` | Server, tools, scheduler, SQLite store, Google Calendar, Resend, Stripe, post-call summary, re-skin |
| `scripts/` | `serve.ts`, `reskin.ts`, `retell-setup.ts`, `build-public.ts` |
| `deploy/` | Caddyfile, droplet setup, push script; `docker-compose.yml` at the root |
| `docs/ACCOUNTS.md` | Click steps for every account |

## License

MIT. Every business in `briefs/` is fictional.
