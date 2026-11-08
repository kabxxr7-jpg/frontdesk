// npm run prospect -- <brief.json> [--days 14] [--slug existing-slug]
//
// Builds a working sample receptionist for one prospect's job post, live in about a minute:
//   prospects/<slug>/business.json, prompt.md, brief.json, prospect.json, site/index.html, site/og.png
//   a Vapi assistant whose tools call /t/<slug>/vapi on this server (browser calls only, no phone number)
//   the page at <SITE_URL>/demos/<slug>/ (hidden from search engines, labelled as a sample, removed after --days)
// then rebuilds ./public, restarts the server (launchd) and checks the sample answers. Prints the link to send.
// ./prospects is git-ignored: prospects' names never reach the public repo. Remove with npm run prospect:clean.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildPrompt } from "../src/agent-config.ts";
import { validateBusiness } from "../src/business.ts";
import { buildBusiness, checkBrief, type Brief } from "../src/reskin.ts";
import { buildSite } from "../src/site.ts";
import { buildVapiAssistant } from "../src/vapi.ts";
import { env, loadEnv } from "./env.ts";
import { renderOg } from "./og-lib.ts";

const started = Date.now();
loadEnv();
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const briefPath = args.find((a, i) => !a.startsWith("--") && !(i > 0 && (args[i - 1] as string).startsWith("--")));
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
if (!briefPath) fail("usage: npm run prospect -- <brief.json> [--days 14] [--slug existing-slug]");

const need = (n: string): string => env(n) ?? fail(`${n} is missing in .env`);
const base = need("PUBLIC_BASE_URL").replace(/\/+$/, "");
const siteUrl = (env("SITE_URL") ?? base).replace(/\/+$/, "");
const vapiKey = need("VAPI_API_KEY");
const secret = need("VAPI_SERVER_SECRET");
const publicKey = need("VAPI_PUBLIC_KEY");
const builder = env("BUILDER_NAME") ?? "Kabiir Labs";
const days = Math.max(1, Math.min(60, Number(flag("days") ?? "14")));

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(briefPath as string, "utf8"));
} catch (err) {
  fail(`cannot read ${briefPath}: ${err instanceof Error ? err.message : String(err)}`);
}
const briefProblems = checkBrief(raw);
if (briefProblems.length) fail(`The brief needs fixing:\n - ${briefProblems.join("\n - ")}`);
const brief = raw as Brief;

const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const { business, problems } = buildBusiness(brief, { builder, expiresAt });
if (problems.length) fail(`The brief produced invalid data:\n - ${problems.join("\n - ")}`);

// A short random suffix makes the address unguessable; --slug reuses an existing sample.
const slug = flag("slug") ?? `${business.slug.slice(0, 40)}-${randomBytes(3).toString("hex").slice(0, 4)}`;
if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) fail(`bad slug: ${slug}`);
business.slug = slug;
const again = validateBusiness(business);
if (again.length) fail(`invalid business:\n - ${again.join("\n - ")}`);

const dir = join("prospects", slug);
mkdirSync(join(dir, "site"), { recursive: true });
const metaFile = join(dir, "prospect.json");
const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, string>) : {};
writeFileSync(join(dir, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);
writeFileSync(join(dir, "business.json"), `${JSON.stringify(business, null, 2)}\n`);
writeFileSync(join(dir, "prompt.md"), buildPrompt(business));

// The Vapi assistant: same tools and voice as the main demo, pointed at this sample's route.
async function vapi(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: { authorization: `Bearer ${vapiKey}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.split(secret).join("<secret>").slice(0, 600)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
const assistant = { ...buildVapiAssistant(business, { serverUrl: `${base}/t/${slug}/vapi`, secret, maxCallSeconds: Number(env("MAX_CALL_SECONDS") ?? "300") }), name: `sample-${slug}`.slice(0, 40) };
let assistantId = meta["assistantId"];
if (assistantId) await vapi("PATCH", `/assistant/${assistantId}`, assistant);
else assistantId = String((await vapi("POST", "/assistant", assistant))["id"]);

const pageUrl = `${siteUrl}/demos/${slug}/`;
const og = renderOg(business, join(dir, "site", "og.png"), builder);
writeFileSync(
  join(dir, "site", "index.html"),
  buildSite(business, {
    depositsOn: false,
    crmOn: false,
    webCall: { publicKey, assistantId },
    builder,
    ...(env("BUILDER_URL") ? { builderUrl: env("BUILDER_URL") as string } : {}),
    pageUrl,
    ...(og ? { ogImage: `${pageUrl}og.png` } : {}),
  }),
);
writeFileSync(metaFile, `${JSON.stringify({ slug, name: business.name, createdAt: meta["createdAt"] ?? new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt, assistantId, url: pageUrl }, null, 2)}\n`);

// Publish: rebuild ./public and restart the server so it loads the new sample.
execFileSync(process.execPath, ["scripts/build-public.ts"], { stdio: "ignore" });
const plist = join(homedir(), "Library/LaunchAgents/com.kabiirlabs.frontdesk.server.plist");
let restarted = false;
if (existsSync(plist)) {
  execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/com.kabiirlabs.frontdesk.server`]);
  restarted = true;
}

// Check it answers: the page and one tool call through the sample's own route (on this machine).
const local = `http://127.0.0.1:${env("PORT") ?? "8080"}`;
let pageOk = false;
let toolOk = false;
if (restarted) {
  for (let i = 0; i < 20 && !(pageOk && toolOk); i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      pageOk = (await fetch(`${local}/demos/${slug}/`)).status === 200;
      const r = await fetch(`${local}/t/${slug}/vapi`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-frontdesk-token": secret },
        body: JSON.stringify({ message: { type: "tool-calls", call: { id: `check-${slug}`, type: "webCall" }, toolCallList: [{ id: "t1", function: { name: "lookup_faq", arguments: { question: "What are your hours?" } } }] } }),
      });
      toolOk = r.status === 200 && (await r.text()).includes('\\"ok\\":true');
    } catch {
      /* server still starting */
    }
  }
}
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`Sample for ${business.name} ready in ${secs} s
  page:      ${pageUrl}
  checks:    ${restarted ? `page ${pageOk ? "OK" : "FAILED"}, tools ${toolOk ? "OK" : "FAILED"}` : "server not managed by launchd: restart it, then check the page"}
  assistant: ${assistantId}
  ends:      ${expiresAt} (npm run prospect:clean removes it after that)
Next: open the page, press "Talk to ${business.agent.name}", and listen once before sending the link.`);
if (restarted && !(pageOk && toolOk)) process.exit(1);
