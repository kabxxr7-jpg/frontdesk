import { afterEach, describe, expect, it } from "vitest";
import { loadBusiness } from "../src/business.ts";
import { signBody } from "../src/signature.ts";
import { payToken } from "../src/stripe.ts";
import { checkoutCompleted, DENTAL_DIR, KEY, LINK, rig, SAT_9AM, type Rig } from "./helpers.ts";

let r: Rig;
afterEach(() => {
  r?.app.close();
  r?.db.close();
});

const appt = (out: Record<string, unknown>) => out["appointment"] as Record<string, string>;

async function bookFirst(rg: Rig, extra: Record<string, unknown> = {}) {
  const avail = await rg.tool("get_availability", { service: "new patient", date_from: "2026-11-09" });
  const slots = avail["slots"] as { start: string }[];
  const start = (slots[0] as { start: string }).start;
  const out = await rg.tool("book_appointment", { service: "new_patient_visit", start, customer_name: "Sam Rivera", email: "sam dot rivera at example dot com", notes: "first visit", ...extra });
  return { out, start };
}

describe("signature and routing", () => {
  it("rejects an unsigned tool call and a wrong signature", async () => {
    r = rig();
    expect((await r.post("/tools/lookup_faq", { name: "lookup_faq", args: { question: "hours" } }, { sign: false })).status).toBe(401);
    const raw = JSON.stringify({ name: "lookup_faq", args: {} });
    const bad = await r.app.handle({ method: "POST", url: "/tools/lookup_faq", headers: { "x-retell-signature": signBody(raw, "other-key-123", r.now.ms) }, body: Buffer.from(raw) });
    expect(bad.status).toBe(401);
  });
  it("404 for an unknown tool, 400 for a name mismatch, 413 for a huge body", async () => {
    r = rig();
    expect((await r.post("/tools/drop_tables", { name: "drop_tables", args: {} })).status).toBe(404);
    expect((await r.post("/tools/lookup_faq", { name: "book_appointment", args: {} })).status).toBe(400);
    expect((await r.post("/tools/lookup_faq", "x".repeat(300 * 1024))).status).toBe(413);
  });
  it("healthz reports features and no secrets", async () => {
    r = rig();
    const h = await r.get("/healthz");
    expect(h.status).toBe(200);
    expect(h.body).not.toContain(KEY);
    expect(JSON.parse(h.body)).toMatchObject({ ok: true, calendar: "memory", deposits: true });
  });
  it("an identical signed request replayed gets the first answer, and runs once", async () => {
    r = rig();
    const body = { name: "book_appointment", args: { service: "cleaning", start: "2026-11-09T09:00", customer_name: "Ann Lee" }, call: { call_id: "c1", from_number: "+12015550199" } };
    const raw = JSON.stringify(body);
    const h = { "x-retell-signature": signBody(raw, KEY, r.now.ms) };
    const a = await r.app.handle({ method: "POST", url: "/tools/book_appointment", headers: h, body: Buffer.from(raw) });
    const b = await r.app.handle({ method: "POST", url: "/tools/book_appointment", headers: h, body: Buffer.from(raw) });
    expect(a.body).toBe(b.body);
    expect(r.db.allAppointments()).toHaveLength(1);
  });
});

