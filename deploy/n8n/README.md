# n8n workflow: call summary out

`frontdesk-call-summary.json` receives the server's call summary (POST /webhook/frontdesk-call) and:
1. creates or updates the caller as a HubSpot contact (by email, or by phone when there is no email) and adds a note with the outcome;
2. emails the team through Resend;
3. posts the same fields to a GoHighLevel inbound webhook (disabled until the GHL trial exists).

Credentials to create in n8n (Credentials > New > Header Auth), never in this file:
- "Frontdesk token": name `x-frontdesk-token`, value = N8N_WEBHOOK_SECRET from .env
- "HubSpot private app": name `Authorization`, value `Bearer <private app token>`
- "Resend API": name `Authorization`, value `Bearer <RESEND_API_KEY>`

Values read from the n8n container environment ($env, set in docker-compose.yml from .env): TEAM_EMAIL, EMAIL_FROM, GHL_INBOUND_WEBHOOK_URL. (n8n Variables are a paid feature.)
Status: written 7 Nov 2026, not yet run against a real n8n. Import and test it on the droplet.
