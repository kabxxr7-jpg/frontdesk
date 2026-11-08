import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadBusiness } from "../src/business.ts";
import { buildBusiness, checkBrief } from "../src/reskin.ts";
import { buildOgCard, buildSite } from "../src/site.ts";
import { rig, type Rig } from "./helpers.ts";

let r: Rig | undefined;
afterEach(() => {
  r?.app.close();
  r?.db.close();
  r = undefined;
});

const plumber = () => loadBusiness("businesses/rapid-rooter-plumbing");

describe("re-skin", () => {
  it("both briefs build valid businesses", () => {
    for (const f of ["briefs/brightside-dental.json", "briefs/rapid-rooter-plumbing.json"]) {
      const { problems } = buildBusiness(JSON.parse(readFileSync(f, "utf8")));
      expect(problems).toEqual([]);
    }
  });
  it("a brief with gaps is explained, not crashed on", () => {
    expect(checkBrief({ name: "X", services: [{ name: "A" }] })).toEqual(
      expect.arrayContaining(["timezone is missing (for example America/New_York)", "services[0] (A): minutes must be a number"]),
    );
    const { problems } = buildBusiness({ name: "Odd Hours", vertical: "generic", timezone: "Mars/Base", address: "x", frontDeskPhone: "123", hours: { mon: [["09:00", "08:00"]] }, services: [{ name: "Thing", minutes: 45, price: 10 }] });
    expect(problems.join(" ")).toMatch(/time zone/);
  });
  it("a minimal brief (no staff, no FAQ) still works: one team does everything", () => {
    const { business, problems } = buildBusiness({ name: "Glow Nails", vertical: "generic", timezone: "America/Denver", address: "1 Example St", frontDeskPhone: "+13035550100", hours: { tue: [["10:00", "19:00"]] }, services: [{ name: "Manicure", minutes: 30, price: 35 }] });
    expect(problems).toEqual([]);
    expect(business.staff).toHaveLength(1);
    expect(business.slug).toBe("glow-nails");
  });
  it("the demo page has no secrets, labels the business fictional and escapes data", () => {
    const b = plumber();
    const html = buildSite({ ...b, name: "<script>x</script>" }, { depositsOn: true, crmOn: false, phone: "+15125550123" });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("Made up:");
    expect(html).toContain("tel:+15125550123");
    expect(html).not.toMatch(/sk_test|re_[A-Za-z0-9]{8}|whsec_/);
    expect(html).toContain("aren't recorded");
    expect(html).not.toContain("<audio");
    expect(html).not.toMatch(/\b[Aa] (appointment|emergency|exam)\b/);
    expect(html).not.toContain('id="webcall"');
  });
  it("the demo page shows the real email and summary, a browser call only with a public key, and links other demos", () => {
    const b = plumber();
    const html = buildSite(b, { depositsOn: true, crmOn: false, phone: "+15125550123", webCall: { publicKey: "pub-key-123", assistantId: "asst-1" }, otherDemos: [{ url: "/", name: "Brightside Family Dental", vertical: "dental clinic" }, { url: "/demos/x/", name: b.name, vertical: b.vertical }], nowMs: Date.UTC(2026, 10, 8, 12) });
    expect(html).toContain('id="webcall"');
    expect(html).toContain('"pub-key-123"');
    expect(html).toContain("@vapi-ai/web@3.0.1");
    expect(html).toContain("srcdoc=");
    expect(html).toContain("Code");
    expect(html).toContain("K7QM");
    expect(html).toContain("Brightside Family Dental");
    expect(html).not.toContain("example.invalid");
    const shared = buildSite(b, { depositsOn: false, crmOn: false, pageUrl: "https://example.com/demos/x/", ogImage: "https://example.com/demos/x/og.png", builderUrl: "https://www.upwork.com/freelancers/someone", nowMs: Date.UTC(2026, 10, 8, 12) });
    expect(shared).toContain('<meta property="og:image" content="https://example.com/demos/x/og.png">');
    expect(shared).toContain('summary_large_image');
    expect(shared).toContain('rel="icon" href="data:image/svg+xml');
    expect(shared).toContain('class="strip"');
    expect(shared).toContain("Work with me");
    expect(buildSite(b, { depositsOn: false, crmOn: false })).not.toContain("og:image");
    expect(buildOgCard(b)).toContain("Every job booked.");
    const other = buildSite(b, { depositsOn: false, crmOn: false, liveDemo: { url: "/", name: "Brightside Family Dental" }, nowMs: Date.UTC(2026, 10, 8, 12) });
    expect(other).toContain('href="/"');
    expect(other).not.toContain("tel:");
  });
});

describe("plumber business behaves like a plumber", () => {
  it("needs the job address to book", async () => {
    r = rig({}, plumber());
    const out = await r.tool("book_appointment", { service: "clogged drain", start: "2026-11-09T09:00", customer_name: "Pat Moss" });
    expect(out).toMatchObject({ ok: false, error: "missing_fields" });
    expect(String(out["message"])).toContain("address");
    const ok = await r.tool("book_appointment", { service: "clogged drain", start: "2026-11-09T09:00", customer_name: "Pat Moss", address: "12 Elm St, Austin" });
    expect(ok["ok"]).toBe(true);
  });
  it("a gas smell is an emergency; a dripping tap is not", async () => {
    r = rig({}, plumber());
    expect(await r.tool("book_appointment", { service: "leak", start: "2026-11-09T09:00", customer_name: "Pat Moss", address: "12 Elm", notes: "I smell gas in the kitchen" })).toMatchObject({ error: "emergency_detected" });
    expect(await r.tool("request_transfer", { reason: "my basement is flooding" })).toMatchObject({ urgency: "emergency" });
    expect(await r.tool("request_transfer", { reason: "dripping faucet" })).toMatchObject({ urgency: "review" });
  });
  it("hours are the plumber's, in Central time", async () => {
    r = rig({}, plumber());
    const out = await r.tool("lookup_faq", { question: "what are your hours" });
    expect(String(out["message"])).toContain("7:00 AM to 6:00 PM");
  });
});
