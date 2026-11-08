import { afterEach, describe, expect, it } from "vitest";
import { AirtableLog, KeyedQueue, MemoryBookingLog, type BookingRow } from "../src/airtable.ts";
import { buildPrompt } from "../src/agent-config.ts";
import { loadBusiness } from "../src/business.ts";
import { Db } from "../src/db.ts";
import { isOptedOut, keywordOf, MemorySms, sendSmsOnce, SmsError, twilioSignature, TwilioSms, UNSUBSCRIBED } from "../src/sms.ts";
import { DENTAL_DIR, checkoutCompleted, rig, type Rig } from "./helpers.ts";

const SID = `AC${"a".repeat(32)}`;
const TOKEN = "b".repeat(32);

let r: Rig;
afterEach(() => {
  r?.app.close();
  r?.db.close();
});

function smsRig(o: { sms?: boolean; log?: boolean } = {}) {
  const sms = new MemorySms();
  const log = new MemoryBookingLog();
  r = rig({ ...(o.sms !== false ? { sms: { sender: sms, authToken: TOKEN } } : {}), ...(o.log !== false ? { bookingLog: log } : {}) });
  return { sms, log };
}

const BOOK = { service: "cleaning", start: "2026-11-09T09:00", customer_name: "Ann Lee", phone: "+12015550123", email: "ann@example.com" };

async function inbound(body: Record<string, string>, sig?: string) {
  const raw = new URLSearchParams(body).toString();
  const signature = sig ?? twilioSignature(TOKEN, "https://desk.test/webhooks/twilio", body);
  return r.app.handle({ method: "POST", url: "/webhooks/twilio", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body: Buffer.from(raw) });
}

