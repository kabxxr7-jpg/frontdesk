// The app API (/api/v1/): shapes, status codes, the code+email check, limits, idempotency, tenant prefix.
import { afterEach, describe, expect, it } from "vitest";
import { loadBusiness } from "../src/business.ts";
import { MemoryCalendar } from "../src/calendar.ts";
import { Db } from "../src/db.ts";
import { MemoryEmail } from "../src/email.ts";
import { createApp, createRouter, type Res, type Tenant } from "../src/server.ts";
import { DENTAL_DIR, LINK, rig, type Rig } from "./helpers.ts";

let r: Rig | undefined;
afterEach(() => {
  r?.app.close();
  r?.db.close();
  r = undefined;
});

const BOOK = { service: "new_patient_visit", start: "2026-11-10T09:00:00-05:00", staff: "lena-chen", customer_name: "Sam Patel", email: "Sam@Example.com", phone: "+12015550123", notes: "first visit" };

let ipSeq = 0;
function api(rr: Rig, ip = `203.0.113.${++ipSeq % 250}`) {
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> =>
    rr.app.handle({ method, url: `/api/v1${path}`, headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers }, body: Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)) });
  return {
    get: (path: string, headers?: Record<string, string>) => call("GET", path, undefined, headers),
    post: (path: string, body: unknown, headers?: Record<string, string>) => call("POST", path, body, headers),
  };
}
const j = (res: Res): Record<string, unknown> => JSON.parse(res.body) as Record<string, unknown>;

async function booked(rr: Rig, over: Record<string, unknown> = {}) {
  const res = await api(rr).post("/appointments", { ...BOOK, ...over });
  expect(res.status).toBe(201);
  return j(res)["appointment"] as Record<string, unknown>;
}

describe("GET /api/v1/business", () => {
  it("returns the public shape, rendered, with no phones, urgent rules or prompt text", async () => {
    r = rig();
    const res = await api(r).get("/business");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    const b = j(res);
    expect(b).toMatchObject({ slug: "brightside-family-dental", name: "Brightside Family Dental", fictional: true, timezone: "America/New_York", agent_name: "Ava", web_call_url: "https://desk.test/" });
    expect(Object.keys(b["hours"] as object).sort()).toEqual(["fri", "mon", "sat", "sun", "thu", "tue", "wed"]);
    expect((b["hours"] as Record<string, unknown>)["sun"]).toEqual([]);
    expect(b["closed_dates"]).toContainEqual({ date: "2026-11-26", reason: "Thanksgiving" });
    expect((b["services"] as Record<string, unknown>[]).find((s) => s["id"] === "new_patient_visit")).toMatchObject({ duration_minutes: 60, deposit_usd: 50 });
    expect((b["staff"] as Record<string, unknown>[])[0]).toEqual({ id: "lena-chen", name: "Dr. Lena Chen", title: expect.any(String), service_ids: expect.any(Array) });
    expect(b["policies"]).toEqual({ cancellation_notice_hours: r.b.policies.cancellationNoticeHours, late_cancel_fee_usd: r.b.policies.lateCancelFeeUsd });
    const text = res.body;
    expect(text).not.toContain("{{");
    expect(text).not.toContain("+12015550100");
    expect(text).not.toContain("+12015550142");
    expect(text).not.toMatch(/"phones"|"urgent"|"schedule"|"keywords"|emergencyMessage|"prompt"/);
    expect(text).not.toContain("knocked out");
  });
});

describe("GET /api/v1/availability", () => {
  it("returns every slot in the range, not the spoken spread", async () => {
    r = rig();
    const res = await api(r).get("/availability?service=cleaning&date_from=2026-11-10&date_to=2026-11-11");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const a = j(res);
    expect(a).toMatchObject({ today: "2026-11-07", service: { id: "cleaning", duration_minutes: 60, deposit_usd: 0 }, widened: false, closed: null, calendar_note: null });
    const slots = a["slots"] as Record<string, unknown>[];
    expect(slots.length).toBeGreaterThan(6);
    expect(slots[0]).toEqual({ start: "2026-11-10T08:00:00-05:00", staff_id: "jordan-patel", staff_name: expect.any(String) });
    expect(slots.length).toBeLessThanOrEqual(60);
  });
  it("caps at 60, and reports a closed day", async () => {
    r = rig();
    const wide = j(await api(r).get("/availability?service=new_patient_visit&date_from=2026-11-09&date_to=2026-11-20"));
    expect((wide["slots"] as unknown[]).length).toBe(60);
    const closed = j(await api(r).get("/availability?service=cleaning&date_from=2026-11-26&date_to=2026-11-26"));
    expect(closed["closed"]).toEqual({ date: "2026-11-26", reason: "Thanksgiving" });
  });
  it("400s on a missing service, an unknown service and a backwards range", async () => {
    r = rig();
    const c = api(r);
    expect(j(await c.get("/availability"))).toMatchObject({ error: "missing_fields", field: "service" });
    const unknown = await c.get("/availability?service=massage");
    expect(unknown.status).toBe(400);
    expect(j(unknown)).toMatchObject({ error: "unknown_service", field: "service" });
    expect(j(unknown)["hint"]).toBeUndefined();
    const bad = await c.get("/availability?service=cleaning&date_from=2026-11-12&date_to=2026-11-10");
    expect(bad.status).toBe(400);
    expect(j(bad)["error"]).toBe("bad_range");
  });
});

