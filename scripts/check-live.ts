// Checks each account in .env against the real service, one line per service, without printing any secret.
//   npm run check:live                 all
//   npm run check:live -- google       one (google | resend | stripe | retell | server)
// Google: creates and deletes one test event. Resend: sends one email to TEAM_EMAIL. Stripe: reads the test balance.
// Retell: lists agents. Server: GET PUBLIC_BASE_URL/healthz.
import { existsSync } from "node:fs";
import { GoogleCalendar } from "../src/calendar.ts";
import { ResendEmail } from "../src/email.ts";
import { assertTestKey } from "../src/stripe.ts";
import { env, loadEnv } from "./env.ts";

loadEnv();
const only = process.argv[2];
const results: string[] = [];
const run = async (name: string, fn: () => Promise<string>) => {
  if (only && only !== name) return;
  try {
    results.push(`OK    ${name}: ${await fn()}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${(err instanceof Error ? err.message : String(err)).replace(/(sk|re|rk)_[A-Za-z0-9_]+/g, "$1_***")}`);
  }
};

await run("google", async () => {
  const file = env("GOOGLE_SERVICE_ACCOUNT_FILE");
  const id = env("GOOGLE_CALENDAR_ID");
  if (!file || !existsSync(file) || !id) throw new Error("GOOGLE_SERVICE_ACCOUNT_FILE (existing file) and GOOGLE_CALENDAR_ID needed");
  const cal = GoogleCalendar.fromFile(file, id, "America/New_York");
  const start = Date.now() + 3 * 86_400_000;
  const ev = await cal.createEvent({ appointmentId: "check", summary: "frontdesk connection check (deleted at once)", description: "", startUtc: start, endUtc: start + 1_800_000, timeZone: "America/New_York" });
  const busy = await cal.externalBusy(start - 3_600_000, start + 3_600_000);
  await cal.deleteEvent(ev);
  return `service account ${cal.serviceAccountEmail} can write to the calendar (test event created and deleted; ${busy.length} other busy blocks near it)`;
});

await run("resend", async () => {
  const key = env("RESEND_API_KEY");
  const to = env("TEAM_EMAIL");
  if (!key || !to) throw new Error("RESEND_API_KEY and TEAM_EMAIL needed");
  const r = await new ResendEmail({ apiKey: key, from: env("EMAIL_FROM") ?? "Front Desk Demo <onboarding@resend.dev>" }).send({
    to, subject: "frontdesk connection check", text: "If you read this, Resend works from the front desk.", idempotencyKey: `check-${Date.now()}`,
  });
  return `email accepted by Resend (id ${r.id}) for TEAM_EMAIL`;
});

await run("stripe", async () => {
  const key = env("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY needed");
  assertTestKey(key);
  const res = await fetch("https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${key}` } });
  const j = (await res.json()) as { livemode?: boolean; error?: { message?: string } };
  if (!res.ok) throw new Error(`${res.status} ${j.error?.message ?? ""}`);
  if (j.livemode) throw new Error("this key is in live mode");
  return `test-mode key works${env("STRIPE_WEBHOOK_SECRET") ? "; webhook secret present" : "; STRIPE_WEBHOOK_SECRET not set yet"}`;
});

await run("retell", async () => {
  const key = env("RETELL_API_KEY");
  if (!key) throw new Error("RETELL_API_KEY needed");
  const res = await fetch("https://api.retellai.com/v2/list-agents", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const list = ((await res.json()) as { items?: unknown[] }).items ?? [];
  const nums = await fetch("https://api.retellai.com/list-phone-numbers", { headers: { authorization: `Bearer ${key}` } });
  const n = nums.ok ? ((await nums.json()) as { phone_number?: string }[]) : [];
  return `key works; ${list.length} agent versions; numbers: ${n.map((x) => x.phone_number).join(", ") || "none yet"}`;
});

await run("server", async () => {
  const base = env("PUBLIC_BASE_URL");
  if (!base) throw new Error("PUBLIC_BASE_URL needed");
  const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(8000) });
  return `${res.status} ${await res.text()}`;
});

console.log(results.join("\n"));
process.exit(results.some((l) => l.startsWith("FAIL")) ? 1 : 0);