describe("SMS confirmations", () => {
  it("texts the code once when the caller opted in; a repeat request sends nothing new", async () => {
    const { sms } = smsRig();
    const out = await r.tool("book_appointment", { ...BOOK, sms_opt_in: true });
    await r.app.settle();
    expect(out["sms_queued"]).toBe(true);
    expect(String(out["message"])).toContain("texting the details");
    expect(sms.sent).toHaveLength(1);
    const code = (out["appointment"] as { code: string }).code;
    expect(sms.sent[0]!.to).toBe("+12015550123");
    expect(sms.sent[0]!.body).toContain(`Code ${code}`);
    expect(sms.sent[0]!.body).toContain("Reply STOP to opt out.");
    expect(sms.sent[0]!.body).toMatch(/^[\x20-\x7E\n]+$/);
    await r.tool("book_appointment", { ...BOOK, sms_opt_in: true });
    await r.app.settle();
    expect(sms.sent).toHaveLength(1);
    expect(r.db.toolLogFor("call_A").filter((e) => e.tool === "sms" && e.outcome === "ok")).toHaveLength(1);
  });

  it("no text without an explicit yes, and none when SMS is not configured", async () => {
    const { sms } = smsRig();
    const out = await r.tool("book_appointment", { ...BOOK, sms_opt_in: "maybe" });
    await r.app.settle();
    expect(out["sms_queued"]).toBe(false);
    expect(sms.sent).toHaveLength(0);
    r.app.close();
    r.db.close();
    smsRig({ sms: false });
    const off = await r.tool("book_appointment", { ...BOOK, sms_opt_in: true });
    expect(off["sms_queued"]).toBe(false);
    expect(String(off["message"])).not.toContain("texting");
  });

  it("a later 'yes' on the same booking sends the booked text", async () => {
    const { sms } = smsRig();
    await r.tool("book_appointment", BOOK);
    await r.app.settle();
    expect(sms.sent).toHaveLength(0);
    await r.tool("book_appointment", { ...BOOK, sms_opt_in: true });
    await r.app.settle();
    expect(sms.sent).toHaveLength(1);
  });

  it("texts the move and the cancel, each once", async () => {
    const { sms } = smsRig();
    const out = await r.tool("book_appointment", { ...BOOK, sms_opt_in: true });
    const code = (out["appointment"] as { code: string }).code;
    const moved = await r.tool("reschedule_appointment", { code, new_start: "2026-11-10T10:00" });
    expect(moved["ok"]).toBe(true);
    expect(String(moved["message"])).toContain("You will get a text too.");
    await r.tool("cancel_appointment", { code });
    await r.tool("cancel_appointment", { code });
    await r.app.settle();
    expect(sms.sent).toHaveLength(3);
    expect(sms.sent[0]!.body).toContain("you're booked. Cleaning and checkup, Monday, November 9th");
    expect(sms.sent[1]!.body).toContain("your appointment moved to Tuesday");
    expect(sms.sent[2]!.body).toContain(`is cancelled (code ${code})`);
  });

  it("a failed text never blocks the booking and shows up in the team summary", async () => {
    const { sms } = smsRig();
    sms.failNext = 1;
    const out = await r.tool("book_appointment", { ...BOOK, sms_opt_in: true });
    expect(out["ok"]).toBe(true);
    await r.app.settle();
    const failed = r.db.toolLogFor("call_A").find((e) => e.tool === "sms");
    expect(failed).toMatchObject({ ok: false, outcome: "sms_failed" });
    expect(failed!.note).toContain("FAILED");
    const res = await r.post("/webhooks/retell", { event: "call_analyzed", call: { call_id: "call_A" } });
    expect(res.status).toBe(200);
    const team = r.mail.sent.find((m) => m.to === "team@desk.test");
    expect(team?.text).toContain("booked text to the caller FAILED");
  });

  it("STOP from the provider (21610) or the inbound webhook stops texts; START allows them again", async () => {
    const { sms } = smsRig();
    sms.failNext = 1;
    sms.failCode = UNSUBSCRIBED;
    await r.tool("book_appointment", { ...BOOK, sms_opt_in: true });
    await r.app.settle();
    expect(isOptedOut(r.db, "+12015550123")).toBe(true);
    expect(r.db.toolLogFor("call_A").find((e) => e.tool === "sms")?.outcome).toBe("sms_opted_out");

    expect((await inbound({ From: "+12015550123", Body: " start " })).status).toBe(200);
    expect(isOptedOut(r.db, "+12015550123")).toBe(false);
    const res = await inbound({ From: "+12015550123", Body: "STOP" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(isOptedOut(r.db, "+12015550123")).toBe(true);
    const code = ((await r.tool("book_appointment", { ...BOOK, start: "2026-11-11T09:00", sms_opt_in: true }))["appointment"] as { code: string }).code;
    await r.app.settle();
    expect(code).toMatch(/^[A-Z0-9]{4}$/);
    expect(sms.sent).toHaveLength(0);
  });

  it("the inbound webhook rejects a bad signature, and is not there without Twilio", async () => {
    smsRig();
    expect((await inbound({ From: "+12015550123", Body: "STOP" }, "bad")).status).toBe(401);
    expect(isOptedOut(r.db, "+12015550123")).toBe(false);
    r.app.close();
    r.db.close();
    smsRig({ sms: false });
    expect((await inbound({ From: "+12015550123", Body: "STOP" })).status).toBe(404);
  });

  it("keywords", () => {
    expect(keywordOf("Stop.")).toBe("stop");
    expect(keywordOf("unsubscribe")).toBe("stop");
    expect(keywordOf("START")).toBe("start");
    expect(keywordOf("stop texting me about my teeth")).toBeNull();
  });

  it("two sends of the same key at once send one text", async () => {
    const db = new Db(":memory:");
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const sent: string[] = [];
    const slow = { kind: "memory" as const, async send(m: { body: string }) { await gate; sent.push(m.body); return { id: "SM1" }; } };
    const m = { to: "+12015550123", body: "hi", idempotencyKey: "k1" };
    const a = sendSmsOnce(db, slow, m, 1);
    const b = sendSmsOnce(db, slow, m, 1);
    release();
    expect(await Promise.all([a, b])).toEqual(["sent", "already_sent"]);
    expect(sent).toHaveLength(1);
    expect(await sendSmsOnce(db, slow, m, 2)).toBe("already_sent");
    db.close();
  });
});

describe("Twilio adapter", () => {
  it("posts the documented form with basic auth; an error keeps Twilio's code", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let reply: { status: number; body: unknown } = { status: 201, body: { sid: "SM123" } };
    const tw = new TwilioSms({ accountSid: SID, authToken: TOKEN, from: "+15005550006", fetch: async (url, init) => { calls.push({ url, ...(init ? { init } : {}) }); return new Response(JSON.stringify(reply.body), { status: reply.status }); } });
    expect(await tw.send({ to: "+12015550123", body: "Code K7QM", idempotencyKey: "x" })).toEqual({ id: "SM123" });
    expect(calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect((calls[0]!.init!.headers as Record<string, string>)["authorization"]).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(Object.fromEntries(form)).toEqual({ To: "+12015550123", Body: "Code K7QM", From: "+15005550006" });

    reply = { status: 400, body: { code: 21608, message: "The number is unverified. Trial accounts cannot send messages to unverified numbers" } };
    const err = await tw.send({ to: "+12015550999", body: "x", idempotencyKey: "y" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsError);
    expect((err as SmsError).code).toBe(21608);
    expect((err as Error).message).toContain("error 21608");
  });

  it("refuses keys that are not Twilio's shape", () => {
    expect(() => new TwilioSms({ accountSid: "nope", authToken: TOKEN, from: "+15005550006" })).toThrow(/ACCOUNT_SID/);
    expect(() => new TwilioSms({ accountSid: SID, authToken: TOKEN, from: "5550006" })).toThrow(/TWILIO_FROM/);
    expect(() => new TwilioSms({ accountSid: SID, authToken: TOKEN, from: `MG${"c".repeat(32)}` })).not.toThrow();
  });

  it("signature matches Twilio's documented example", () => {
    // From Twilio's "Webhooks security" docs.
    const sig = twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" });
    expect(sig).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });
});

describe("Airtable booking log", () => {
  it("one row per code that follows book, move, deposit and cancel; no personal details", async () => {
    const { log } = smsRig();
    const out = await r.tool("book_appointment", { service: "new_patient_visit", start: "2026-11-09T09:00", customer_name: "Ann Lee", phone: "+12015550123", email: "ann@example.com" });
    const a = out["appointment"] as { code: string; id?: string };
    const code = a.code;
    await r.app.settle();
    expect(log.rows.get(code)).toMatchObject({ Code: code, Service: "New patient exam and cleaning", Status: "Booked", Deposit: "$50 due", Source: "Voice" });
    expect(log.rows.get(code)!.Time).toBe("2026-11-09T09:00:00-05:00");
    const row = JSON.stringify(log.rows.get(code));
    for (const pii of ["Ann", "Lee", "2015550123", "ann@example.com"]) expect(row).not.toContain(pii);

    await r.tool("reschedule_appointment", { code, new_start: "2026-11-10T10:00" });
    await r.app.settle();
    expect(log.rows.get(code)).toMatchObject({ Status: "Rescheduled", Time: "2026-11-10T10:00:00-05:00" });

    const apt = r.db.byCode(code)!;
    expect((await r.stripeEvent(checkoutCompleted("evt_1", apt.id))).status).toBe(200);
    await r.app.settle();
    expect(log.rows.get(code)!.Deposit).toBe("$50 paid");

    await r.tool("cancel_appointment", { code });
    await r.app.settle();
    expect(log.rows.size).toBe(1);
    expect(log.rows.get(code)).toMatchObject({ Status: "Cancelled", Deposit: "$50 paid" });
  });

  it("chat bookings are marked Chat", async () => {
    const { log } = smsRig();
    const out = await r.tool("book_appointment", BOOK, { call_id: "chat_s1" });
    await r.app.settle();
    expect(log.rows.get((out["appointment"] as { code: string }).code)!.Source).toBe("Chat");
  });

  it("a failed write never blocks the booking and reaches the team summary", async () => {
    const { log } = smsRig();
    log.failNext = 1;
    const out = await r.tool("book_appointment", BOOK);
    expect(out["ok"]).toBe(true);
    await r.app.settle();
    expect(r.db.toolLogFor("call_A").find((e) => e.tool === "airtable")).toMatchObject({ ok: false, outcome: "log_failed" });
    await r.post("/webhooks/retell", { event: "call_analyzed", call: { call_id: "call_A" } });
    expect(r.mail.sent.find((m) => m.to === "team@desk.test")?.text).toContain("Booking log row");
  });

  it("writes for one booking land in order even when the first is slow", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slowLog = { kind: "memory" as const, async upsert(row: BookingRow) { if (order.length === 0 && row.Status === "Booked") await gate; order.push(row.Status); } };
    r = rig({ bookingLog: slowLog });
    const out = await r.tool("book_appointment", BOOK);
    await r.tool("cancel_appointment", { code: (out["appointment"] as { code: string }).code });
    release();
    await r.app.settle();
    // The first write reads the row when it runs; whatever it sent, the last write is the cancel.
    expect(order.at(-1)).toBe("Cancelled");
  });

  it("the queue runs jobs for a key one at a time", async () => {
    const q = new KeyedQueue();
    const seen: number[] = [];
    await Promise.all([
      q.run("a", async () => { await new Promise((res) => setTimeout(res, 15)); seen.push(1); }),
      q.run("a", async () => { seen.push(2); throw new Error("x"); }).catch(() => {}),
      q.run("a", async () => { seen.push(3); }),
    ]);
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("Airtable adapter", () => {
  const PAT = `pat${"A".repeat(14)}.${"f".repeat(64)}`;
  const BASE = "appABCDEFGHIJKLMN";
  const row: BookingRow = { Code: "K7QM", Service: "Cleaning", Time: "2026-11-09T09:00:00-05:00", Staff: "Dr. A", Status: "Booked", Deposit: "None", Source: "Voice", Updated: "2026-11-07T14:00:00.000Z" };

  it("upserts on Code with typecast, and retries a 429", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const replies = [429, 200];
    const at = new AirtableLog({ token: PAT, baseId: BASE, table: "Bookings", retryDelaysMs: [0, 0], fetch: async (url, init) => { calls.push({ url, ...(init ? { init } : {}) }); return new Response("{}", { status: replies.shift() ?? 200 }); } });
    await at.upsert(row);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`https://api.airtable.com/v0/${BASE}/Bookings`);
    expect(calls[0]!.init!.method).toBe("PATCH");
    expect((calls[0]!.init!.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${PAT}`);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ performUpsert: { fieldsToMergeOn: ["Code"] }, typecast: true, records: [{ fields: row }] });
  });

  it("a refusal throws with Airtable's reason; no retry on 4xx", async () => {
    let n = 0;
    const at = new AirtableLog({ token: PAT, baseId: BASE, table: "Bookings", retryDelaysMs: [0], fetch: async () => { n += 1; return new Response(JSON.stringify({ error: { type: "UNKNOWN_FIELD_NAME", message: 'Unknown field name: "Staff"' } }), { status: 422 }); } });
    await expect(at.upsert(row)).rejects.toThrow(/422 UNKNOWN_FIELD_NAME/);
    expect(n).toBe(1);
  });

  it("refuses ids that are not Airtable's shape", () => {
    expect(() => new AirtableLog({ token: "key123", baseId: BASE, table: "Bookings" })).toThrow(/AIRTABLE_TOKEN/);
    expect(() => new AirtableLog({ token: PAT, baseId: "base1", table: "Bookings" })).toThrow(/AIRTABLE_BASE_ID/);
  });
});

describe("prompt", () => {
  it("offers texts only when SMS is configured", () => {
    const b = loadBusiness(DENTAL_DIR);
    expect(buildPrompt(b)).not.toContain("sms_opt_in");
    expect(buildPrompt(b, undefined, { sms: true })).toContain("set sms_opt_in to true only if they say yes");
  });
});
