// Public JSON API for the patient app, under /api/v1/ (also under /t/<slug>/api/v1/ for a sample, since the router
// strips the prefix). A thin layer over runTool and the business data: no booking logic of its own. No auth (a public
// demo, like the voice line), so per-IP limits do the work, and every code-based action needs the code AND the email
// it was booked with. Phone numbers and emails are never echoed back.
//   GET  /api/v1/healthz                    liveness
//   GET  /api/v1/business                   public business data (rendered FAQ, hours, services, staff)
//   GET  /api/v1/availability?service=...   free slots (every slot in the range, up to 60)
//   POST /api/v1/appointments               book (Idempotency-Key honoured for 24 h)
//   POST /api/v1/appointments/lookup        { code, email }
//   POST /api/v1/appointments/reschedule    { code, email, new_start }
//   POST /api/v1/appointments/cancel        { code, email }
import { createHash, randomBytes } from "node:crypto";
import { displayName, type Business } from "./business.ts";
import type { Appointment } from "./db.ts";
import type { Req, Res } from "./server.ts";
import { renderTokens } from "./text.ts";
import { localYmd, toIsoWithOffset, zonedToUtc } from "./time.ts";
import { payUrl, runTool, type Deps, type ToolName, type ToolOutput } from "./tools.ts";
import { isRecord } from "./validate.ts";

export interface ApiConfig {
  /** The page with the "Talk to <agent>" browser call. Defaults to PUBLIC_BASE_URL + "/". */
  webCallUrl?: string | undefined;
  /** Origins allowed by CORS (PUBLIC_BASE_URL and SITE_URL). Others get no CORS headers. */
  allowedOrigins?: string[] | undefined;
  /** Bookings the app may make per local day (default 40). */
  maxBookingsPerDay?: number | undefined;
}

export const API_PREFIX = "/api/v1/";
const DAY_MS = 86_400_000;
const READS_PER_MIN = 60;
const WRITES_PER_HOUR = 10;
const FAILED_LOOKUPS = 5;
const FAILED_WINDOW_MS = 15 * 60_000;

const NO_STORE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** Sliding-window counter per key (in memory: a restart forgives everyone, which is fine for a demo). */
class Window {
  private hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }
  /** Seconds until the key may act again, or 0 when it is under the limit now. */
  blockedFor(key: string, now: number): number {
    const list = this.recent(key, now);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil(((list[list.length - this.limit] as number) + this.windowMs - now) / 1000));
  }
  add(key: string, now: number): void {
    this.hits.set(key, [...this.recent(key, now), now]);
    if (this.hits.size > 10_000) for (const k of [...this.hits.keys()].slice(0, 5_000)) this.hits.delete(k);
  }
}

export function clientIp(headers: Req["headers"]): string {
  const one = (k: string): string | undefined => (typeof headers[k] === "string" ? (headers[k] as string) : undefined);
  return (one("cf-connecting-ip") ?? one("x-forwarded-for")?.split(",")[0] ?? "local").trim().slice(0, 64) || "local";
}

const HTTP_FOR: Record<string, number> = {
  not_found: 404,
  slot_taken: 409,
  already_cancelled: 409,
  in_the_past: 422, too_soon: 422, too_far: 422, closed_date: 422, closed_day: 422, outside_hours: 422,
  staff_not_working: 422, nobody_for_time: 422, off_grid: 422, emergency: 422,
  calendar_unavailable: 503,
};
/** The tools' own codes where the API names them differently (the scheduler's names). */
const RENAME: Record<string, string> = { start_in_past: "in_the_past", too_far_ahead: "too_far", not_on_slot_boundary: "off_grid", emergency_detected: "emergency" };

interface ApiError { error: string; message: string; field?: string; alternatives?: unknown[] }

export interface Api {
  handle(req: Req, path: string): Promise<Res>;
}