describe("POST /api/v1/appointments", () => {
  it("books (201), never echoes phone or email, and logs the tool row under an app_ call id", async () => {
    r = rig();
    const res = await api(r).post("/appointments", BOOK);
    expect(res.status).toBe(201);
    const out = j(res);
    expect(out).toMatchObject({ email_queued: true, calendar: "synced" });
    expect(String(out["pay_url"])).toMatch(/^https:\/\/desk\.test\/pay\//);
    expect(out["appointment"]).toEqual({
      code: expect.stringMatching(/^[A-Z0-9]{4}$/), start: "2026-11-10T09:00:00-05:00", end: "2026-11-10T10:00:00-05:00",
      service_id: "new_patient_visit", service: r.b.services.find((s) => s.id === "new_patient_visit")!.name, staff_id: "lena-chen", staff_name: "Dr. Lena Chen",
      customer_name: "Sam Patel", status: "booked", deposit_status: "due", deposit_usd: 50,
    });
    expect(res.body).not.toMatch(/example\.com|2015550123/i);
    const a = r.db.allAppointments()[0]!;
    expect(a.callId).toMatch(/^app_[0-9a-f]+$/);
    expect(r.db.toolLogFor(a.callId).map((x) => x.tool)).toContain("book_appointment");
    await r.app.settle();
    expect(r.mail.sent).toHaveLength(1);
  });
  it("replays the first result for the same Idempotency-Key instead of booking twice", async () => {
    r = rig();
    const c = api(r);
    const h = { "idempotency-key": "3f6c1a2e-1111-4a3b-9c2d-0123456789ab" };
    const first = await c.post("/appointments", BOOK, h);
    const again = await c.post("/appointments", BOOK, h);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toBe(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(r.db.allAppointments()).toHaveLength(1);
    // Same key, different booking: refused, not silently replayed.
    expect(j(await c.post("/appointments", { ...BOOK, start: "2026-11-10T10:00:00-05:00" }, h))["error"]).toBe("idempotency_key_reused");
    // After 24 hours the stored result is forgotten, but the call id comes from the key, so the tool still sees the
    // same booking (no second appointment, not a stored replay).
    r.now.ms += 25 * 3_600_000;
    const later = await c.post("/appointments", BOOK, h);
    expect(later.status).toBe(201);
    expect(later.headers["idempotent-replayed"]).toBeUndefined();
    expect((j(later)["appointment"] as Record<string, unknown>)["code"]).toBe((j(first)["appointment"] as Record<string, unknown>)["code"]);
    expect(r.db.allAppointments()).toHaveLength(1);
  });
  it("409 slot_taken with alternatives", async () => {
    r = rig();
    await booked(r);
    const res = await api(r).post("/appointments", { ...BOOK, customer_name: "Ann Lee", email: "ann@example.com" });
    expect(res.status).toBe(409);
    const e = j(res);
    expect(e).toMatchObject({ error: "slot_taken", field: "start", message: expect.stringContaining("already taken") });
    const alts = e["alternatives"] as Record<string, unknown>[];
    expect(alts.length).toBeGreaterThan(0);
    expect(Object.keys(alts[0]!).sort()).toEqual(["staff_id", "staff_name", "start"]);
  });
  it("400s: invalid JSON, missing email, missing phone, bad email; 422 for slot problems and emergencies", async () => {
    r = rig();
    const c = api(r);
    expect(j(await c.post("/appointments", "{not json"))).toMatchObject({ error: "invalid_json" });
    const noEmail = await c.post("/appointments", { ...BOOK, email: undefined });
    expect(noEmail.status).toBe(400);
    expect(j(noEmail)).toMatchObject({ error: "missing_fields", field: "email" });
    expect(j(await c.post("/appointments", { ...BOOK, phone: "" }))).toMatchObject({ error: "missing_fields", field: "phone" });
    const badEmail = await c.post("/appointments", { ...BOOK, email: "not an email" });
    expect(badEmail.status).toBe(400);
    expect(j(badEmail)).toMatchObject({ error: "invalid_email", field: "email" });
    const c2 = api(r);
    const sunday = await c2.post("/appointments", { ...BOOK, start: "2026-11-08T10:00:00-05:00" });
    expect(sunday.status).toBe(422);
    expect(j(sunday)["error"]).toBe("closed_day");
    const past = await c2.post("/appointments", { ...BOOK, start: "2026-11-01T10:00:00-05:00" });
    expect(j(past)).toMatchObject({ error: "in_the_past" });
    const offGrid = await c2.post("/appointments", { ...BOOK, start: "2026-11-10T09:10:00-05:00" });
    expect(j(offGrid)["error"]).toBe("off_grid");
    const c3 = api(r);
    const emergency = await c3.post("/appointments", { ...BOOK, notes: "my son's tooth got knocked out" });
    expect(emergency.status).toBe(422);
    expect(j(emergency)["error"]).toBe("emergency");
    expect(r.db.allAppointments()).toHaveLength(0);
  });
  it("10 writes per hour per IP, then 429 with Retry-After", async () => {
    r = rig();
    const c = api(r, "198.51.100.7");
    for (let i = 0; i < 10; i += 1) expect((await c.post("/appointments", { ...BOOK, phone: "" })).status).toBe(400);
    const res = await c.post("/appointments", BOOK);
    expect(res.status).toBe(429);
    expect(j(res)["error"]).toBe("rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    // Another IP is not affected; after the hour this one is let through again.
    expect((await api(r, "198.51.100.8").post("/appointments", BOOK)).status).toBe(201);
    r.now.ms += 3_600_001;
    expect((await c.post("/appointments", { ...BOOK, start: "2026-11-10T10:00:00-05:00" })).status).toBe(201);
  });
  it("stops at the daily cap on app bookings", async () => {
    r = rig({ api: { maxBookingsPerDay: 1 } });
    await booked(r);
    const res = await api(r).post("/appointments", { ...BOOK, start: "2026-11-10T10:00:00-05:00" });
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("code + email", () => {
  it("lookup works with the right pair (email case-insensitive); wrong email and wrong code give the same 404", async () => {
    r = rig();
    const apt = await booked(r);
    const c = api(r);
    const ok = await c.post("/appointments/lookup", { code: String(apt["code"]).toLowerCase(), email: " sam@EXAMPLE.com " });
    expect(ok.status).toBe(200);
    expect(j(ok)["appointment"]).toEqual(apt);
    const wrongEmail = await c.post("/appointments/lookup", { code: apt["code"], email: "eve@example.com" });
    const wrongCode = await c.post("/appointments/lookup", { code: apt["code"] === "AAAA" ? "CCCC" : "AAAA", email: "sam@example.com" });
    expect(wrongEmail.status).toBe(404);
    expect(wrongCode.status).toBe(404);
    expect(wrongEmail.body).toBe(wrongCode.body);
    expect(j(wrongEmail)["error"]).toBe("not_found");
    expect(j(await c.post("/appointments/lookup", { code: apt["code"] }))).toMatchObject({ error: "missing_fields", field: "email" });
  });
  it("5 failed lookups per 15 minutes, then 429 even for the right pair", async () => {
    r = rig();
    const apt = await booked(r);
    const c = api(r, "192.0.2.50");
    for (let i = 0; i < 5; i += 1) expect((await c.post("/appointments/lookup", { code: apt["code"], email: `x${i}@example.com` })).status).toBe(404);
    const locked = await c.post("/appointments/lookup", { code: apt["code"], email: "sam@example.com" });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(locked.headers["retry-after"])).toBeLessThanOrEqual(900);
    // The lock covers reschedule and cancel too.
    expect((await c.post("/appointments/cancel", { code: apt["code"], email: "sam@example.com" })).status).toBe(429);
    r.now.ms += 15 * 60_000 + 1;
    expect((await c.post("/appointments/lookup", { code: apt["code"], email: "sam@example.com" })).status).toBe(200);
  });
  it("reschedules after the check", async () => {
    r = rig();
    const apt = await booked(r);
    const c = api(r);
    expect((await c.post("/appointments/reschedule", { code: apt["code"], email: "eve@example.com", new_start: "2026-11-12T14:00" })).status).toBe(404);
    const res = await c.post("/appointments/reschedule", { code: apt["code"], email: "sam@example.com", new_start: "2026-11-12T14:00:00-05:00" });
    expect(res.status).toBe(200);
    expect(j(res)["appointment"]).toMatchObject({ code: apt["code"], start: "2026-11-12T14:00:00-05:00", end: "2026-11-12T15:00:00-05:00", status: "booked" });
    expect(res.body).not.toMatch(/example\.com|2015550123/i);
    const sunday = await c.post("/appointments/reschedule", { code: apt["code"], email: "sam@example.com", new_start: "2026-11-15T10:00" });
    expect(sunday.status).toBe(422);
    expect(j(sunday)["error"]).toBe("closed_day");
  });
  it("cancels, then says already_cancelled; a cancelled booking cannot be moved (409)", async () => {
    r = rig();
    const apt = await booked(r);
    const c = api(r);
    const res = await c.post("/appointments/cancel", { code: apt["code"], email: "sam@example.com" });
    expect(res.status).toBe(200);
    expect(j(res)).toEqual({ appointment: { ...apt, status: "cancelled" }, late_cancellation: false, already_cancelled: false });
    const again = await c.post("/appointments/cancel", { code: apt["code"], email: "sam@example.com" });
    expect(again.status).toBe(200);
    expect(j(again)).toMatchObject({ already_cancelled: true, appointment: { status: "cancelled" } });
    const move = await c.post("/appointments/reschedule", { code: apt["code"], email: "sam@example.com", new_start: "2026-11-12T14:00" });
    expect(move.status).toBe(409);
    expect(j(move)["error"]).toBe("already_cancelled");
  });
});

describe("routing", () => {
  it("healthz, 404 for unknown endpoints, 405 for the wrong method, CORS only for our origins", async () => {
    r = rig({ api: { allowedOrigins: ["https://site.test"] } });
    const c = api(r);
    expect(j(await c.get("/healthz"))).toMatchObject({ ok: true, business: "brightside-family-dental" });
    expect((await c.get("/nope")).status).toBe(404);
    expect((await c.get("/appointments")).status).toBe(405);
    expect((await c.post("/business", {})).status).toBe(405);
    expect((await c.get("/business", { origin: "https://site.test" })).headers["access-control-allow-origin"]).toBe("https://site.test");
    expect((await c.get("/business", { origin: "https://desk.test" })).headers["access-control-allow-origin"]).toBe("https://desk.test");
    expect((await c.get("/business", { origin: "https://evil.test" })).headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("60 reads per minute per IP", async () => {
    r = rig();
    const c = api(r, "192.0.2.99");
    for (let i = 0; i < 60; i += 1) expect((await c.get("/business")).status).toBe(200);
    const res = await c.get("/business");
    expect(res.status).toBe(429);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
  it("works under a tenant prefix through createRouter, against that tenant's own bookings", async () => {
    const b = loadBusiness(DENTAL_DIR);
    const mk = (base: string, db: Db) => createApp({ b, db, calendar: new MemoryCalendar(), email: new MemoryEmail(), vapiSecret: "v".repeat(32), publicBaseUrl: base, linkSecret: LINK, clock: () => Date.UTC(2026, 10, 7, 14, 0) });
    const mainDb = new Db(":memory:");
    const tenantDb = new Db(":memory:");
    const tenants = new Map<string, Tenant>([["sample-x1", { app: mk("https://desk.test/t/sample-x1", tenantDb), expiresAt: "2099-01-01" }]]);
    const router = createRouter(mk("https://desk.test", mainDb), tenants);
    const req = (method: string, url: string, body?: unknown) => router.handle({ method, url, headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.200" }, body: Buffer.from(body ? JSON.stringify(body) : "") });
    const biz = await req("GET", "/t/sample-x1/api/v1/business");
    expect(biz.status).toBe(200);
    expect(j(biz)["web_call_url"]).toBe("https://desk.test/t/sample-x1/");
    const res = await req("POST", "/t/sample-x1/api/v1/appointments", BOOK);
    expect(res.status).toBe(201);
    expect(j(res)["pay_url"]).toBeNull(); // no Stripe on this app: no deposit
    expect(tenantDb.allAppointments()).toHaveLength(1);
    expect(mainDb.allAppointments()).toHaveLength(0);
    const code = (j(res)["appointment"] as Record<string, unknown>)["code"];
    expect((await req("POST", "/api/v1/appointments/lookup", { code, email: "sam@example.com" })).status).toBe(404);
    expect((await req("POST", "/t/sample-x1/api/v1/appointments/lookup", { code, email: "sam@example.com" })).status).toBe(200);
    router.close();
    mainDb.close();
    tenantDb.close();
  });
});
