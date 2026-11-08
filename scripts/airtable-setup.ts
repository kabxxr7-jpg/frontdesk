// Creates the Bookings table in the Airtable base (or adds any missing fields to it). Safe to run again.
// Needs AIRTABLE_TOKEN with scopes data.records:read, data.records:write, schema.bases:read, schema.bases:write,
// and AIRTABLE_BASE_ID. Prints no secret.
import { loadBusiness } from "../src/business.ts";
import { env, loadEnv } from "./env.ts";

loadEnv();
const token = env("AIRTABLE_TOKEN");
const base = env("AIRTABLE_BASE_ID");
const table = env("AIRTABLE_TABLE") ?? "Bookings";
if (!token || !base) {
  console.error("AIRTABLE_TOKEN and AIRTABLE_BASE_ID are needed in .env");
  process.exit(1);
}
const tz = loadBusiness(env("BUSINESS_DIR") ?? "businesses/brightside-family-dental").timezone;
const when = { dateFormat: { name: "friendly" }, timeFormat: { name: "12hour" }, timeZone: tz };
const FIELDS = [
  { name: "Code", type: "singleLineText", description: "Confirmation code the caller reads back" },
  { name: "Service", type: "singleLineText" },
  { name: "Time", type: "dateTime", options: when },
  { name: "Staff", type: "singleLineText" },
  { name: "Status", type: "singleSelect", options: { choices: [{ name: "Booked", color: "greenLight2" }, { name: "Rescheduled", color: "yellowLight2" }, { name: "Cancelled", color: "redLight2" }] } },
  { name: "Deposit", type: "singleLineText", description: "Stripe test mode" },
  { name: "Source", type: "singleSelect", options: { choices: [{ name: "Voice", color: "blueLight2" }, { name: "Chat", color: "purpleLight2" }] } },
  { name: "Updated", type: "dateTime", options: when },
];

async function api(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`Airtable answered ${res.status}: ${JSON.stringify(body["error"] ?? body).slice(0, 300)}`);
    if (res.status === 403 || res.status === 401) console.error("Check the token's scopes (schema.bases:read and schema.bases:write) and that it has access to this base.");
    process.exit(1);
  }
  return body;
}

const { tables } = (await api("/tables")) as { tables: { id: string; name: string; fields: { name: string }[] }[] };
const found = tables.find((t) => t.name === table);
if (!found) {
  await api("/tables", { method: "POST", body: JSON.stringify({ name: table, description: "Every booking, move, cancel and deposit from the AI front desk (demo data, no personal details).", fields: FIELDS }) });
  console.log(`Created table "${table}" with ${FIELDS.length} fields.`);
} else {
  const have = new Set(found.fields.map((f) => f.name));
  const missing = FIELDS.filter((f) => !have.has(f.name));
  for (const f of missing) await api(`/tables/${found.id}/fields`, { method: "POST", body: JSON.stringify(f) });
  console.log(missing.length ? `Added ${missing.map((f) => f.name).join(", ")} to "${table}".` : `Table "${table}" already has every field.`);
}
