// npm run og: renders the 1200x630 link-preview card (businesses/<slug>/site/og.png) for every business, with headless
// Chrome. Run it after a re-skin; the demo page points og:image at it when SITE_URL is set. Needs Google Chrome
// (or CHROME_PATH). Network is only used for the web font; without it the card falls back to the system font.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBusiness } from "../src/business.ts";
import { buildOgCard } from "../src/site.ts";
import { env, loadEnv } from "./env.ts";

loadEnv();
const chrome = [env("CHROME_PATH"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(
  (p): p is string => Boolean(p && existsSync(p)),
);
if (!chrome) {
  console.error("no Chrome found: set CHROME_PATH to a Chrome or Chromium binary");
  process.exit(1);
}
const root = "businesses";
const work = mkdtempSync(join(tmpdir(), "og-"));
try {
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    if (!existsSync(join(dir, "business.json"))) continue;
    const b = loadBusiness(dir);
    const html = join(work, `${slug}.html`);
    writeFileSync(html, buildOgCard(b, env("BUILDER_NAME") ?? "Kabiir Labs"));
    mkdirSync(join(dir, "site"), { recursive: true });
    const out = join(process.cwd(), dir, "site", "og.png");
    execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=4000", `--user-data-dir=${join(work, "profile")}`, "--window-size=1200,630", `--screenshot=${out}`, `file://${html}`], { stdio: "ignore", timeout: 60_000 });
    console.log(`${slug}: ${existsSync(out) ? out : "FAILED"}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