export function createApi(d: Deps, clock: () => number, cfg: ApiConfig = {}): Api {
  const b: Business = d.b;
  const reads = new Window(READS_PER_MIN, 60_000);
  const writes = new Window(WRITES_PER_HOUR, 3_600_000);
  const failures = new Window(FAILED_LOOKUPS, FAILED_WINDOW_MS);
  const origins = new Set([d.publicBaseUrl, ...(cfg.allowedOrigins ?? [])].map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean).map(originOf).filter((o): o is string => Boolean(o)));
  const cap = cfg.maxBookingsPerDay ?? 40;
  const deposit = (usd: number | undefined): number => (d.depositsEnabled && usd && usd > 0 ? usd : 0);

  const send = (status: number, body: unknown, extra: Record<string, string> = {}): Res => ({ status, headers: { ...NO_STORE, ...extra }, body: JSON.stringify(body) });
  const err = (status: number, e: ApiError, extra: Record<string, string> = {}): Res => send(status, e, extra);
  const limited = (seconds: number, message: string): Res => err(429, { error: "rate_limited", message }, { "retry-after": String(seconds) });

  function slotOut(s: unknown) {
    const r = isRecord(s) ? s : {};
    return { start: r["start"], staff_id: r["staff_id"], staff_name: r["staff_name"] };
  }

  /** A tool's ok:false result as an API error. */
  function toolError(out: ToolOutput): Res {
    const raw = String(out["error"] ?? "error");
    const code = RENAME[raw] ?? raw;
    const e: ApiError = { error: code, message: out.message };
    if (typeof out["field"] === "string") e.field = out["field"];
    if (Array.isArray(out["alternatives"])) e.alternatives = out["alternatives"].map(slotOut);
    return err(HTTP_FOR[code] ?? 400, e);
  }

  function appointmentOut(a: Appointment) {
    const st = b.staff.find((s) => s.id === a.staffId);
    const sv = b.services.find((s) => s.id === a.serviceId);
    return {
      code: a.code,
      start: toIsoWithOffset(a.startUtc, b.timezone),
      end: toIsoWithOffset(a.endUtc, b.timezone),
      service_id: a.serviceId,
      service: sv?.name ?? a.serviceId,
      staff_id: a.staffId,
      staff_name: st?.name ?? a.staffId,
      customer_name: a.customerName,
      status: a.status,
      deposit_status: a.depositStatus,
      deposit_usd: a.depositUsd,
    };
  }

  const callIdFor = (idemKey?: string): string =>
    `app_${idemKey ? createHash("sha256").update(`${b.slug}:${idemKey}`).digest("hex").slice(0, 20) : randomBytes(10).toString("hex")}`;

  const tool = (name: ToolName, args: Record<string, unknown>, callId: string, extra: { allSlots?: boolean } = {}) =>
    runTool(d, name, args, { nowMs: clock(), callId, ...extra });

  function parseBody(req: Req): { ok: true; body: Record<string, unknown> } | { ok: false; res: Res } {
    try {
      const v: unknown = JSON.parse(req.body.toString("utf8"));
      if (isRecord(v)) return { ok: true, body: v };
    } catch {
      // fall through
    }
    return { ok: false, res: err(400, { error: "invalid_json", message: "The request body must be a JSON object." }) };
  }

  /** Copies the string fields a tool understands; anything else in the body is ignored. */
  function pick(body: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (body[k] !== undefined && body[k] !== null) out[k] = body[k];
    return out;
  }

  const startOfToday = (): number => {
    const now = clock();
    const m = zonedToUtc(localYmd(now, b.timezone), 0, b.timezone);
    return m.kind === "gap" ? now - DAY_MS : m.utcMs;
  };

  // ---------------------------------------------------------------- routes

  function business(): Res {
    const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
    const hours = Object.fromEntries(days.map((k) => [k, (b.hours[k] ?? []).map((w) => [w[0], w[1]])]));
    const body = {
      slug: b.slug,
      name: displayName(b),
      fictional: b.fictional,
      fiction_note: b.fictionNote,
      timezone: b.timezone,
      address: b.address,
      tagline: b.brand.tagline,
      brand_color: /^#[0-9a-fA-F]{6}$/.test(b.brand.color) ? b.brand.color : "#0f766e",
      agent_name: b.agent.name,
      web_call_url: cfg.webCallUrl ?? `${d.publicBaseUrl}/`,
      hours,
      closed_dates: b.closedDates.map((c) => ({ date: c.date, reason: c.reason })),
      services: b.services.map((s) => ({
        id: s.id, name: s.name, description: s.description, duration_minutes: s.durationMinutes, price_usd: s.priceUsd,
        price_note: s.priceNote ?? null, deposit_usd: deposit(s.depositUsd),
      })),
      staff: b.staff.map((s) => ({ id: s.id, name: s.name, title: s.title, service_ids: [...s.serviceIds] })),
      faq: b.faq.map((f) => ({ id: f.id, topic: f.topic, answer: renderTokens(f.answer, b) })),
      policies: { cancellation_notice_hours: b.policies.cancellationNoticeHours, late_cancel_fee_usd: b.policies.lateCancelFeeUsd },
    };
    return send(200, body, { "cache-control": "public, max-age=60" });
  }

  async function availability(req: Req): Promise<Res> {
    const q = new URLSearchParams(req.url.split("?")[1] ?? "");
    const service = q.get("service");
    if (!service) return err(400, { error: "missing_fields", message: "Which service is this for?", field: "service" });
    const pod = q.get("part_of_day");
    if (pod !== null && pod !== "morning" && pod !== "afternoon" && pod !== "any") {
      return err(400, { error: "invalid_part_of_day", message: "part_of_day must be morning, afternoon or any.", field: "part_of_day" });
    }
    const args: Record<string, unknown> = { service };
    for (const k of ["date_from", "date_to", "staff"]) {
      const v = q.get(k);
      if (v !== null && v !== "") args[k] = v;
    }
    if (pod) args["part_of_day"] = pod;
    const out = await tool("get_availability", args, callIdFor(), { allSlots: true });
    if (!out.ok) return toolError(out);
    const sv = isRecord(out["service"]) ? out["service"] : {};
    const svc = b.services.find((s) => s.id === sv["id"]);
    return send(200, {
      today: out["today"],
      service: { id: sv["id"], name: sv["name"], duration_minutes: sv["duration_minutes"], price_usd: sv["price_usd"], deposit_usd: deposit(svc?.depositUsd) },
      slots: Array.isArray(out["slots"]) ? out["slots"].map(slotOut) : [],
      widened: out["widened"] === true,
      closed: isRecord(out["closed"]) ? { date: out["closed"]["date"], reason: out["closed"]["reason"] } : null,
      calendar_note: typeof out["calendar_note"] === "string" ? out["calendar_note"] : null,
    });
  }

  async function book(req: Req, ip: string): Promise<Res> {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.res;
    const fields = parsed.body;
    const keyRaw = req.headers["idempotency-key"];
    const key = typeof keyRaw === "string" ? keyRaw.trim() : undefined;
    if (key !== undefined && !/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) {
      return err(400, { error: "invalid_idempotency_key", message: "Idempotency-Key must be 8 to 200 letters, digits, dashes, dots or underscores." });
    }
    const args = pick(fields, ["service", "start", "staff", "customer_name", "email", "phone", "notes", "address"]);
    const hash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    if (key) {
      const prior = d.db.getIdempotent(`${b.slug}:${key}`, clock() - DAY_MS);
      if (prior) {
        if (prior.requestHash !== hash) return err(409, { error: "idempotency_key_reused", message: "This Idempotency-Key was already used for a different booking." });
        return { status: prior.status, headers: { ...NO_STORE, "idempotent-replayed": "true" }, body: prior.body };
      }
    }
    const wait = writes.blockedFor(ip, clock());
    if (wait > 0) return limited(wait, "Too many changes from this device. Please try again later.");
    writes.add(ip, clock());
    if (d.db.countEventsSince("appbook:", startOfToday()) >= cap) {
      const m = zonedToUtc(localYmd(clock() + DAY_MS, b.timezone), 0, b.timezone);
      const secs = m.kind === "gap" ? 3600 : Math.max(60, Math.ceil((m.utcMs - clock()) / 1000));
      return limited(secs, "The app has taken as many bookings as it can for today. Please try again tomorrow.");
    }
    if (typeof args["email"] !== "string" || args["email"].trim() === "") {
      return err(400, { error: "missing_fields", message: "Please add your email address: your confirmation code is sent there.", field: "email" });
    }
    if (typeof args["phone"] !== "string" || args["phone"].trim() === "") {
      return err(400, { error: "missing_fields", message: "Please add a phone number.", field: "phone" });
    }
    const callId = callIdFor(key);
    const out = await tool("book_appointment", args, callId);
    if (!out.ok) return toolError(out);
    const code = isRecord(out["appointment"]) ? String(out["appointment"]["code"]) : "";
    const a = d.db.byCode(code);
    if (!a) throw new Error("booked appointment not found");
    if (!out["already_booked"]) d.db.recordEvent(`appbook:${a.id}`, clock());
    const res = send(201, {
      appointment: appointmentOut(a),
      email_queued: out["already_booked"] ? Boolean(a.email) : out["email_queued"] === true,
      calendar: out["calendar"] === "synced" || out["calendar"] === "pending" || out["calendar"] === "failed" ? out["calendar"] : a.calendarStatus === "synced" ? "synced" : a.calendarStatus === "failed" ? "failed" : "pending",
      pay_url: a.depositStatus === "due" && d.depositsEnabled ? payUrl(d, a) : null,
    });
    if (key) d.db.saveIdempotent(`${b.slug}:${key}`, clock(), hash, res.status, res.body);
    return res;
  }

  /** The code+email check shared by lookup, reschedule and cancel. Either part wrong gives the same 404. */
  function verify(body: Record<string, unknown>, ip: string): { ok: true; a: Appointment } | { ok: false; res: Res } {
    const wait = failures.blockedFor(ip, clock());
    if (wait > 0) return { ok: false, res: limited(wait, "Too many tries with a code that did not match. Please wait and try again.") };
    const code = typeof body["code"] === "string" ? body["code"].toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const email = typeof body["email"] === "string" ? body["email"].trim().toLowerCase() : "";
    if (!code || !email) return { ok: false, res: err(400, { error: "missing_fields", message: "Please enter your confirmation code and the email you booked with.", field: !code ? "code" : "email" }) };
    const a = code.length <= 12 ? d.db.byCode(code) : undefined;
    if (!a || !a.email || a.email.trim().toLowerCase() !== email) {
      failures.add(ip, clock());
      return { ok: false, res: err(404, { error: "not_found", message: "We could not find a booking with that code and email. Please check both and try again." }) };
    }
    return { ok: true, a };
  }

  async function lookup(req: Req, ip: string): Promise<Res> {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.body;
    const v = verify(body, ip);
    if (!v.ok) return v.res;
    return send(200, { appointment: appointmentOut(v.a) });
  }

  async function change(req: Req, ip: string, kind: "reschedule" | "cancel"): Promise<Res> {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.body;
    const wait = writes.blockedFor(ip, clock());
    if (wait > 0) return limited(wait, "Too many changes from this device. Please try again later.");
    writes.add(ip, clock());
    const v = verify(body, ip);
    if (!v.ok) return v.res;
    const a = v.a;
    const callId = callIdFor();
    if (kind === "reschedule") {
      if (body["new_start"] === undefined || body["new_start"] === null || body["new_start"] === "") {
        return err(400, { error: "missing_fields", message: "What day and time would you like instead?", field: "new_start" });
      }
      const out = await tool("reschedule_appointment", { code: a.code, new_start: body["new_start"] }, callId);
      if (!out.ok) return toolError(out);
      const fresh = d.db.getAppointment(a.id) ?? a;
      return send(200, { appointment: appointmentOut(fresh) });
    }
    const out = await tool("cancel_appointment", { code: a.code }, callId);
    if (!out.ok) return toolError(out);
    const fresh = d.db.getAppointment(a.id) ?? a;
    return send(200, { appointment: appointmentOut(fresh), late_cancellation: out["already_cancelled"] === true ? fresh.lateCancellation === true : out["late_cancellation"] === true, already_cancelled: out["already_cancelled"] === true });
  }

  function cors(req: Req): Record<string, string> {
    const o = req.headers["origin"];
    if (typeof o !== "string" || !origins.has(o.replace(/\/+$/, ""))) return {};
    return { "access-control-allow-origin": o, vary: "Origin" };
  }

  async function route(req: Req, path: string): Promise<Res> {
    const ip = clientIp(req.headers);
    const now = clock();
    const sub = path.slice(API_PREFIX.length).replace(/\/+$/, "");
    const isGet = req.method === "GET" || req.method === "HEAD";
    const GETS = ["healthz", "business", "availability"];
    const POSTS = ["appointments", "appointments/lookup", "appointments/reschedule", "appointments/cancel"];
    if (!GETS.includes(sub) && !POSTS.includes(sub)) return err(404, { error: "not_found", message: "There is no such API endpoint." });
    if (req.method === "OPTIONS") {
      const c = cors(req);
      if (!c["access-control-allow-origin"]) return { status: 204, headers: { "cache-control": "no-store" }, body: "" };
      return { status: 204, headers: { ...c, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, idempotency-key", "access-control-max-age": "600", "cache-control": "no-store" }, body: "" };
    }
    if (GETS.includes(sub) ? !isGet : req.method !== "POST") {
      return err(405, { error: "method_not_allowed", message: `Use ${GETS.includes(sub) ? "GET" : "POST"} for this endpoint.` }, { allow: GETS.includes(sub) ? "GET" : "POST" });
    }
    if (sub === "healthz") return send(200, { ok: true, business: b.slug, calendar: d.calendar.kind, email: d.email.kind });
    if (sub === "business" || sub === "availability" || sub === "appointments/lookup") {
      const wait = reads.blockedFor(ip, now);
      if (wait > 0) return limited(wait, "Too many requests. Please wait a moment.");
      reads.add(ip, now);
    }
    if (sub === "business") return business();
    if (sub === "availability") return availability(req);
    if (sub === "appointments") return book(req, ip);
    if (sub === "appointments/lookup") return lookup(req, ip);
    if (sub === "appointments/reschedule") return change(req, ip, "reschedule");
    return change(req, ip, "cancel");
  }

  return {
    async handle(req, path) {
      const res = await route(req, path);
      return { ...res, headers: { ...res.headers, ...cors(req) } };
    },
  };
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
