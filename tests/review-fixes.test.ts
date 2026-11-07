// One test per finding of the independent review (7 Nov 2026). Each reproduces the failing scenario the review
// described, with a calendar that answers late so requests really overlap.
import { afterEach, describe, expect, it } from "vitest";
import { loadBusiness } from "../src/business.ts";
import { signBody } from "../src/signature.ts";
import { payToken } from "../src/stripe.ts";
import { classifyUrgent } from "../src/urgent.ts";
import { checkoutCompleted, KEY, LINK, rig, type Rig } from "./helpers.ts";

let r: Rig | undefined;
afterEach(() => {
  r?.app.close();
  r?.db.close();
  r = undefined;
});

const BOOK = { service: "new_patient_visit", start: "2026-11-10T09:00", customer_name: "Ann Lee", email: "ann@example.com" };

describe("finding 1: one caller cannot get two appointments", () => {
  it("two identical requests at once make one appointment", async () => {
    r = rig();
    r.cal.delayMs = 50;
    const [a, b] = await Promise.all([r.tool("book_appointment", BOOK), r.tool("book_appointment", BOOK)]);
    expect(r.db.allAppointments().filter((x) => x.status === "booked")).toHaveLength(1);
    expect([a["already_booked"], b["already_booked"]].filter(Boolean)).toHaveLength(1);
    await r.app.settle();
    expect(r.mail.sent).toHaveLength(1);
  });
  it("a re-spelled name in the same call is the same booking, and the name is corrected", async () => {
    r = rig();
    await r.tool("book_appointment", BOOK);
    const again = await r.tool("book_appointment", { ...BOOK, customer_name: "Anne Lee" });
    expect(again["already_booked"]).toBe(true);
    const all = r.db.allAppointments();
    expect(all).toHaveLength(1);
    expect(all[0]!.customerName).toBe("Anne Lee");
  });
  it("a different person in the same call at the same time is a second booking", async () => {
    r = rig();
    await r.tool("book_appointment", BOOK);
    const other = await r.tool("book_appointment", { ...BOOK, customer_name: "Marcus Brown" });
    expect(other["ok"]).toBe(true);
    expect(other["already_booked"]).toBeUndefined();
  });
});

describe("finding 2: a reschedule does not overwrite what happened while it waited", () => {
  it("a cancel during the reschedule wins", async () => {
    r = rig();
    const b = await r.tool("book_appointment", BOOK);
    const code = (b["appointment"] as { code: string }).code;
    r.cal.delayMs = 60;
    const move = r.tool("reschedule_appointment", { code, new_start: "2026-11-11T14:00" }, { call_id: "call_M" });
    await new Promise((res) => setTimeout(res, 10));
    r.cal.delayMs = 0;
    const cancel = await r.tool("cancel_appointment", { code }, { call_id: "call_C" });
    expect(cancel["ok"]).toBe(true);
    const moved = await move;
    expect(moved).toMatchObject({ ok: false, error: "already_cancelled" });
    expect(r.db.byCode(code)!.status).toBe("cancelled");
  });
  it("a deposit paid during the reschedule stays paid", async () => {
    r = rig();
    const b = await r.tool("book_appointment", BOOK);
    const a = r.db.byCode((b["appointment"] as { code: string }).code)!;
    r.cal.delayMs = 60;
    const move = r.tool("reschedule_appointment", { code: a.code, new_start: "2026-11-11T14:00" }, { call_id: "call_M" });
    await new Promise((res) => setTimeout(res, 10));
    await r.stripeEvent(checkoutCompleted("evt_mid", a.id));
    expect((await move)["ok"]).toBe(true);
    const after = r.db.getAppointment(a.id)!;
    expect(after.depositStatus).toBe("paid");
    expect(after.startUtc).toBe(Date.UTC(2026, 10, 11, 19, 0));
  });
});

