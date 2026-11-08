// npm run prospect:clean                 remove every sample past its end date
// npm run prospect:clean -- --slug <s>   remove one sample now
// npm run prospect:clean -- --list       list samples and their end dates
// Removing a sample deletes its Vapi assistant, its folder in ./prospects and its bookings database, rebuilds ./public
// and restarts the server (launchd).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env, loadEnv } from "./env.ts";

loadEnv();
const args = process.argv.slice(2);
const only = args.includes("--slug") ? args[args.indexOf("--slug") + 1] : undefined;
const today = new Date().toISOString().slice(0, 10);
const samples = (existsSync("prospects") ? readdirSync("prospects") : [])
  .filter((s) => existsSync(join("prospects", s, "prospect.json")))
  .map((s) => JSON.parse(readFileSync(join("prospects", s, "prospect.json"), "utf8")) as { slug: string; name: string; expiresAt: string; assistantId?: string; url: string });

if (args.includes("--list")) {
  if (!samples.length) console.log("no samples");
  for (const p of samples) console.log(`${p.expiresAt < today ? "ENDED " : "live  "} ${p.expiresAt}  ${p.name}  ${p.url}`);
  process.exit(0);
}

const doomed = samples.filter((p) => (only ? p.slug === only : p.expiresAt < today));
if (only && !doomed.length) {
  console.error(`no sample with slug ${only}`);
  process.exit(1);
}
const key = env("VAPI_API_KEY");
for (const p of doomed) {
  if (p.assistantId && key) {
    const res = await fetch(`https://api.vapi.ai/assistant/${p.assistantId}`, { method: "DELETE", headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok && res.status !== 404) console.error(`${p.slug}: Vapi assistant delete returned ${res.status}; delete it in the dashboard`);
  }
  rmSync(join("prospects", p.slug), { recursive: true, force: true });
  for (const f of (existsSync(".runtime/prospects") ? readdirSync(".runtime/prospects") : []).filter((f) => f.startsWith(`${p.slug}.db`))) rmSync(join(".runtime/prospects", f), { force: true });
  console.log(`removed ${p.name} (${p.slug})`);
}
if (doomed.length) {
  execFileSync(process.execPath, ["scripts/build-public.ts"], { stdio: "ignore" });
  const plist = join(homedir(), "Library/LaunchAgents/com.kabiirlabs.frontdesk.server.plist");
  if (existsSync(plist)) execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/com.kabiirlabs.frontdesk.server`]);
} else console.log("nothing to remove");