describe("booking", () => {
  it("books into the calendar, emails the caller with a deposit link, and is idempotent", async () => {
    r = rig();
    const { out, start } = await bookFirst(r);
    expect(out["ok"]).toBe(true);
    expect(String(out["message"])).toMatch(/confirmation code is [A-Z0-9]-[A-Z0-9]-[A-Z0-9]-[A-Z0-9]/);
    expect(out["calendar"]).toBe("synced");
    expect(r.cal.events.size).toBe(1);
    const ev = [...r.cal.events.values()][0]!;
    expect(ev.summary).toContain("Sam Rivera");
    expect(ev.summary).toContain("[deposit due]");
    await r.app.settle();
    expect(r.mail.sent).toHaveLength(1);
    const mail = r.mail.sent[0]!;
    expect(mail.to).toBe("sam.rivera@example.com");
    expect(mail.text).toContain("https://desk.test/pay/apt_00001.");
    expect(mail.text).toContain("fictional");
    // same call asks again: same appointment, no second email
    const again = await r.tool("book_appointment", { service: "new_patient_visit", start, customer_name: "sam rivera", email: "sam.rivera@example.com" });
    expect(again["already_booked"]).toBe(true);
    await r.app.settle();
    expect(r.mail.sent).toHaveLength(1);
    expect(r.db.allAppointments()).toHaveLength(1);
  });

  it("refuses a double booking of the same person and offers alternatives", async () => {
    r = rig();
    // Saturday: only Dr. Chen and Dr. Reyes and Jordan; the aligner consult is done by Chen and Reyes
    const first = await r.tool("book_appointment", { service: "aligner_consult", start: "2026-11-09T10:00", customer_name: "A One", staff: "Chen" });
    expect(first["ok"]).toBe(true);
    const second = await r.tool("book_appointment", { service: "aligner_consult", start: "2026-11-09T10:00", customer_name: "B Two", staff: "Chen" }, { call_id: "call_B", from_number: "+12015550111" });
    expect(second).toMatchObject({ ok: false, error: "slot_taken" });
    expect((second["alternatives"] as unknown[]).length).toBeGreaterThan(0);
    // without asking for Chen, the other dentist takes it
    const third = await r.tool("book_appointment", { service: "aligner_consult", start: "2026-11-09T10:00", customer_name: "C Three" }, { call_id: "call_C", from_number: "+12015550112" });
    expect(third["ok"]).toBe(true);
    expect(appt(third)["staff_name"]).toBe("Dr. Marcus Reyes");
  });

  it("a 60-minute visit cannot overlap a 30-minute one that starts inside it", async () => {
    r = rig();
    await r.tool("book_appointment", { service: "aligner_consult", start: "2026-11-09T10:30", customer_name: "A One", staff: "chen" });
    const out = await r.tool("book_appointment", { service: "filling", start: "2026-11-09T10:00", customer_name: "B Two", staff: "chen" }, { call_id: "call_B", from_number: "+12015550111" });
    expect(out).toMatchObject({ ok: false, error: "slot_taken" });
  });

  it("respects a block typed into the real calendar", async () => {
    r = rig();
    r.cal.blocks.push([Date.UTC(2026, 10, 9, 14, 0), Date.UTC(2026, 10, 9, 17, 0)]); // Mon 9:00-12:00 New York
    const out = await r.tool("book_appointment", { service: "aligner_consult", start: "2026-11-09T10:00", customer_name: "A One" });
    expect(out).toMatchObject({ ok: false, error: "slot_taken" });
    const avail = await r.tool("get_availability", { service: "aligner_consult", date_from: "2026-11-09", date_to: "2026-11-09" });
    const starts = (avail["slots"] as { start: string }[]).map((s) => s.start);
    expect(starts.every((s) => !/T(09|10|11):/.test(s))).toBe(true);
  });

  it("out of hours, closed day, holiday, too soon and in the past", async () => {
    r = rig();
    expect(await r.tool("book_appointment", { service: "cleaning", start: "2026-11-09T19:00", customer_name: "A B" })).toMatchObject({ error: "outside_hours" });
    expect(await r.tool("book_appointment", { service: "cleaning", start: "2026-11-08T10:00", customer_name: "A B" })).toMatchObject({ error: "closed_day" });
    expect(await r.tool("book_appointment", { service: "cleaning", start: "2026-11-26T10:00", customer_name: "A B" })).toMatchObject({ error: "closed_date" });
    expect(await r.tool("book_appointment", { service: "cleaning", start: "2026-11-07T09:30", customer_name: "A B" })).toMatchObject({ error: "too_soon" });
    expect(await r.tool("book_appointment", { service: "cleaning", start: "2026-11-06T10:00", customer_name: "A B" })).toMatchObject({ error: "start_in_past" });
  });

  it("asks for what is missing, a bad email, an unknown service", async () => {
    r = rig();
    const out = await r.tool("book_appointment", { service: "cleaning" }, { call_id: "call_W" });
    expect(out).toMatchObject({ ok: false, error: "missing_fields" });
    expect(String(out["message"])).toContain("a phone number");
    expect(await r.tool("book_appointment", { service: "cleaning", start: "2026-11-09T09:00", customer_name: "A B", email: "not an email" })).toMatchObject({ error: "invalid_email" });
    expect(await r.tool("book_appointment", { service: "brain surgery", start: "2026-11-09T09:00", customer_name: "A B" })).toMatchObject({ error: "unknown_service" });
  });

  it("still books when the calendar is down, and says so in the summary", async () => {
    r = rig();
    r.cal.failNext = "create";
    const out = await r.tool("book_appointment", { service: "cleaning", start: "2026-11-09T09:00", customer_name: "Ann Lee" });
    expect(out["ok"]).toBe(true);
    expect(out["calendar"]).toBe("failed");
    expect(r.db.allAppointments()[0]!.calendarStatus).toBe("failed");
  });

  it("a failed confirmation email is logged for the team; the booking stands", async () => {
    r = rig();
    r.mail.failNext = 1;
    const out = await r.tool("book_appointment", { service: "cleaning", start: "2026-11-09T09:00", customer_name: "Ann Lee", email: "ann@example.com" });
    expect(out["ok"]).toBe(true);
    await r.app.settle();
    const log = r.db.toolLogFor("call_A");
    expect(log.some((e) => e.outcome === "email_failed")).toBe(true);
  });
});