describe("finding 3: a deposit after a cancel is not 'your time is held'", () => {
  it("cancel expires the open checkout; a late payment is flagged for refund and the caller told so", async () => {
    r = rig();
    const b = await r.tool("book_appointment", BOOK);
    const a = r.db.byCode((b["appointment"] as { code: string }).code)!;
    await r.get(`/pay/${payToken(a.id, LINK)}`);
    await r.tool("cancel_appointment", { code: a.code }, { call_id: "call_C" });
    await r.app.settle();
    expect(r.fetchCalls.some((c) => /checkout\/sessions\/cs_test_\w+\/expire$/.test(c.url))).toBe(true);
    const res = JSON.parse((await r.stripeEvent(checkoutCompleted("evt_late", a.id))).body);
    expect(res.status).toBe("paid_after_cancel_refund_needed");
    await r.app.settle();
    const subjects = r.mail.sent.map((m) => m.subject);
    expect(subjects.some((s) => s.includes("deposit received for a cancelled"))).toBe(true);
    expect(subjects.some((s) => s.startsWith("REFUND NEEDED"))).toBe(true);
    expect(subjects.some((s) => s.endsWith("deposit received"))).toBe(false);
  });
});

describe("finding 4: a slow calendar cannot push a booking past the platform's timeout", () => {
  it("answers within the budgets and finishes the calendar write in the background", async () => {
    r = rig();
    r.app.deps.calendarBudgetMs = { busy: 100, write: 100 };
    r.cal.delayMs = 400;
    const t0 = Date.now();
    const out = await r.tool("book_appointment", BOOK);
    const took = Date.now() - t0;
    expect(out["ok"]).toBe(true);
    expect(out["calendar"]).toBe("pending");
    expect(took).toBeLessThan(380);
    await r.app.settle();
    expect(r.cal.events.size).toBe(1);
    expect(r.db.allAppointments()[0]!.calendarStatus).toBe("synced");
  });
});

describe("finding 5: nobody can look up someone else's booking by saying their number", () => {
  it("a spoken number that is not the caller's needs the code", async () => {
    r = rig();
    await r.tool("book_appointment", BOOK, { call_id: "call_owner", from_number: "+12015550001" });
    const snoop = await r.tool("cancel_appointment", { phone: "201-555-0001" }, { call_id: "call_x", from_number: "+12015559999" });
    expect(snoop).toMatchObject({ ok: false, error: "code_required" });
    expect(JSON.stringify(snoop)).not.toContain("Ann");
    expect(r.db.allAppointments()[0]!.status).toBe("booked");
  });
  it("a web call (no caller id) needs the code", async () => {
    r = rig();
    await r.tool("book_appointment", BOOK, { call_id: "call_owner", from_number: "+12015550001" });
    expect(await r.tool("cancel_appointment", {}, { call_id: "web_1" })).toMatchObject({ ok: false, error: "missing_fields" });
  });
});

describe("finding 6: alternatives respect calendar blocks beyond the first day", () => {
  it("a closed Sunday suggests nothing inside a Monday that is blocked all day", async () => {
    r = rig();
    r.now.ms = Date.UTC(2026, 10, 7, 19, 0); // Saturday 2 PM New York: closed for the rest of the day
    // Monday 9 Nov, local midnight to midnight in New York
    // two blocks, as a person would type them: morning, and 11 AM to the end of the day (the second starts more than
    // 24 hours after the Sunday time asked for)
    r.cal.blocks.push([Date.UTC(2026, 10, 9, 5, 0), Date.UTC(2026, 10, 9, 16, 0)]);
    r.cal.blocks.push([Date.UTC(2026, 10, 9, 16, 0), Date.UTC(2026, 10, 10, 5, 0)]);
    const out = await r.tool("book_appointment", { ...BOOK, start: "2026-11-08T10:00" });
    expect(out["error"]).toBe("closed_day");
    const alts = out["alternatives"] as { start: string }[];
    expect(alts.length).toBeGreaterThan(0);
    expect(alts.every((s) => !s.start.startsWith("2026-11-09"))).toBe(true);
  });
  it("availability for a Los Angeles business sees late-afternoon blocks on the last day", async () => {
    const base = loadBusiness("businesses/brightside-family-dental");
    r = rig({}, { ...base, timezone: "America/Los_Angeles" });
    // Tue 10 Nov 13:00-16:00 Los Angeles (21:00-24:00 UTC) and 16:00-18:00 (00:00-02:00 UTC on the 11th): the whole afternoon
    r.cal.blocks.push([Date.UTC(2026, 10, 10, 21, 0), Date.UTC(2026, 10, 11, 0, 0)]);
    r.cal.blocks.push([Date.UTC(2026, 10, 11, 0, 0), Date.UTC(2026, 10, 11, 2, 0)]);
    const out = await r.tool("get_availability", { service: "aligner_consult", date_from: "2026-11-10", date_to: "2026-11-10", part_of_day: "afternoon", staff: "Chen" });
    const starts = (out["slots"] as { start: string }[]).map((s) => s.start);
    expect(starts).toEqual([]);
  });
});

