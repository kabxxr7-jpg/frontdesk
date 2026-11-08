import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { beginMessage, buildPrompt } from "../src/agent-config.ts";
import { loadBusiness } from "../src/business.ts";
import { MemoryCalendar } from "../src/calendar.ts";
import { Db } from "../src/db.ts";
import { MemoryEmail } from "../src/email.ts";
import { buildBusiness, checkBrief, type Brief } from "../src/reskin.ts";
import { createApp, createRouter, requestTags, type Tenant } from "../src/server.ts";
import { buildOgCard, buildSite } from "../src/site.ts";
import { appointmentEmail, eventForAppointment, type Deps } from "../src/tools.ts";
import { DENTAL_DIR, LINK } from "./helpers.ts";
import { sampleSender } from "../src/business.ts";
import { buildVapiAssistant } from "../src/vapi.ts";
import { callStats, ist, pageOpens } from "../scripts/prospect-status-lib.ts";

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

  it("anonymous: no business name anywhere a caller or reader sees it, and nothing made up", () => {
    const base = JSON.parse(readFileSync("briefs/brightside-dental.json", "utf8")) as Brief;
    const secret = "Zorblax Hidden Name";
    const { business: b, problems } = buildBusiness({ ...base, name: secret, prospect: { anonymous: true, placeholders: ["prices"] } }, { builder: "Kabiir Labs", expiresAt: "2026-11-22" });
    expect(problems).toEqual([]);
    b.slug = "your-clinic-c3d4";
    expect(b.prospect?.anonymous).toBe(true);
    expect(beginMessage(b)).toBe(`Thanks for calling, this is ${b.agent.name} at the front desk. How can I help?`);
    const prompt = buildPrompt(b);
    expect(prompt).toContain("never say or make up a business name");
    expect(b.fictionNote).toContain("job post for a dental clinic");
    const html = buildSite(b, { depositsOn: false, crmOn: false, webCall: { publicKey: "pk", assistantId: "a1" }, nowMs: Date.UTC(2026, 10, 8, 12) });
    expect(html).toContain("<title>Your dental clinic&#39;s receptionist, a sample for your job post</title>");
    expect(html).toContain("is a sample AI receptionist for your dental clinic, set up from your job post.");
    expect(html).toContain("Not connected to your real line");
    expect(html).toContain('<div class="logo"><i></i>Your dental clinic</div>');
    expect(html).not.toContain("fictional dental clinic");
    const card = buildOgCard(b);
    const vapi = JSON.stringify(buildVapiAssistant(b, { serverUrl: "https://x.test/t/your-clinic-c3d4/vapi", secret: SECRET, maxCallSeconds: 300 }));
    const deps = { b, publicBaseUrl: "https://x.test/t/your-clinic-c3d4", linkSecret: "s".repeat(20), depositsEnabled: false, transfersLive: false } as unknown as Deps;
    const appt = { id: "apt_1", code: "K7QM", callId: "c", staffId: b.staff[0]!.id, serviceId: b.services[0]!.id, startUtc: Date.UTC(2026, 10, 10, 15), endUtc: Date.UTC(2026, 10, 10, 16), customerName: "Sam", phone: "+15125550100", status: "booked" as const, createdAtMs: 0, updatedAtMs: 0, calendarStatus: "none" as const, depositUsd: 0, depositStatus: "none" as const, history: [] };
    const mail = appointmentEmail(deps, appt, "booked");
    const event = eventForAppointment(deps, appt);
    expect(mail.subject.startsWith("Booked: your appointment on ")).toBe(true);
    expect(mail.html).toContain("Sample front desk");
    expect(event.summary.startsWith("[Sample your-clinic-c3d4] ")).toBe(true);
    expect(sampleSender(b)).toBe("Sample front desk");
    expect(card).toContain("Your dental clinic");
    expect(card).toContain("at the front desk. How can I help?");
    for (const text of [prompt, html, card, vapi, mail.subject, mail.text, mail.html, event.summary, event.description ?? "", b.fictionNote, b.brand.tagline]) expect(text).not.toContain(secret);
  });

  it("a named sample keeps its name; anonymous must be true or false", () => {
    const b = sample();
    expect(beginMessage(b)).toBe(`Thanks for calling Smith Plumbing, this is ${b.agent.name}. How can I help you today?`);
    expect(sampleSender(b)).toBe("Smith Plumbing (sample)");
    expect(checkBrief({ ...brief(), prospect: { anonymous: "yes" } })).toContain("prospect.anonymous must be true or false");
    // Outside a prospect sample the flag does nothing.
    expect(buildBusiness({ ...brief(), prospect: { anonymous: true } }).business.prospect).toBeUndefined();
  });

  it("status: page opens leave out local checks and link previews; calls add up; times in 12-hour IST", () => {
    const log = [
      "2026-11-08T13:15:10.921Z GET /demos/your-clinic-c3d4/ 200 local bot",
      "2026-11-08T13:16:00.000Z GET /demos/your-clinic-c3d4/ 200 bot",
      "2026-11-08T14:00:00.000Z GET /demos/your-clinic-c3d4/ 200",
      "2026-11-09T04:30:00.000Z GET /demos/your-clinic-c3d4/?utm=x 200",
      "2026-11-09T05:00:00.000Z GET /demos/your-clinic-c3d4/og.png 200",
      "2026-11-09T06:00:00.000Z GET /demos/your-clinic-c3d4/ 404",
      "2026-11-09T07:00:00.000Z GET /demos/other-slug/ 200",
    ].join("\n");
    expect(pageOpens(log, "your-clinic-c3d4")).toEqual({ count: 2, first: "2026-11-08T14:00:00.000Z", last: "2026-11-09T04:30:00.000Z", skipped: 2 });
    expect(pageOpens(log, "nobody")).toEqual({ count: 0, skipped: 0 });
    expect(callStats([
      { startedAt: "2026-11-09T05:00:00.000Z", endedAt: "2026-11-09T05:02:30.000Z" },
      { startedAt: "2026-11-09T06:00:00.000Z", endedAt: "2026-11-09T06:01:00.000Z" },
      { createdAt: "2026-11-09T07:00:00.000Z" },
    ])).toEqual({ count: 3, minutes: 3.5, last: "2026-11-09T07:00:00.000Z" });
    expect(callStats([])).toEqual({ count: 0, minutes: 0 });
    expect(ist("2026-11-08T13:15:00.000Z")).toBe("Nov 8, 6:45 PM IST");
    expect(ist("2026-11-08T20:00:00.000Z")).toBe("Nov 9, 1:30 AM IST");
  });

  it("the request log tags checks from this machine and link-preview bots, not visitors through the tunnel", () => {
    const chrome = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/142 Safari/537.36";
    expect(requestTags({ headers: { "cf-connecting-ip": "203.0.113.5", "user-agent": chrome } })).toBe("");
    expect(requestTags({ headers: { "user-agent": "node" } })).toBe(" local bot");
    expect(requestTags({ headers: { "cf-connecting-ip": "203.0.113.5", "user-agent": "Slackbot-LinkExpanding 1.0" } })).toBe(" bot");
    expect(requestTags({ headers: { "cf-connecting-ip": "203.0.113.5" } })).toBe(" bot");
  });
});
