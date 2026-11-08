// npm run og: renders the 1200x630 link-preview card (businesses/<slug>/site/og.png) for every business. Run it after
// a re-skin; the demo page points og:image at it when SITE_URL is set. Needs Google Chrome (or CHROME_PATH).
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadBusiness } from "../src/business.ts";
import { env, loadEnv } from "./env.ts";
import { findChrome, renderOg } from "./og-lib.ts";

loadEnv();
if (!findChrome()) {
  console.error("no Chrome found: set CHROME_PATH to a Chrome or Chromium binary");
  process.exit(1);
}
for (const slug of readdirSync("businesses")) {
  const dir = join("businesses", slug);
  if (!existsSync(join(dir, "business.json"))) continue;
  mkdirSync(join(dir, "site"), { recursive: true });
  const out = join(dir, "site", "og.png");
  console.log(`${slug}: ${renderOg(loadBusiness(dir), out, env("BUILDER_NAME") ?? "Kabiir Labs") ? out : "FAILED"}`);
}
