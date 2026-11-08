// Starts the front desk. Reads .env (see .env.example). Prints which features are on; never prints a secret.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { loadBusiness } from "../src/business.ts";
import { GoogleCalendar, MemoryCalendar, type Calendar } from "../src/calendar.ts";
import { Db } from "../src/db.ts";
import { MemoryEmail, ResendEmail, type EmailSender } from "../src/email.ts";
import { createApp, createHttpServer, createRouter, type Tenant } from "../src/server.ts";
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

// The demo pages built by `npm run build:public`, served at / and /demos/<slug>/ (same address as the line).
const sitePages: Record<string, string> = {};
if (existsSync("public/index.html")) sitePages["/"] = readFileSync("public/index.html", "utf8");
for (const slug of existsSync("public/demos") ? readdirSync("public/demos") : []) {
  if (existsSync(`public/demos/${slug}/index.html`)) sitePages[`/demos/${slug}/`] = readFileSync(`public/demos/${slug}/index.html`, "utf8");
}

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon" };
const siteAssets: Record<string, { type: string; data: Buffer }> = {};
const addAssets = (dir: string, prefix: string): void => {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const type = TYPES[f.split(".").pop()?.toLowerCase() ?? ""];
    if (type) siteAssets[`${prefix}${f}`] = { type, data: readFileSync(`${dir}/${f}`) };
  }
};
addAssets("public", "/");
for (const slug of existsSync("public/demos") ? readdirSync("public/demos") : []) addAssets(`public/demos/${slug}`, `/demos/${slug}/`);

const app = createApp({
  sitePages,
  siteAssets,
  b, db, calendar, email, stripe, n8n,
  retellApiKey: env("RETELL_API_KEY"),
  vapiSecret: env("VAPI_SERVER_SECRET"),
  publicBaseUrl: need("PUBLIC_BASE_URL"),
  linkSecret: need("LINK_SECRET"),
  teamEmail: env("TEAM_EMAIL"),
  // Reply-To on caller emails. Unset by default: the team inbox is private and must not reach callers.
  replyTo: env("REPLY_TO"),
  transfersLive: env("TRANSFERS_LIVE") === "true",
  maxCallsPerDay: Number(env("MAX_CALLS_PER_DAY") ?? "40"),
  log: (l) => console.log(`${new Date().toISOString()} ${l}`),
});
// Samples built for prospects (npm run prospect): each gets its own bookings database and answers under /t/<slug>/.
// Same calendar and email sender; no deposits, no CRM. Expired samples answer 410 (npm run prospect:clean removes them).
const tenants = new Map<string, Tenant>();
const prospectDbs: Db[] = [];
const base = need("PUBLIC_BASE_URL").replace(/\/+$/, "");
for (const slug of existsSync("prospects") ? readdirSync("prospects") : []) {
  const dir = `prospects/${slug}`;
  if (!existsSync(`${dir}/business.json`)) continue;
  try {
    const pb = loadBusiness(dir);
    if (!pb.prospect) continue;
    const pdb = new Db(`.runtime/prospects/${slug}.db`);
    prospectDbs.push(pdb);
    // Each sample sends under its own name ("Smith Plumbing (sample)") from the same address.
    const fromAddr = /<([^>]+)>/.exec(env("EMAIL_FROM") ?? "")?.[1] ?? env("EMAIL_FROM");
    const pemail: EmailSender = resendKey && fromAddr ? new ResendEmail({ apiKey: resendKey, from: `${pb.name.replace(/[<>"]/g, "")} (sample) <${fromAddr}>` }) : email;
    const pcal: Calendar = saFile && calId && existsSync(saFile) ? GoogleCalendar.fromFile(saFile, calId, pb.timezone) : new MemoryCalendar();
    tenants.set(slug, {
      expiresAt: pb.prospect.expiresAt,
      app: createApp({
        b: pb, db: pdb, calendar: pcal, email: pemail,
        vapiSecret: env("VAPI_SERVER_SECRET"),
        publicBaseUrl: `${base}/t/${slug}`,
        linkSecret: need("LINK_SECRET"),
        teamEmail: env("TEAM_EMAIL"),
        replyTo: env("REPLY_TO"),
        transfersLive: false,
        maxCallsPerDay: Number(env("MAX_CALLS_PER_DAY") ?? "40"),
        log: (l) => console.log(`${new Date().toISOString()} [${slug}] ${l}`),
      }),
    });
  } catch (err) {
    console.error(`prospect ${slug} skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
const router = createRouter(app, tenants);
const server = createHttpServer(router);
const port = Number(env("PORT") ?? "8080");
const host = env("HOST") ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log(
    `frontdesk for ${b.name}${tenants.size ? ` + ${tenants.size} prospect sample(s)` : ""} on http://${host}:${port} | calendar: ${calendar.kind} | email: ${email.kind} | deposits: ${stripe ? "on (test mode)" : "off"} | n8n: ${n8n ? "on" : "off"} | voice: ${[env("RETELL_API_KEY") ? "retell" : "", env("VAPI_SERVER_SECRET") ? "vapi" : ""].filter(Boolean).join("+")}`,
  );
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    router.close();
    server.close(() => {
      db.close();
      for (const pdb of prospectDbs) pdb.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