describe("emergencies and transfers", () => {
  it("emergency words in a booking stop the booking", async () => {
    r = rig();
    const out = await r.tool("book_appointment", { service: "emergency exam", start: "2026-11-09T09:00", customer_name: "Ann Lee", notes: "my son's tooth got knocked out playing hockey" });
    expect(out).toMatchObject({ ok: false, error: "emergency_detected", urgency: "emergency" });
    expect(r.db.allAppointments()).toHaveLength(0);
  });
  it("demo line: no transfer tool is called, the caller is told plainly", async () => {
    r = rig();
    const out = await r.tool("request_transfer", { reason: "my face is swollen and I have a fever" });
    expect(out).toMatchObject({ urgency: "emergency", transfer: false, tool_to_call: null, destination: "front_desk" });
    expect(String(out["message"])).toContain("demonstration line");
  });
  it("live transfers: the tool to call is named", async () => {
    r = rig({ transfersLive: true });
    const out = await r.tool("request_transfer", { reason: "can I talk to someone about my bill" });
    expect(out).toMatchObject({ transfer: true, tool_to_call: "transfer_to_front_desk", urgency: "standard" });
  });
  it("after hours an emergency goes to the on-call line; a normal request becomes a message", async () => {
    r = rig({ transfersLive: true });
    r.now.ms = Date.UTC(2026, 10, 8, 3, 0); // Sat 10 PM New York
    expect(await r.tool("request_transfer", { reason: "the bleeding will not stop" })).toMatchObject({ destination: "emergency_line", tool_to_call: "transfer_to_emergency_line" });
    expect(await r.tool("request_transfer", { reason: "question about my bill" })).toMatchObject({ destination: "none", transfer: false });
  });
  it("a negated symptom is not an emergency", async () => {
    r = rig();
    const out = await r.tool("book_appointment", { service: "cleaning", start: "2026-11-09T09:00", customer_name: "Ann Lee", notes: "no swelling, just a routine cleaning" });
    expect(out["ok"]).toBe(true);
  });
  it("advice questions are declined", async () => {
    r = rig();
    expect(await r.tool("lookup_faq", { question: "should I take ibuprofen for this" })).toMatchObject({ matched: "advice_declined" });
  });
});

describe("FAQ", () => {
  it("answers from the sheet with prices from the data", async () => {
    r = rig();
    const ins = await r.tool("lookup_faq", { question: "Do you take Delta Dental?" });
    expect(ins["matched"]).toBe("insurance");
    const hours = await r.tool("lookup_faq", { question: "are you open on saturday" });
    expect(String(hours["message"])).toContain("Saturday from 9:00 AM to 2:00 PM");
    const np = await r.tool("lookup_faq", { question: "are you taking new patients" });
    expect(String(np["message"])).toContain("$189");
    expect(String(np["message"])).toContain("$50");
    expect((await r.tool("lookup_faq", { question: "what's the weather on mars" }))["matched"]).toBe(null);
  });
});

