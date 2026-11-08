// npm run reskin -- <brief.json> [--phone +1...] [--platform Vapi|Retell] [--live-since "8 Nov 2026"] [--out businesses]
//
// Reads a short brief (name, vertical, services, hours, prices, FAQ), writes businesses/<slug>/:
//   business.json      the full data the server runs on (validated)
//   prompt.md          the agent's prompt
//   retell-llm.json    the Retell LLM body (tool URLs from PUBLIC_BASE_URL)
//   retell-agent.json  the Retell agent body (llm id filled in by retell:setup)
//   vapi-assistant.json the Vapi assistant body (the shared secret is a placeholder; vapi:setup sends the real one)
//   site/index.html    the demo page
// and prints what to do next. Exit code 1 with a list of problems when the brief is incomplete.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildPrompt, buildRetellAgent, buildRetellLlm } from "../src/agent-config.ts";
import { buildBusiness, checkBrief, type Brief } from "../src/reskin.ts";
import { buildSite } from "../src/site.ts";
import { buildVapiAssistant } from "../src/vapi.ts";
import { env, loadEnv } from "./env.ts";

loadEnv();
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const briefPath = args.find((a, i) => !a.startsWith("--") && !(i > 0 && (args[i - 1] as string).startsWith("--")));
if (!briefPath) {
  console.error("usage: npm run reskin -- <brief.json> [--phone +1...] [--platform Vapi|Retell] [--live-since '8 Nov 2026']");
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
writeFileSync(
  join(dir, "vapi-assistant.json"),
  `${JSON.stringify(buildVapiAssistant(business, { serverUrl: `${base}/vapi`, secret: "<VAPI_SERVER_SECRET>", maxCallSeconds: Number(env("MAX_CALL_SECONDS") ?? "300") }), null, 2)}
`,
);
writeFileSync(
  join(dir, "site", "index.html"),
  buildSite(business, {
    phone: flag("phone"),
    platform: flag("platform") ?? "Vapi",
    builder: env("BUILDER_NAME") ?? "Kabiir Labs",
    ...(env("BUILDER_URL") ? { builderUrl: env("BUILDER_URL") as string } : {}),
    ...liveOptions(),
    liveSince: flag("live-since"),
    depositsOn: business.services.some((s) => s.depositUsd) && Boolean(env("STRIPE_SECRET_KEY")),
    crmOn: Boolean(env("N8N_WEBHOOK_URL")),
  }),
);
const secs = ((Date.now() - started) / 1000).toFixed(2);

/** Browser call for the business on the live line; a link to the live demo from the others; links between demos. */
function liveOptions() {
  const activeSlug = basename(env("BUSINESS_DIR") ?? "businesses/brightside-family-dental");
  const isActive = activeSlug === business.slug;
  const all = (existsSync(outRoot) ? readdirSync(outRoot) : [])
    .filter((slug) => existsSync(join(outRoot, slug, "business.json")))
    .map((slug) => {
      const bj = JSON.parse(readFileSync(join(outRoot, slug, "business.json"), "utf8")) as { name: string; vertical: string };
      return { slug, name: bj.name, vertical: bj.vertical, url: slug === activeSlug ? "/" : `/demos/${slug}/` };
    });
  const active = all.find((x) => x.slug === activeSlug);
  const publicKey = env("VAPI_PUBLIC_KEY");
  const assistantId = env("VAPI_ASSISTANT_ID");
  return {
    ...(isActive && publicKey && assistantId ? { webCall: { publicKey, assistantId } } : {}),
    ...(!isActive && active ? { liveDemo: { url: active.url, name: active.name } } : {}),
    otherDemos: all.map(({ url, name, vertical }) => ({ url, name, vertical })),
  };
}
console.log(`Re-skinned ${business.name} (${business.vertical}) into ${dir} in ${secs} s:
  business.json  ${business.services.length} services, ${business.staff.length} staff, ${business.faq.length} FAQ entries, ${business.urgent.rules.length} urgent rules
  prompt.md, vapi-assistant.json, retell-llm.json, retell-agent.json, site/index.html
Next (Vapi):
  1. Set BUSINESS_DIR=${dir} in .env (and remove VAPI_ASSISTANT_ID to make a new assistant instead of replacing the current one)
  2. npm run vapi:setup -- --attach      (creates or updates the assistant and points the Vapi number at it)
  3. npm run build:public and restart the server; the demo page is ${dir}/site/index.html`);
