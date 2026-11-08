import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/agent-config.ts";
import { loadBusiness } from "../src/business.ts";
import { MemoryCalendar } from "../src/calendar.ts";
import { Db } from "../src/db.ts";
import { MemoryEmail } from "../src/email.ts";
import { buildBusiness, type Brief } from "../src/reskin.ts";
import { createApp, createRouter, type Tenant } from "../src/server.ts";
import { buildOgCard, buildSite } from "../src/site.ts";
import { appointmentEmail, eventForAppointment, type Deps } from "../src/tools.ts";
import { DENTAL_DIR, LINK } from "./helpers.ts";

const SECRET = "vapi-secret-0123456789abcdef0123";
const brief = (): Brief => ({ ...(JSON.parse(readFileSync("briefs/rapid-rooter-plumbing.json", "utf8")) as Brief), name: "Smith Plumbing", prospect: { placeholders: ["prices", "team names"] } });
const sample = () => {
  const { business, problems } = buildBusiness(brief(), { builder: "Kabiir Labs", expiresAt: "2026-11-22" });
  expect(problems).toEqual([]);
  business.slug = "smith-plumbing-a1b2";
  return business;
};
const toolCall = { message: { type: "tool-calls", call: { id: "call-x", type: "webCall" }, toolCallList: [{ id: "t1", function: { name: "lookup_faq", arguments: { question: "What are your hours?" } } }] } };

describe("prospect samples", () => {
  it("label the sample honestly everywhere: page, prompt, email, calendar, preview card", () => {
    const b = sample();
    expect(b.prospect).toEqual({ placeholders: ["prices", "team names"], builder: "Kabiir Labs", expiresAt: "2026-11-22" });
    expect(b.fictionNote).toContain("not affiliated with Smith Plumbing");
    expect(b.fictionNote).toContain("prices, team names");
    expect(buildPrompt(b)).toContain("not the business's real phone line");
    const html = buildSite(b, { depositsOn: false, crmOn: false, otherDemos: [{ url: "/", name: "Brightside Family Dental", vertical: "dental clinic" }], nowMs: Date.UTC(2026, 10, 8, 12) });
    expect(html).toContain('<meta name="robots" content="noindex,nofollow,noarchive">');
    expect(html).toContain("Sample built for your job post by <b>Kabiir Labs</b>");
    expect(html).toContain("Not affiliated with Smith Plumbing");
    expect(html).toContain("Removed after November 22, 2026");
    expect(html).toContain("<b>Placeholders:</b> prices, team names.");
    expect(html).not.toContain("Brightside Family Dental");
    expect(html).not.toContain("Fictional plumbing");
    const deps = { b, publicBaseUrl: "https://x.test/t/smith-plumbing-a1b2", linkSecret: "s".repeat(20), depositsEnabled: false, transfersLive: false } as unknown as Deps;
    const appt = { id: "apt_1", code: "K7QM", callId: "c", staffId: b.staff[0]!.id, serviceId: b.services[0]!.id, startUtc: Date.UTC(2026, 10, 10, 15), endUtc: Date.UTC(2026, 10, 10, 16), customerName: "Sam", phone: "+15125550100", address: "1 A St", status: "booked" as const, createdAtMs: 0, updatedAtMs: 0, calendarStatus: "none" as const, depositUsd: 0, depositStatus: "none" as const, history: [] };
    expect(appointmentEmail(deps, appt, "booked").text).toContain("sample receptionist built by Kabiir Labs");
    expect(appointmentEmail(deps, appt, "booked").text).not.toContain("fictional business");
    expect(eventForAppointment(deps, appt).summary.startsWith("[Smith Plumbing] ")).toBe(true);
    expect(buildOgCard(b)).toContain("Sample built for your job post");
  });

  it("the main demo keeps its own wording", () => {
    const b = loadBusiness(DENTAL_DIR);
    expect(b.prospect).toBeUndefined();
    const html = buildSite(b, { depositsOn: true, crmOn: false });
    expect(html).not.toContain("noindex");
    expect(html).toContain("Fictional dental clinic");
  });

  it("the router sends /t/<slug>/ to that sample, strips the prefix, and refuses unknown or ended samples", async () => {
    const mk = (b: ReturnType<typeof sample> | ReturnType<typeof loadBusiness>, db: Db) =>
      createApp({ b, db, calendar: new MemoryCalendar(), email: new MemoryEmail(), vapiSecret: SECRET, publicBaseUrl: "https://desk.test", linkSecret: LINK, clock: () => Date.UTC(2026, 10, 8, 14) });
    const dbs = [new Db(":memory:"), new Db(":memory:")];
    const main = mk(loadBusiness(DENTAL_DIR), dbs[0]!);
    const tenant = mk(sample(), dbs[1]!);
    const tenants = new Map<string, Tenant>([["smith-plumbing-a1b2", { app: tenant, expiresAt: "2026-11-22" }]]);
    let now = Date.UTC(2026, 10, 8, 14);
    const router = createRouter(main, tenants, () => now);
    const post = (url: string) => router.handle({ method: "POST", url, headers: { "x-frontdesk-token": SECRET }, body: Buffer.from(JSON.stringify(toolCall)) });

    const viaTenant = await post("/t/smith-plumbing-a1b2/vapi");
    expect(viaTenant.status).toBe(200);
    expect(viaTenant.body).toContain('\\"ok\\":true');
    expect((await post("/vapi")).status).toBe(200);
    expect((await post("/t/nobody-here/vapi")).status).toBe(404);
    expect((await router.handle({ method: "POST", url: "/t/smith-plumbing-a1b2/vapi", headers: {}, body: Buffer.from(JSON.stringify(toolCall)) })).status).toBe(401);
    now = Date.UTC(2026, 10, 23, 1);
    expect((await post("/t/smith-plumbing-a1b2/vapi")).status).toBe(410);
    router.close();
    for (const d of dbs) d.close();
  });
});