describe("reschedule and cancel", () => {
  it("moves by code, updates the calendar, emails the new time; same time again is a no-op", async () => {
    r = rig();
    const { out } = await bookFirst(r);
    const code = appt(out)["code"];
    const moved = await r.tool("reschedule_appointment", { code, new_start: "2026-11-10T14:00" }, { call_id: "call_R", from_number: "+12015559999" });
    expect(moved["ok"]).toBe(true);
    const ev = [...r.cal.events.values()][0]!;
    expect(ev.startUtc).toBe(Date.UTC(2026, 10, 10, 19, 0));
    const same = await r.tool("reschedule_appointment", { code, new_start: "2026-11-10T14:00" }, { call_id: "call_R" });
    expect(same["unchanged"]).toBe(true);
    await r.app.settle();
    expect(r.mail.sent.map((m) => m.subject).filter((s) => s.includes("moved"))).toHaveLength(1);
  });
  it("finds by caller number; asks which when there are two", async () => {
    r = rig();
    await r.tool("book_appointment", { service: "cleaning", start: "2026-11-09T09:00", customer_name: "Ann Lee" });
    await r.tool("book_appointment", { service: "filling", start: "2026-11-10T09:00", customer_name: "Ann Lee" });
    const which = await r.tool("cancel_appointment", {}, { call_id: "call_Z", from_number: "+12015551234" });
    expect(which).toMatchObject({ ok: false, error: "which_appointment" });
    const done = await r.tool("cancel_appointment", { current_start: "2026-11-10T09:00" }, { call_id: "call_Z", from_number: "+12015551234" });
    expect(done["ok"]).toBe(true);
    expect(r.cal.events.size).toBe(1);
    const again = await r.tool("cancel_appointment", { code: appt(done)["code"] }, { call_id: "call_Z" });
    expect(again["already_cancelled"]).toBe(true);
  });
  it("flags a late cancellation", async () => {
    r = rig();
    const b = await r.tool("book_appointment", { service: "cleaning", start: "2026-11-07T13:00", customer_name: "Ann Lee" });
    const c = await r.tool("cancel_appointment", { code: appt(b)["code"] });
    expect(c["late_cancellation"]).toBe(true);
    expect(String(c["message"])).toContain("$40");
  });
  it("unknown code", async () => {
    r = rig();
    expect(await r.tool("cancel_appointment", { code: "QQQQ" })).toMatchObject({ error: "not_found" });
  });
});

describe("deposits (Stripe test mode)", () => {
  it("pay link redirects to Checkout, webhook marks paid once, receipt emailed once, calendar title updated", async () => {
    r = rig();
    const { out } = await bookFirst(r);
    const a = r.db.byCode(appt(out)["code"]!)!;
    const page = await r.get(`/pay/${payToken(a.id, LINK)}`);
    expect(page.status).toBe(303);
    expect(page.headers["location"]).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const stripeCall = r.fetchCalls.find((c) => c.url.includes("checkout/sessions"))!;
    expect(String(stripeCall.init?.body)).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=5000");
    // second click reuses the session
    await r.get(`/pay/${payToken(a.id, LINK)}`);
    expect(r.fetchCalls.filter((c) => c.url.includes("checkout/sessions"))).toHaveLength(1);
    const ev = checkoutCompleted("evt_1", a.id);
    expect(JSON.parse((await r.stripeEvent(ev)).body)).toMatchObject({ status: "deposit_paid" });
    expect(JSON.parse((await r.stripeEvent(ev)).body)).toMatchObject({ status: "duplicate" });
    expect(JSON.parse((await r.stripeEvent(checkoutCompleted("evt_2", a.id))).body)).toMatchObject({ status: "deposit_paid" });
    await r.app.settle();
    expect(r.db.getAppointment(a.id)!.depositStatus).toBe("paid");
    expect(r.mail.sent.filter((m) => m.subject.includes("deposit received"))).toHaveLength(1);
    expect([...r.cal.events.values()][0]!.summary).toContain("[deposit paid]");
    const paidPage = await r.get(`/pay/${payToken(a.id, LINK)}`);
    expect(paidPage.body).toContain("already paid");
  });
  it("rejects a bad signature, a forged token and a live-mode event", async () => {
    r = rig();
    const { out } = await bookFirst(r);
    const a = r.db.byCode(appt(out)["code"]!)!;
    expect((await r.stripeEvent(checkoutCompleted("evt_x", a.id), { badSig: true })).status).toBe(400);
    expect((await r.get(`/pay/${a.id}.000000000000000000000000`)).status).toBe(404);
    expect((await r.stripeEvent({ ...checkoutCompleted("evt_live", a.id), livemode: true })).status).toBe(400);
    expect(r.db.getAppointment(a.id)!.depositStatus).toBe("due");
  });
  it("refuses a live Stripe key at startup", async () => {
    const { StripeClient } = await import("../src/stripe.ts");
    expect(() => new StripeClient({ secretKey: "sk_live_abc" })).toThrow(/LIVE/);
  });
});

