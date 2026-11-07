# 21:00 go-live (Sat 7 Nov)

You (purchases, about 10 min):
1. Retell > Billing > Buy credits $10. Auto-recharge stays OFF.
2. Retell > Phone Numbers > Buy number > US. Tell me the number.
3. Resend: sign up, API key into .env as RESEND_API_KEY, TEAM_EMAIL = your Gmail. Save.
4. (Optional now) Stripe test key into .env as STRIPE_SECRET_KEY.
5. DigitalOcean: add card or PayPal, then I fill the droplet form and you click Create.

Me (about 15 min after that):
1. Restart the server with the new keys; `npm run check:live` (google, resend, retell).
2. `npm run retell:setup -- --attach +1XXXXXXXXXX` (number answers with Ava; inbound webhook enforces the daily cap).
3. Browser test call from the Retell dashboard first (books into the real calendar, email to your Gmail).
4. You phone the number from your mobile: book, ask a question, move it, cancel, say something urgent.
5. Evidence: Retell call logs, the calendar event, the email in Gmail, server log lines.

Known limits tonight: the server runs on the Mac behind a temporary tunnel (Mac must stay on); the droplet replaces it.
