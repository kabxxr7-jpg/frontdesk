// npm run reskin -- <brief.json> [--phone +1...] [--recording file.mp3] [--live-since "8 Nov 2026"] [--out businesses]
//
// Reads a short brief (name, vertical, services, hours, prices, FAQ), writes businesses/<slug>/:
//   business.json      the full data the server runs on (validated)
//   prompt.md          the agent's prompt
//   retell-llm.json    the Retell LLM body (tool URLs from PUBLIC_BASE_URL)
//   retell-agent.json  the Retell agent body (llm id filled in by retell:setup)
//   site/index.html    the demo page
// and prints what to do next. Exit code 1 with a list of problems when the brief is incomplete.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildPrompt, buildRetellAgent, buildRetellLlm } from "../src/agent-config.ts";
import { buildBusiness, checkBrief, type Brief } from "../src/reskin.ts";
import { buildSite } from "../src/site.ts";
import { env, loadEnv } from "./env.ts";

loadEnv();
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const briefPath = args.find((a, i) => !a.startsWith("--") && !(i > 0 && (args[i - 1] as string).startsWith("--")));
if (!briefPath) {
  console.error("usage: npm run reskin -- <brief.json> [--phone +1...] [--recording file.mp3] [--live-since '8 Nov 2026']");
  process.exit(2);
}
const started = Date.now();
let raw: unknown;
try {
  raw = JSON.parse(readFileSync(briefPath, "utf8"));
} catch (err) {
  console.error(`cannot read ${briefPath}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const briefProblems = checkBrief(raw);
if (briefProblems.length > 0) {
  console.error(`The brief needs fixing:\n - ${briefProblems.join("\n - ")}`);
  process.exit(1);
}
const { business, problems } = buildBusiness(raw as Brief);
if (problems.length > 0) {
  console.error(`The brief produced invalid data:\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
const outRoot = flag("out") ?? "businesses";
const dir = join(outRoot, business.slug);
mkdirSync(join(dir, "site"), { recursive: true });
const base = (env("PUBLIC_BASE_URL") ?? "https://REPLACE-WITH-PUBLIC-BASE-URL").replace(/\/+$/, "");
writeFileSync(join(dir, "business.json"), `${JSON.stringify(business, null, 2)}\n`);
writeFileSync(join(dir, "prompt.md"), buildPrompt(business));
writeFileSync(join(dir, "retell-llm.json"), `${JSON.stringify(buildRetellLlm(business, { toolBase: base }), null, 2)}\n`);
writeFileSync(
  join(dir, "retell-agent.json"),
  `${JSON.stringify(buildRetellAgent(business, { llmId: "FILLED_BY_RETELL_SETUP", webhookUrl: `${base}/webhooks/retell`, voiceId: business.agent.voiceId ?? "retell-Cimo", maxCallSeconds: Number(env("MAX_CALL_SECONDS") ?? "300") }), null, 2)}\n`,
);
let recording: string | undefined;
const rec = flag("recording");
if (rec) {
  if (!existsSync(rec)) {
    console.error(`recording not found: ${rec}`);
    process.exit(1);
  }
  recording = basename(rec);
  if (dirname(rec) !== join(dir, "site")) copyFileSync(rec, join(dir, "site", recording));
}
writeFileSync(
  join(dir, "site", "index.html"),
  buildSite(business, {
    phone: flag("phone"),
    recording,
    recordingLabel: flag("recording-label"),
    liveSince: flag("live-since"),
    depositsOn: business.services.some((s) => s.depositUsd) && Boolean(env("STRIPE_SECRET_KEY")),
    crmOn: Boolean(env("N8N_WEBHOOK_URL")),
  }),
);
const secs = ((Date.now() - started) / 1000).toFixed(2);
console.log(`Re-skinned ${business.name} (${business.vertical}) into ${dir} in ${secs} s:
  business.json  ${business.services.length} services, ${business.staff.length} staff, ${business.faq.length} FAQ entries, ${business.urgent.rules.length} urgent rules
  prompt.md, retell-llm.json, retell-agent.json, site/index.html
Next:
  1. BUSINESS_DIR=${dir} npm run retell:setup     (creates or updates the Retell LLM and agent)
  2. Point the Retell number at the new agent (the setup script prints the command)
  3. Restart the server with BUSINESS_DIR=${dir}; the demo page is ${dir}/site/index.html`);
