// Starts the front desk. Reads .env (see .env.example). Prints which features are on; never prints a secret.
import { existsSync } from "node:fs";
import { loadBusiness } from "../src/business.ts";
import { GoogleCalendar, MemoryCalendar, type Calendar } from "../src/calendar.ts";
import { Db } from "../src/db.ts";
import { MemoryEmail, ResendEmail, type EmailSender } from "../src/email.ts";
import { createApp, createHttpServer } from "../src/server.ts";
import { StripeClient } from "../src/stripe.ts";
import { env, loadEnv } from "./env.ts";

loadEnv();
const need = (n: string): string => {
  const v = env(n);
  if (!v) {
    console.error(`${n} is required (see .env.example)`);
    process.exit(1);
  }
  return v;
};

const b = loadBusiness(env("BUSINESS_DIR") ?? "businesses/brightside-family-dental");
const db = new Db(env("DB_FILE") ?? ".runtime/frontdesk.db");
db.releaseStaleClaims(Date.now());

let calendar: Calendar;
const saFile = env("GOOGLE_SERVICE_ACCOUNT_FILE");
const calId = env("GOOGLE_CALENDAR_ID");
if (saFile && calId && existsSync(saFile)) calendar = GoogleCalendar.fromFile(saFile, calId, b.timezone);
else {
  console.error("calendar: Google not configured, using an in-memory calendar (bookings are still stored in SQLite)");
  calendar = new MemoryCalendar();
}

let email: EmailSender;
const resendKey = env("RESEND_API_KEY");
if (resendKey) email = new ResendEmail({ apiKey: resendKey, from: need("EMAIL_FROM") });
else {
  console.error("email: RESEND_API_KEY not set, emails are kept in memory only");
  email = new MemoryEmail();
}

const stripeKey = env("STRIPE_SECRET_KEY");
const stripeHook = env("STRIPE_WEBHOOK_SECRET");
const stripe = stripeKey && stripeHook ? { client: new StripeClient({ secretKey: stripeKey }), webhookSecret: stripeHook } : undefined;
if (!stripe) console.error("deposits: off (STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET both needed)");

const n8nUrl = env("N8N_WEBHOOK_URL");
const n8nSecret = env("N8N_WEBHOOK_SECRET");
const n8n = n8nUrl && n8nSecret ? { url: n8nUrl, secret: n8nSecret } : undefined;

const app = createApp({
  b, db, calendar, email, stripe, n8n,
  retellApiKey: env("RETELL_API_KEY"),
  vapiSecret: env("VAPI_SERVER_SECRET"),
  publicBaseUrl: need("PUBLIC_BASE_URL"),
  linkSecret: need("LINK_SECRET"),
  teamEmail: env("TEAM_EMAIL"),
  transfersLive: env("TRANSFERS_LIVE") === "true",
  maxCallsPerDay: Number(env("MAX_CALLS_PER_DAY") ?? "40"),
  log: (l) => console.log(`${new Date().toISOString()} ${l}`),
});
const server = createHttpServer(app);
const port = Number(env("PORT") ?? "8080");
const host = env("HOST") ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log(
    `frontdesk for ${b.name} on http://${host}:${port} | calendar: ${calendar.kind} | email: ${email.kind} | deposits: ${stripe ? "on (test mode)" : "off"} | n8n: ${n8n ? "on" : "off"} | voice: ${[env("RETELL_API_KEY") ? "retell" : "", env("VAPI_SERVER_SECRET") ? "vapi" : ""].filter(Boolean).join("+")}`,
  );
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
