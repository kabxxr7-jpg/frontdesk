// npm run prospect:status
//
// For each sample in ./prospects: when its page was first and last opened (from .runtime/server.log, leaving out checks
// from this machine and link-preview bots), and the browser calls made to its Vapi assistant (count, minutes, last
// call). Times in IST. Reads only; changes nothing. Call content is not fetched or shown.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env, loadEnv } from "./env.ts";
import { callStats, ist, pageOpens, type VapiCall } from "./prospect-status-lib.ts";

loadEnv();
const today = new Date().toISOString().slice(0, 10);
const samples = (existsSync("prospects") ? readdirSync("prospects") : [])
  .filter((s) => existsSync(join("prospects", s, "prospect.json")))
  .map((s) => JSON.parse(readFileSync(join("prospects", s, "prospect.json"), "utf8")) as { slug: string; name: string; createdAt: string; expiresAt: string; assistantId?: string; url: string });
if (!samples.length) {
  console.log("no samples");
  process.exit(0);
}

// The current log and any rotated copies (server.log.1, ...).
const log = (existsSync(".runtime") ? readdirSync(".runtime") : [])
  .filter((f) => /^server\.log(\.\d+)?$/.test(f))
  .map((f) => readFileSync(join(".runtime", f), "utf8"))
  .join("\n");
const key = env("VAPI_API_KEY");

async function calls(assistantId: string): Promise<VapiCall[] | string> {
  if (!key) return "VAPI_API_KEY missing in .env";
  try {
    const res = await fetch(`https://api.vapi.ai/call?assistantId=${encodeURIComponent(assistantId)}&limit=1000`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return `Vapi answered ${res.status}`;
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as VapiCall[]) : "unexpected reply from Vapi";
  } catch (err) {
    return `Vapi not reachable (${err instanceof Error ? err.message : String(err)})`;
  }
}

samples.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
for (const p of samples) {
  const opens = pageOpens(log, p.slug);
  const c = p.assistantId ? await calls(p.assistantId) : "no assistant";
  const stats = typeof c === "string" ? c : callStats(c);
  console.log(`${p.expiresAt < today ? "ENDED" : "live "}  ${p.name}  (${p.slug}, built ${ist(p.createdAt)}, ends ${p.expiresAt})
  page:  ${opens.count ? `opened ${opens.count} time${opens.count === 1 ? "" : "s"}, first ${ist(opens.first as string)}, last ${ist(opens.last as string)}` : "not opened yet"}${opens.skipped ? `  (${opens.skipped} local check${opens.skipped === 1 ? "" : "s"} or link previews left out)` : ""}
  calls: ${typeof stats === "string" ? stats : stats.count ? `${stats.count}, ${stats.minutes} min in all, last ${ist(stats.last as string)}` : "none yet"}
  ${p.url}
`);
}
