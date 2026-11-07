// Creates or updates the Retell LLM and agent for BUSINESS_DIR, from the same data the server runs on.
//   npm run retell:setup                 create (first time) or update (when RETELL_LLM_ID / RETELL_AGENT_ID are in .env)
//   npm run retell:setup -- --dry-run    print what would be sent (no network)
//   npm run retell:setup -- --attach +12015550123   also point that Retell number (bought by you) at the agent,
//                                                   with the inbound webhook that enforces the daily call cap
// Writes the new ids into .env. Never prints the API key. Buys nothing.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { buildRetellAgent, buildRetellLlm } from "../src/agent-config.ts";
import { loadBusiness } from "../src/business.ts";
import { env, loadEnv } from "./env.ts";

loadEnv();
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const attachIdx = args.indexOf("--attach");
const attach = attachIdx >= 0 ? args[attachIdx + 1] : undefined;
const b = loadBusiness(env("BUSINESS_DIR") ?? "businesses/brightside-family-dental");
const base = (env("PUBLIC_BASE_URL") ?? "").replace(/\/+$/, "");
if (!/^https:\/\//.test(base)) {
  console.error("PUBLIC_BASE_URL must be the https address of the server");
  process.exit(1);
}
const key = env("RETELL_API_KEY");
if (!dry && !key) {
  console.error("RETELL_API_KEY is missing in .env");
  process.exit(1);
}
const voiceId = env("RETELL_VOICE_ID") ?? b.agent.voiceId ?? "retell-Cimo";
const llmBody = buildRetellLlm(b, { toolBase: base, ...(env("RETELL_MODEL") ? { model: env("RETELL_MODEL") as string } : {}) });

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.retellai.com${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function saveEnv(name: string, value: string): void {
  const s = readFileSync(".env", "utf8");
  const re = new RegExp(`^${name}=.*$`, "m");
  if (re.test(s)) writeFileSync(".env", s.replace(re, `${name}=${value}`));
  else appendFileSync(".env", `\n${name}=${value}\n`);
}

if (dry) {
  console.log(JSON.stringify({ llm: llmBody, agent: buildRetellAgent(b, { llmId: "<llm id>", webhookUrl: `${base}/webhooks/retell`, voiceId, maxCallSeconds: Number(env("MAX_CALL_SECONDS") ?? "300") }) }, null, 2));
  process.exit(0);
}

let llmId = env("RETELL_LLM_ID");
if (llmId) {
  await api("PATCH", `/update-retell-llm/${llmId}`, llmBody);
  console.log(`updated LLM ${llmId}`);
} else {
  const r = await api("POST", "/create-retell-llm", llmBody);
  llmId = String(r["llm_id"]);
  saveEnv("RETELL_LLM_ID", llmId);
  console.log(`created LLM ${llmId}`);
}
const agentBody = buildRetellAgent(b, { llmId, webhookUrl: `${base}/webhooks/retell`, voiceId, maxCallSeconds: Number(env("MAX_CALL_SECONDS") ?? "300") });
let agentId = env("RETELL_AGENT_ID");
if (agentId) {
  await api("PATCH", `/update-agent/${agentId}`, agentBody);
  console.log(`updated agent ${agentId}`);
} else {
  const r = await api("POST", "/create-agent", agentBody);
  agentId = String(r["agent_id"]);
  saveEnv("RETELL_AGENT_ID", agentId);
  console.log(`created agent ${agentId}`);
}
if (attach) {
  if (!/^\+1\d{10}$/.test(attach)) {
    console.error("--attach needs the Retell number in E.164, e.g. +12015550123");
    process.exit(1);
  }
  await api("PATCH", `/update-phone-number/${encodeURIComponent(attach)}`, {
    inbound_agents: [{ agent_id: agentId, agent_version: "latest", weight: 1 }],
    inbound_webhook_url: `${base}/webhooks/retell-inbound`,
    nickname: `frontdesk ${b.slug}`,
  });
  saveEnv("RETELL_PHONE_NUMBER", attach);
  console.log(`number ${attach} now answers with agent ${agentId} (daily cap via ${base}/webhooks/retell-inbound)`);
}
