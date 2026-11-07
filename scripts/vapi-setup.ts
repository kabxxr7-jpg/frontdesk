// Creates or updates the Vapi assistant for BUSINESS_DIR, and points your Vapi number at it.
//   npm run vapi:setup                 create (first time) or update (when VAPI_ASSISTANT_ID is in .env)
//   npm run vapi:setup -- --dry-run    print what would be sent (no network; the secret is masked)
//   npm run vapi:setup -- --attach     also point the account's phone number(s) at the assistant
// Needs VAPI_API_KEY (private key) and VAPI_SERVER_SECRET in .env. Writes VAPI_ASSISTANT_ID. Never prints a secret.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { loadBusiness } from "../src/business.ts";
import { buildVapiAssistant } from "../src/vapi.ts";
import { env, loadEnv } from "./env.ts";

loadEnv();
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const attach = args.includes("--attach");
const b = loadBusiness(env("BUSINESS_DIR") ?? "businesses/brightside-family-dental");
const base = (env("PUBLIC_BASE_URL") ?? "").replace(/\/+$/, "");
if (!/^https:\/\//.test(base)) {
  console.error("PUBLIC_BASE_URL must be the https address of the server");
  process.exit(1);
}
const secret = env("VAPI_SERVER_SECRET");
if (!secret || secret.length < 24) {
  console.error("VAPI_SERVER_SECRET (24+ characters) is missing in .env");
  process.exit(1);
}
const key = env("VAPI_API_KEY");
if (!dry && !key) {
  console.error("VAPI_API_KEY (the private key from the Vapi dashboard) is missing in .env");
  process.exit(1);
}
const body = buildVapiAssistant(b, {
  serverUrl: `${base}/vapi`,
  secret,
  maxCallSeconds: Number(env("MAX_CALL_SECONDS") ?? "300"),
  ...(env("VAPI_MODEL") ? { model: env("VAPI_MODEL") as string } : {}),
  ...(env("VAPI_VOICE_ID") ? { voiceId: env("VAPI_VOICE_ID") as string } : {}),
});

if (dry) {
  console.log(JSON.stringify(body, null, 2).split(secret).join("<VAPI_SERVER_SECRET>"));
  process.exit(0);
}

async function api(method: string, path: string, payload?: unknown): Promise<unknown> {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.split(secret as string).join("<secret>").slice(0, 800)}`);
  return text ? JSON.parse(text) : {};
}

function saveEnv(name: string, value: string): void {
  const s = readFileSync(".env", "utf8");
  const re = new RegExp(`^${name}=.*$`, "m");
  if (re.test(s)) writeFileSync(".env", s.replace(re, `${name}=${value}`));
  else appendFileSync(".env", `\n${name}=${value}\n`);
}

let assistantId = env("VAPI_ASSISTANT_ID");
if (assistantId) {
  await api("PATCH", `/assistant/${assistantId}`, body);
  console.log(`updated assistant ${assistantId}`);
} else {
  const r = (await api("POST", "/assistant", body)) as Record<string, unknown>;
  assistantId = String(r["id"]);
  saveEnv("VAPI_ASSISTANT_ID", assistantId);
  console.log(`created assistant ${assistantId} (saved to .env)`);
}

if (attach) {
  const list = (await api("GET", "/phone-number")) as unknown;
  const numbers = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  if (numbers.length === 0) {
    console.error("no phone number on this Vapi account yet: create the free one in the dashboard (Phone Numbers), then run again");
    process.exit(1);
  }
  for (const n of numbers) {
    await api("PATCH", `/phone-number/${String(n["id"])}`, { assistantId, name: `${b.name} demo`.slice(0, 40) });
    console.log(`number ${String(n["number"] ?? n["id"])} now answers with the assistant`);
  }
}
