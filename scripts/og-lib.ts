// Renders a business's 1200x630 link-preview card to a PNG with headless Chrome (used by `npm run og` and prospects).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Business } from "../src/business.ts";
import { buildOgCard } from "../src/site.ts";
import { env } from "./env.ts";

export function findChrome(): string | undefined {
  return [env("CHROME_PATH"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(
    (p): p is string => Boolean(p && existsSync(p)),
  );
}

/** Returns false when no Chrome is available (the page then simply has no preview image). */
export function renderOg(b: Business, outPng: string, builder: string): boolean {
  const chrome = findChrome();
  if (!chrome) return false;
  const work = mkdtempSync(join(tmpdir(), "og-"));
  try {
    const html = join(work, "card.html");
    writeFileSync(html, buildOgCard(b, builder));
    execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=4000", `--user-data-dir=${join(work, "profile")}`, "--window-size=1200,630", `--screenshot=${resolve(outPng)}`, `file://${html}`], { stdio: "ignore", timeout: 60_000 });
    return existsSync(outPng);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
