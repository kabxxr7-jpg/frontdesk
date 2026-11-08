// Builds ./public for Caddy: the active business's demo page at the root, every other re-skinned business at
// /demos/<slug>/. Only files under businesses/<slug>/site are copied (never business data or secrets).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { env, loadEnv } from "./env.ts";

loadEnv();
const active = basename(env("BUSINESS_DIR") ?? "businesses/brightside-family-dental");
rmSync("public", { recursive: true, force: true });
mkdirSync("public/demos", { recursive: true });
const done: string[] = [];
for (const slug of readdirSync("businesses")) {
  const site = join("businesses", slug, "site");
  if (!existsSync(join(site, "index.html"))) continue;
  cpSync(site, slug === active ? "public" : join("public", "demos", slug), { recursive: true });
  done.push(slug === active ? `${slug} -> /` : `${slug} -> /demos/${slug}/`);
}
// Prospect samples (npm run prospect) live outside git in ./prospects and are served at /demos/<slug>/ too.
for (const slug of existsSync("prospects") ? readdirSync("prospects") : []) {
  const site = join("prospects", slug, "site");
  if (!existsSync(join(site, "index.html"))) continue;
  cpSync(site, join("public", "demos", slug), { recursive: true });
  done.push(`${slug} (prospect) -> /demos/${slug}/`);
}
console.log(`public/ built: ${done.join(", ")}`);
