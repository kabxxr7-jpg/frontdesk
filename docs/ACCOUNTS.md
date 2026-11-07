# Accounts: click steps (about 45 minutes)

Do these in order. Paste every key into `~/frontdesk/.env` (copy `.env.example` to `.env` first: `cp ~/frontdesk/.env.example ~/frontdesk/.env`). **Never paste a key into chat.** When a step says "tell me", send only the non-secret value (an IP, a domain, an email address of the service account, a calendar ID).

## 1. Domain (5 min, about $10)
1. Go to porkbun.com (or Namecheap). Search a short neutral name (your brand, e.g. `<yourname>labs.com`). Buy it. No add-ons.
2. Tell me the domain.

## 2. DigitalOcean droplet (5 min, about $12/month)
1. cloud.digitalocean.com > Create > Droplets.
2. Region **New York**. Image **Ubuntu 24.04 (LTS) x64**. Size: Basic, Regular, **2 GB / 1 CPU** ($12).
3. Authentication: **SSH key** > New SSH key > paste the output of `cat ~/.ssh/id_ed25519.pub` (no key yet? run `ssh-keygen -t ed25519` first and press Enter three times).
4. Hostname `frontdesk`. Create.
5. Tell me the droplet's IPv4 address.

## 3. DNS at the registrar (3 min)
Porkbun > Domain Management > your domain > DNS. Delete the default parking records (ALIAS/CNAME to pixie/uixie), then add three **A** records to the droplet IP:
| Type | Host | Answer |
|---|---|---|
| A | (blank, the root) | droplet IP |
| A | desk | droplet IP |
| A | n8n | droplet IP |

## 4. Retell (10 min, buy $10-20 credit)
1. dashboard.retellai.com > sign up.
2. Billing: add the card, buy **$10-20 credit**, **turn auto-recharge OFF** (that is the hard spending cap).
3. API Keys: copy the key that has the **webhook** badge into `.env` as `RETELL_API_KEY`.
4. Phone Numbers > Buy number > US, any area code (about $2/month). Do not attach an agent yet; I create the agent and connect it.
5. Tell me "Retell done" and the number (it goes only on the demo page).

## 5. Resend (5 min, free)
1. resend.com > sign up with your Gmail.
2. Domains > Add domain > `mail.<yourdomain>`. It shows 3-4 DNS records (MX, TXT for SPF, TXT for DKIM). Add each one at Porkbun DNS exactly as shown (Host = the part before your domain). Click Verify (can take 5-60 minutes; we use the test sender meanwhile).
3. API Keys > Create > "Sending access". Copy into `.env` as `RESEND_API_KEY`.

## 6. Stripe test keys (3 min, free)
1. dashboard.stripe.com > sign up (no business activation needed for test mode).
2. Turn on **Test mode** (top right). Developers > API keys > reveal the **Secret key** (`sk_test_...`) > `.env` as `STRIPE_SECRET_KEY`.
3. The webhook secret comes later (I tell you when the server is live).

## 7. Google Calendar service account (10 min, free)
1. console.cloud.google.com > top bar project picker > New project `frontdesk-demo` > Create, then select it.
2. Search bar: "Google Calendar API" > Enable.
3. Menu > IAM & Admin > Service accounts > Create service account. Name `frontdesk`. Create and continue > skip roles > Done.
4. Click the new account > Keys > Add key > Create new key > JSON. A file downloads. Move it to `~/frontdesk/secrets/google-service-account.json`:
   `mkdir -p ~/frontdesk/secrets && mv ~/Downloads/frontdesk-demo-*.json ~/frontdesk/secrets/google-service-account.json`
   (If the org policy blocks key creation, tell me; the fallback is Cal.com.)
5. Copy the service account's email (`frontdesk@frontdesk-demo.iam.gserviceaccount.com`).
6. calendar.google.com > left side "Other calendars" + > Create new calendar > name `Brightside Dental (demo)` > Create.
7. Its Settings > Share with specific people > Add the service account email > permission **Make changes to events** > Send.
8. Same page > Integrate calendar > copy **Calendar ID** (ends in `@group.calendar.google.com`) > `.env` as `GOOGLE_CALENDAR_ID`.
9. Tell me "calendar done".

## 8. Later (Sunday morning, I will remind you)
- HubSpot free CRM: app.hubspot.com sign up > Settings > Integrations > Private Apps > create, scopes `crm.objects.contacts.write`, `crm.objects.contacts.read`, `crm.objects.notes.write`. You paste the token into n8n (not into chat).
- GoHighLevel 14-day trial (card; set a reminder to cancel on day 12) > Automation > Workflows > Inbound Webhook trigger > copy URL.