describe("finding 8: a crashed tool call can be retried", () => {
  it("the same signed request after a 500 runs again instead of 409", async () => {
    r = rig();
    const original = r.db.appointmentsForCall.bind(r.db);
    r.db.appointmentsForCall = () => {
      throw new Error("boom");
    };
    const raw = JSON.stringify({ name: "book_appointment", args: BOOK, call: { call_id: "call_crash", from_number: "+12015551234" } });
    const h = { "x-retell-signature": signBody(raw, KEY, r.now.ms) };
    const first = await r.app.handle({ method: "POST", url: "/tools/book_appointment", headers: h, body: Buffer.from(raw) });
    expect(first.status).toBe(500);
    r.db.appointmentsForCall = original;
    const second = await r.app.handle({ method: "POST", url: "/tools/book_appointment", headers: h, body: Buffer.from(raw) });
    expect(second.status).toBe(200);
  });
});

describe("finding 9: no pay token in logs, no provider error text to the platform", () => {
  it("logs show /pay/<token>", async () => {
    const lines: string[] = [];
    r = rig({ log: (l) => lines.push(l) });
    const b = await r.tool("book_appointment", BOOK);
    const a = r.db.byCode((b["appointment"] as { code: string }).code)!;
    const token = payToken(a.id, LINK);
    await r.get(`/pay/${token}`);
    expect(lines.join("\n")).not.toContain(token);
    expect(lines.some((l) => l.includes("/pay/<token>"))).toBe(true);
  });
  it("a failed summary delivery answers a generic message", async () => {
    r = rig({ n8n: { url: "https://n8n.test/x", secret: "n8n-secret-0123456789" } });
    r.fetchReply.status = 502;
    r.mail.failNext = 1;
    const res = await r.post("/webhooks/retell", { event: "call_analyzed", call: { call_id: "c_fail" } });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain("502");
    expect(res.body).not.toContain("simulated");
  });
});

describe("finding 10: a corrected email address gets the confirmation", () => {
  it("re-sending with a new address emails the new address", async () => {
    r = rig();
    await r.tool("book_appointment", { ...BOOK, email: "ann@exmaple.com" });
    const again = await r.tool("book_appointment", { ...BOOK, email: "ann@example.com" });
    expect(again["already_booked"]).toBe(true);
    await r.app.settle();
    expect(r.mail.sent.map((m) => m.to)).toEqual(["ann@exmaple.com", "ann@example.com"]);
    expect(r.db.allAppointments()[0]!.email).toBe("ann@example.com");
  });
});

describe("finding 11: a repeated urgent phrase is checked every time", () => {
  it("a negated first mention does not hide a later one", () => {
    const b = loadBusiness("businesses/brightside-family-dental");
    expect(classifyUrgent(b, "no swollen jaw yesterday | today swollen jaw").label).toBe("emergency");
    expect(classifyUrgent(b, "there was no heavy bleeding yesterday, but now heavy bleeding").label).toBe("emergency");
  });
});