describe("post-call webhook", () => {
  const ended = (id: string) => ({ event: "call_ended", call: { call_id: id, call_type: "phone_call", from_number: "+12015551234", start_timestamp: SAT_9AM, end_timestamp: SAT_9AM + 95_000, transcript: "SECRET TRANSCRIPT" } });
  const analyzed = (id: string) => ({ event: "call_analyzed", call: { call_id: id, call_analysis: { call_summary: "Caller booked a cleaning.", user_sentiment: "Positive" } } });

  it("sends one summary to n8n with a signature, never the transcript; duplicates send nothing", async () => {
    r = rig({ n8n: { url: "https://n8n.test/webhook/x", secret: "n8n-secret-0123456789" } });
    await r.tool("book_appointment", { service: "cleaning", start: "2026-11-09T09:00", customer_name: "Ann Lee" });
    expect((await r.post("/webhooks/retell", ended("call_A"))).status).toBe(200);
    expect(r.fetchCalls.filter((c) => c.url.startsWith("https://n8n.test"))).toHaveLength(0);
    const res = await r.post("/webhooks/retell", analyzed("call_A"));
    expect(JSON.parse(res.body).status).toBe("summary_sent:n8n");
    const dup = await r.post("/webhooks/retell", analyzed("call_A"));
    expect(JSON.parse(dup.body).status).toBe("duplicate");
    const sent = r.fetchCalls.filter((c) => c.url.startsWith("https://n8n.test"));
    expect(sent).toHaveLength(1);
    const body = String(sent[0]!.init?.body);
    expect(body).not.toContain("SECRET TRANSCRIPT");
    const parsed = JSON.parse(body);
    expect(parsed.summary).toMatchObject({ outcome: "booked", duration_seconds: 95, platform_summary: "Caller booked a cleaning." });
    expect((sent[0]!.init?.headers as Record<string, string>)["x-frontdesk-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("n8n down: falls back to the team email; both down: 500 and a retry works", async () => {
    r = rig({ n8n: { url: "https://n8n.test/webhook/x", secret: "n8n-secret-0123456789" } });
    r.fetchReply.status = 502;
    const res = await r.post("/webhooks/retell", analyzed("call_Q"));
    expect(JSON.parse(res.body).status).toBe("summary_sent:team_email");
    expect(r.mail.sent[0]!.to).toBe("team@desk.test");

    r.mail.failNext = 1;
    const res2 = await r.post("/webhooks/retell", analyzed("call_Q2"));
    expect(res2.status).toBe(500);
    const res3 = await r.post("/webhooks/retell", analyzed("call_Q2"));
    expect(res3.status).toBe(200);
  });

  it("unsigned webhook is refused", async () => {
    r = rig();
    expect((await r.post("/webhooks/retell", analyzed("x"), { sign: false })).status).toBe(401);
  });
});

describe("inbound cap", () => {
  it("rejects calls after the daily cap", async () => {
    r = rig({ maxCallsPerDay: 2 });
    const call = (id: string) => r.post("/webhooks/retell-inbound", { event: "call_inbound", call_inbound: { call_id: id, from_number: "+12015551234", to_number: "+12015550000" } });
    expect(JSON.parse((await call("i1")).body)).toEqual({ call_inbound: { dynamic_variables: { business_name: "Brightside Family Dental" } } });
    await call("i2");
    expect(JSON.parse((await call("i3")).body)).toEqual({ call_inbound: { reject: true } });
  });
});

describe("data", () => {
  it("the generated dental business is valid", () => {
    expect(() => loadBusiness(DENTAL_DIR)).not.toThrow();
  });
});
