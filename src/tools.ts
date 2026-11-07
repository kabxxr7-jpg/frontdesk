// The six tools the voice agent calls. Each takes the model's arguments (untrusted) and returns { ok, message, ... }:
// `message` is a sentence the agent can read to the caller. Business problems (slot taken, bad date) are ok:false
// results, never thrown errors. Anything that changes state needs the platform's call id.
import { findService, findStaff, staffFor, type Business, type Service, type StaffMember } from "./business.ts";
import type { Calendar, CalendarEventInput } from "./calendar.ts";
import type { Appointment, Db } from "./db.ts";
import { escapeHtml, normalizeSpokenEmail, sendOnce, type EmailSender } from "./email.ts";
import { payToken } from "./stripe.ts";
import { formatPhone, joinList, looksLikeAdvice, matchFaq, renderHours, renderTokens, usd } from "./text.ts";
import { addDays, compareYmd, daysBetween, localYmd, spokenDate, spokenDateTime, toIsoWithOffset, weekdayName, type Ymd } from "./time.ts";
import { checkSlot, closedDateInfo, findSlots, isOpenAt, nearestSlots, type Busy, type Slot, type SlotCheck } from "./scheduler.ts";
import { classifyUrgent } from "./urgent.ts";
import { NAME_PATTERN, fail, isRecord, missingFields, readDate, readPhone, readStart, readText, type SpokenError } from "./validate.ts";

export const TOOL_NAMES = ["lookup_faq", "get_availability", "book_appointment", "reschedule_appointment", "cancel_appointment", "request_transfer"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const isToolName = (n: string): n is ToolName => (TOOL_NAMES as readonly string[]).includes(n);

export interface Deps {
  b: Business;
  db: Db;
  calendar: Calendar;
  email: EmailSender;
  /** https://desk.example.com, used in pay links. */
  publicBaseUrl: string;
  linkSecret: string;
  /** Deposits switch on only when Stripe is configured. */
  depositsEnabled: boolean;
  /** Real transfers only when the business's numbers can be dialled (not fictional 555 numbers). */
  transfersLive: boolean;
  replyTo?: string | undefined;
  log?: (line: string) => void;
  /** Background work (emails, calendar retries). Tests await it; the server lets it run. */
  background?: (p: Promise<unknown>) => void;
}

export interface ToolCall {
  nowMs: number;
  callId?: string | undefined;
  fromNumber?: string | undefined;
}

export type ToolOutput = { ok: boolean; message: string; [key: string]: unknown };

const MS_HOUR = 3_600_000;

const isFailure = (v: unknown): v is SpokenError => isRecord(v) && v["ok"] === false;

function bg(d: Deps, p: Promise<unknown>): void {
  const guarded = p.catch((err: unknown) => d.log?.(`background task failed: ${err instanceof Error ? err.message : String(err)}`));
  if (d.background) d.background(guarded);
}

function staffOf(d: Deps, id: string): StaffMember {
  return d.b.staff.find((s) => s.id === id) as StaffMember;
}
function serviceOf(d: Deps, id: string): Service {
  return d.b.services.find((s) => s.id === id) as Service;
}

function slotView(d: Deps, slot: Slot) {
  const st = staffOf(d, slot.staffId);
  return { start: toIsoWithOffset(slot.startUtc, d.b.timezone), spoken: spokenDateTime(slot.startUtc, d.b.timezone), staff_id: st.id, staff_name: st.name };
}
const spokenSlot = (d: Deps, slot: Slot): string => `${spokenDateTime(slot.startUtc, d.b.timezone)} with ${staffOf(d, slot.staffId).short}`;
const spellCode = (code: string): string => code.split("").join("-");

function appointmentView(d: Deps, a: Appointment) {
  const st = staffOf(d, a.staffId);
  const sv = serviceOf(d, a.serviceId);
  return {
    code: a.code,
    start: toIsoWithOffset(a.startUtc, d.b.timezone),
    spoken: spokenDateTime(a.startUtc, d.b.timezone),
    staff_name: st.name,
    service: sv.name,
    customer_name: a.customerName,
    status: a.status,
    deposit_status: a.depositStatus,
  };
}

function log(d: Deps, call: ToolCall, tool: string, out: ToolOutput, note: string, extra: { appointmentId?: string; urgentLabel?: "emergency" | "ambiguous"; transfer?: { destination: string; urgency: string } } = {}): void {
  if (!call.callId) return;
  d.db.logTool({ callId: call.callId, atMs: call.nowMs, tool, ok: out.ok, outcome: out.ok ? "ok" : String(out["error"] ?? "error"), note, ...extra });
}

// ---------------------------------------------------------------- transfer decision

export type Destination = "front_desk" | "emergency_line" | "none";

export interface TransferDecision {
  transfer: boolean;
  urgency: "emergency" | "review" | "standard" | "none";
  destination: Destination;
  tool_to_call: string | null;
  number: string | null;
  open_now: boolean;
  message: string;
  instruction: string;
}

export const TRANSFER_TOOL: Record<Exclude<Destination, "none">, string> = { front_desk: "transfer_to_front_desk", emergency_line: "transfer_to_emergency_line" };

export function decideTransfer(d: Deps, text: string, nowMs: number): TransferDecision {
  const b = d.b;
  const label = classifyUrgent(b, text).label;
  const open = isOpenAt(b, nowMs);
  const emergencyLine = b.phones.emergency;
  let destination: Destination;
  let urgency: TransferDecision["urgency"];
  if (label === "emergency") {
    urgency = "emergency";
    destination = open ? (b.urgent.routeWhenOpen === "emergency_line" && emergencyLine ? "emergency_line" : "front_desk") : emergencyLine ? "emergency_line" : "front_desk";
  } else if (open) {
    urgency = label === "ambiguous" ? "review" : "standard";
    destination = "front_desk";
  } else {
    urgency = label === "ambiguous" ? "review" : "none";
    destination = "none";
  }
  const number = destination === "front_desk" ? b.phones.frontDesk : destination === "emergency_line" ? (emergencyLine?.phone ?? null) : null;
  const who = destination === "emergency_line" ? (emergencyLine?.name ?? "our emergency line") : "a member of our team";

  if (destination === "none") {
    return {
      transfer: false, urgency, destination, tool_to_call: null, number: null, open_now: open,
      message: `Our team is not in right now. ${renderHours(b)} I can take a message and someone will call you back when we open. What should I tell them?`,
      instruction: "Do not transfer. Take a short message (name, number, what it is about); it goes to the team in the call summary.",
    };
  }
  const lead = urgency === "emergency" ? `${renderTokens(b.urgent.emergencyMessage, b)} ` : "";
  if (!d.transfersLive) {
    // Demo: the business's numbers are fictional and cannot be dialled. Say so plainly instead of pretending.
    return {
      transfer: false, urgency, destination, tool_to_call: null, number, open_now: open,
      message: `${lead}In a real setup I would now connect you to ${who} at ${formatPhone(number as string)}. This is a demonstration line, so I have flagged the call ${urgency === "emergency" ? "as urgent" : "for a callback"} for the team instead.`,
      instruction: "Read the message. Do not call a transfer tool (demo line). Then ask if there is anything else.",
    };
  }
  return {
    transfer: true, urgency, destination, tool_to_call: TRANSFER_TOOL[destination], number, open_now: open,
    message: `${lead}I am connecting you to ${who} now.`,
    instruction: `Say the message, then call ${TRANSFER_TOOL[destination]} immediately.`,
  };
}

/** Free text in any tool runs through the backstop first: an emergency overrules whatever was asked. */
function emergencyGuard(d: Deps, call: ToolCall, tool: string, texts: (string | undefined)[]): ToolOutput | null {
  const text = texts.filter((t): t is string => typeof t === "string" && t.length > 0).join(". ");
  if (text === "" || classifyUrgent(d.b, text).label !== "emergency") return null;
  const t = decideTransfer(d, text, call.nowMs);
  const out: ToolOutput = { ok: false, error: "emergency_detected", transfer_required: t.transfer, ...t };
  log(d, call, tool, out, `Emergency wording during ${tool}; ${t.transfer ? `transfer to ${t.destination}` : "flagged urgent (demo line)"}.`, {
    urgentLabel: "emergency",
    transfer: { destination: t.destination, urgency: t.urgency },
  });
  return out;
}

// ---------------------------------------------------------------- shared lookups

function resolveService(d: Deps, given: string): Service | SpokenError {
  return (
    findService(d.b, given) ??
    fail("unknown_service", `I am not sure which service that is. We offer ${joinList(d.b.services.map((s) => s.name.toLowerCase()))}. Which would you like?`, {
      field: "service",
      hint: `service "${given}" matches none of: ${d.b.services.map((s) => s.id).join(", ")}`,
    })
  );
}

function resolveStaff(d: Deps, given: string | undefined, service: Service): StaffMember | undefined | SpokenError {
  if (given === undefined) return undefined;
  const st = findStaff(d.b, given);
  if (!st) return fail("unknown_staff", `I do not know anyone here by that name. Our team is ${joinList(d.b.staff.map((s) => s.name))}.`, { field: "staff" });
  if (!st.serviceIds.includes(service.id)) {
    const who = staffFor(d.b, service).map((s) => s.name);
    return fail("staff_service_mismatch", `${st.name} does not do ${service.name.toLowerCase()}. ${joinList(who)} ${who.length === 1 ? "does" : "do"}.`, { field: "staff" });
  }
  return st;
}

/** Calendar blocks typed in by a person. If Google is unreachable, the booking still works from the database. */
async function busyAround(d: Deps, fromUtc: number, toUtc: number): Promise<{ busy: Busy; calendarOk: boolean }> {
  try {
    return { busy: await d.calendar.externalBusy(fromUtc, toUtc), calendarOk: true };
  } catch (err) {
    d.log?.(`calendar busy check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { busy: [], calendarOk: false };
  }
}

function slotProblem(d: Deps, check: Extract<SlotCheck, { ok: false }>, service: Service, startUtc: number, staff: StaffMember | undefined, nowMs: number, busy: Busy, ignoreId?: string): SpokenError {
  const b = d.b;
  const when = spokenDateTime(startUtc, b.timezone);
  const ymd = localYmd(startUtc, b.timezone);
  const alts = nearestSlots(b, d.db, { service, staffId: staff?.id, aroundUtc: startUtc, nowMs, count: 3, busy, ignoreAppointmentId: ignoreId });
  const altText = alts.length > 0 ? ` The closest openings I have are ${joinList(alts.map((a) => spokenSlot(d, a)))}. Would one of those work?` : " I do not see anything close to that. Would you like me to look at another day?";
  const withAlts = (msg: string, error: string): SpokenError => fail(error, msg + altText, { field: "start", alternatives: alts.map((a) => slotView(d, a)) });
  const lead = b.scheduling.minLeadMinutes;
  switch (check.code) {
    case "in_the_past":
      return fail("start_in_past", "That time has already passed. Which day and time would you like instead?", { field: "start" });
    case "too_soon":
      return withAlts(`We need at least ${lead >= 60 ? `${lead / 60} hour${lead === 60 ? "" : "s"}` : `${lead} minutes`} of notice, so I cannot book ${when}.`, "too_soon");
    case "too_far":
      return fail("too_far_ahead", `I can only book up to ${b.scheduling.maxBookAheadDays} days ahead. Could we pick an earlier date?`, { field: "start" });
    case "closed_date":
      return withAlts(`We are closed on ${spokenDate(ymd)} for ${check.closedReason ?? "a holiday"}.`, "closed_date");
    case "closed_day":
      return withAlts(`We are closed on ${weekdayName(ymd)}s.`, "closed_day");
    case "off_grid":
      return withAlts(`Our ${d.b.agent.visitWord}s start every ${b.scheduling.slotMinutes} minutes, so ${when} does not work.`, "not_on_slot_boundary");
    case "outside_hours":
      return withAlts(`${when} is outside our hours. ${renderHours(b)}`, "outside_hours");
    case "staff_not_working":
      return withAlts(`${staff?.name ?? "That person"} is not working at ${when}.`, "staff_not_working");
    case "nobody_for_time":
      return withAlts(`Nobody who does ${service.name.toLowerCase()} is in at ${when}.`, "nobody_for_time");
    case "slot_taken":
      return withAlts(`${when} is already taken.`, "slot_taken");
  }
}

export function eventForAppointment(d: Deps, a: Appointment): CalendarEventInput {
  const sv = serviceOf(d, a.serviceId);
  const st = staffOf(d, a.staffId);
  const deposit = a.depositStatus === "paid" ? " [deposit paid]" : a.depositStatus === "due" ? " [deposit due]" : "";
  return {
    appointmentId: a.id,
    summary: `${sv.name}: ${a.customerName} (${st.short})${deposit}`,
    description: [
      `Booked by the AI front desk${d.b.fictional ? " (demo, fictional business)" : ""}.`,
      `Code: ${a.code}`,
      `${capital(d.b.agent.customerWord)}: ${a.customerName}`,
      `Phone: ${a.phone}`,
      a.email ? `Email: ${a.email}` : "",
      a.address ? `Address: ${a.address}` : "",
      a.notes ? `Notes: ${a.notes}` : "",
      `With: ${st.name}`,
      a.depositUsd > 0 ? `Deposit: ${usd(a.depositUsd)} (${a.depositStatus}, Stripe test mode)` : "",
      `Call: ${a.callId}`,
    ].filter(Boolean).join("\n"),
    startUtc: a.startUtc,
    endUtc: a.endUtc,
    timeZone: d.b.timezone,
  };
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Creates or updates the calendar event; records the outcome on the appointment. Never throws. */
async function syncCalendar(d: Deps, a: Appointment): Promise<boolean> {
  try {
    if (a.status === "cancelled") {
      if (a.calendarEventId) await d.calendar.deleteEvent(a.calendarEventId);
    } else if (a.calendarEventId) {
      await d.calendar.updateEvent(a.calendarEventId, eventForAppointment(d, a));
    } else {
      a.calendarEventId = await d.calendar.createEvent(eventForAppointment(d, a));
    }
    a.calendarStatus = "synced";
    const latest = d.db.getAppointment(a.id);
    if (latest) d.db.saveAppointment({ ...latest, calendarEventId: a.calendarEventId, calendarStatus: "synced" });
    return true;
  } catch (err) {
    d.log?.(`calendar sync failed for ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    a.calendarStatus = "failed";
    const latest = d.db.getAppointment(a.id);
    if (latest) d.db.saveAppointment({ ...latest, calendarStatus: "failed" });
    return false;
  }
}

export function payUrl(d: Deps, a: Appointment): string {
  return `${d.publicBaseUrl}/pay/${payToken(a.id, d.linkSecret)}`;
}

// ---------------------------------------------------------------- emails to the caller

export function appointmentEmail(d: Deps, a: Appointment, kind: "booked" | "rescheduled" | "cancelled" | "deposit_paid"): { subject: string; text: string; html: string } {
  const b = d.b;
  const sv = serviceOf(d, a.serviceId);
  const st = staffOf(d, a.staffId);
  const when = spokenDateTime(a.startUtc, b.timezone);
  const demo = b.fictional ? `${b.name} is a fictional business used to demonstrate an AI front desk. No real ${b.agent.visitWord} exists, and the deposit link uses Stripe test mode (no real money; test card 4242 4242 4242 4242).` : "";
  const subject = {
    booked: `${b.name}: your ${b.agent.visitWord} on ${when}`,
    rescheduled: `${b.name}: your ${b.agent.visitWord} moved to ${when}`,
    cancelled: `${b.name}: your ${b.agent.visitWord} is cancelled`,
    deposit_paid: `${b.name}: deposit received`,
  }[kind];
  const head = {
    booked: `Hi ${a.customerName}, you are booked.`,
    rescheduled: `Hi ${a.customerName}, your ${b.agent.visitWord} has been moved.`,
    cancelled: `Hi ${a.customerName}, your ${b.agent.visitWord} has been cancelled.${a.lateCancellation ? ` It was inside the ${b.policies.cancellationNoticeHours}-hour notice window, so a late fee of ${usd(b.policies.lateCancelFeeUsd)} may apply.` : ""}`,
    deposit_paid: `Hi ${a.customerName}, we received your ${usd(a.depositUsd)} deposit. Your time is held.`,
  }[kind];
  const lines: [string, string][] = [
    ["What", sv.name],
    ["When", `${when} (${b.timezone.replace("_", " ")} time)`],
    ["With", st.name],
    ["Where", a.address ?? b.address],
    ["Code", a.code],
  ];
  const depositDue = kind !== "cancelled" && a.depositStatus === "due" && d.depositsEnabled;
  const link = depositDue ? payUrl(d, a) : null;
  const depositText = link ? `To hold this time, please pay the ${usd(a.depositUsd)} deposit: ${link}` : "";
  const change = kind === "cancelled" ? "" : `To change or cancel, call us and give your code ${a.code}.`;
  const text = [head, "", ...lines.map(([k, v]) => `${k}: ${v}`), "", depositText, change, "", demo].filter((l, i, arr) => l !== "" || arr[i - 1] !== "").join("\n").trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(b.brand.color) ? b.brand.color : "#0f766e";
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
<div style="max-width:520px;margin:24px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
<div style="background:${color};color:#fff;padding:18px 22px;font-size:18px;font-weight:600">${escapeHtml(b.name)}</div>
<div style="padding:22px">
<p style="margin:0 0 16px;font-size:16px">${escapeHtml(head)}</p>
<table style="border-collapse:collapse;font-size:15px">${lines.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#6b7280">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`).join("")}</table>
${link ? `<p style="margin:22px 0"><a href="${escapeHtml(link)}" style="background:${color};color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;display:inline-block">Pay ${escapeHtml(usd(a.depositUsd))} deposit</a></p>` : ""}
${change ? `<p style="font-size:14px;color:#374151">${escapeHtml(change)}</p>` : ""}
${demo ? `<p style="font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:20px">${escapeHtml(demo)}</p>` : ""}
</div></div></body></html>`;
  return { subject, text, html };
}

function emailCaller(d: Deps, a: Appointment, kind: "booked" | "rescheduled" | "cancelled" | "deposit_paid", call: ToolCall): void {
  if (!a.email) return;
  const m = appointmentEmail(d, a, kind);
  const key = `${a.id}:${kind}:${kind === "rescheduled" ? a.startUtc : ""}`;
  bg(
    d,
    sendOnce(d.db, d.email, { to: a.email, subject: m.subject, text: m.text, html: m.html, idempotencyKey: key, ...(d.replyTo ? { replyTo: d.replyTo } : {}) }, call.nowMs).then(
      () => {
        if (call.callId) d.db.logTool({ callId: call.callId, atMs: Date.now(), tool: "email", ok: true, outcome: "ok", note: `${kind} email sent to the caller.`, appointmentId: a.id });
      },
      (err: unknown) => {
        if (call.callId) d.db.logTool({ callId: call.callId, atMs: Date.now(), tool: "email", ok: false, outcome: "email_failed", note: `${kind} email to the caller FAILED: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}. Follow up by phone.`, appointmentId: a.id });
        throw err;
      },
    ),
  );
}

export { emailCaller as sendAppointmentEmail };

// ---------------------------------------------------------------- tools

async function lookupFaq(d: Deps, args: Record<string, unknown>, call: ToolCall): Promise<ToolOutput> {
  const q = readText(args, "question", { label: "the question", max: 500 });
  if (isFailure(q)) return q;
  if (q.value === undefined) return fail("missing_fields", "What would you like to know?", { hint: "question is required" });
  const guard = emergencyGuard(d, call, "lookup_faq", [q.value]);
  if (guard) return guard;
  if (looksLikeAdvice(d.b, q.value)) {
    const out: ToolOutput = { ok: true, matched: "advice_declined", message: `I am not able to give that kind of advice over the phone, but I can book you in or connect you with ${d.b.agent.customerWord === "patient" ? "our clinical team" : "our team"}. Which would you prefer?` };
    log(d, call, "lookup_faq", out, "Advice question declined.");
    return out;
  }
  const hit = matchFaq(d.b, q.value);
  const urgentLabel = classifyUrgent(d.b, q.value).label;
  if (!hit) {
    const out: ToolOutput = { ok: true, matched: null, message: "I do not have that information. I can take a message for the team, or connect you with someone. Would you like that?" };
    log(d, call, "lookup_faq", out, "FAQ: no match.");
    return out;
  }
  const out: ToolOutput = {
    ok: true, matched: hit.id, topic: hit.topic, message: hit.answer,
    ...(urgentLabel === "ambiguous" ? { urgent_check: { label: "ambiguous", instruction: "The caller mentioned something that may be urgent. Offer to connect them to a person (request_transfer)." } } : {}),
  };
  log(d, call, "lookup_faq", out, `FAQ: ${hit.topic}.`, urgentLabel === "ambiguous" ? { urgentLabel: "ambiguous" } : {});
  return out;
}

async function getAvailability(d: Deps, args: Record<string, unknown>, call: ToolCall): Promise<ToolOutput> {
  const b = d.b;
  const sIn = readText(args, "service", { label: "the service", max: 80 });
  if (isFailure(sIn)) return sIn;
  if (sIn.value === undefined) return fail("missing_fields", `Which service is this for? We offer ${joinList(b.services.map((s) => s.name.toLowerCase()))}.`, { hint: "service is required" });
  const service = resolveService(d, sIn.value);
  if (isFailure(service)) return service;
  const stIn = readText(args, "staff", { label: "the name", max: 60 });
  if (isFailure(stIn)) return stIn;
  const staff = resolveStaff(d, stIn.value, service);
  if (isFailure(staff)) return staff;
  const fromIn = readDate(args, "date_from", "the first day");
  if (isFailure(fromIn)) return fromIn;
  const toIn = readDate(args, "date_to", "the last day");
  if (isFailure(toIn)) return toIn;
  const pod = args["part_of_day"];
  const partOfDay = pod === "morning" || pod === "afternoon" ? pod : "any";

  const today = localYmd(call.nowMs, b.timezone);
  let from: Ymd = fromIn.value ?? today;
  if (compareYmd(from, today) < 0) from = today;
  let to: Ymd = toIn.value ?? addDays(from, fromIn.value ? 0 : 6);
  if (compareYmd(to, from) < 0) return fail("bad_range", "The end of that range is before the start. Which days should I look at?", { field: "date_to" });
  if (daysBetween(from, to) + 1 > b.scheduling.maxRangeDays) to = addDays(from, b.scheduling.maxRangeDays - 1);

  const { busy, calendarOk } = await busyAround(d, Date.UTC(from.y, from.m - 1, from.d) - 86_400_000, Date.UTC(to.y, to.m - 1, to.d) + 2 * 86_400_000);
  let slots = findSlots(b, d.db, { from, to, service, staffId: staff?.id, partOfDay, nowMs: call.nowMs, busy });
  let widened = false;
  if (slots.length === 0 && !toIn.value) {
    // Nothing in the window asked for: look two more weeks before saying no.
    const to2 = addDays(to, 14);
    const extra = await busyAround(d, Date.UTC(to.y, to.m - 1, to.d), Date.UTC(to2.y, to2.m - 1, to2.d) + 86_400_000);
    slots = findSlots(b, d.db, { from: addDays(to, 1), to: to2, service, staffId: staff?.id, partOfDay, nowMs: call.nowMs, busy: [...busy, ...extra.busy] });
    widened = true;
  }
  // Spread the offer: at most 2 per day, 6 in all, so the caller hears a choice of days.
  const perDay = new Map<string, number>();
  const offer: Slot[] = [];
  for (const s of slots) {
    const k = JSON.stringify(localYmd(s.startUtc, b.timezone));
    if ((perDay.get(k) ?? 0) >= 2) continue;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
    offer.push(s);
    if (offer.length >= 6) break;
  }
  const closed = fromIn.value && compareYmd(from, to) === 0 ? closedDateInfo(b, from) : undefined;
  let message: string;
  if (offer.length === 0) {
    message = closed ? `We are closed on ${spokenDate(from)} for ${closed.reason}, and I do not see openings soon after. Would you like me to take a message?` : `I do not see any openings for ${service.name.toLowerCase()} in that time. Would you like me to look further out?`;
  } else {
    message = `${closed ? `We are closed on ${spokenDate(from)} for ${closed.reason}. ` : ""}${widened ? "Nothing was open in those days, but further out " : ""}I have ${joinList(offer.slice(0, 3).map((s) => spokenSlot(d, s)), "or")}${offer.length > 3 ? ", and a few more" : ""}. Which works best?`;
  }
  const out: ToolOutput = {
    ok: true, service: { id: service.id, name: service.name, duration_minutes: service.durationMinutes, price_usd: service.priceUsd, deposit_usd: service.depositUsd ?? 0 },
    today: toIsoWithOffset(call.nowMs, b.timezone).slice(0, 10), slots: offer.map((s) => slotView(d, s)), message,
    ...(calendarOk ? {} : { calendar_note: "calendar unreachable; offered times come from bookings made by phone only" }),
  };
  log(d, call, "get_availability", out, `Availability for ${service.name}: ${offer.length} offered.`);
  return out;
}

async function bookAppointment(d: Deps, args: Record<string, unknown>, call: ToolCall): Promise<ToolOutput> {
  const b = d.b;
  if (!call.callId) return fail("missing_call", "I am sorry, I cannot book right now. Let me connect you with the team.", { hint: "call.call_id is required to book" });
  const sIn = readText(args, "service", { label: "the service", max: 80 });
  if (isFailure(sIn)) return sIn;
  const startIn = readStart(args, "start", b.timezone, "the appointment");
  if (isFailure(startIn)) return startIn;
  const nameIn = readText(args, "customer_name", { label: "your name", max: 80, pattern: NAME_PATTERN });
  if (isFailure(nameIn)) return nameIn;
  const phoneIn = readPhone(args, "phone");
  if (isFailure(phoneIn)) return phoneIn;
  const notesIn = readText(args, "notes", { label: "the note", max: 400 });
  if (isFailure(notesIn)) return notesIn;
  const addrIn = readText(args, "address", { label: "the address", max: 200 });
  if (isFailure(addrIn)) return addrIn;
  const stIn = readText(args, "staff", { label: "the name", max: 60 });
  if (isFailure(stIn)) return stIn;
  const emailRaw = readText(args, "email", { label: "the email address", max: 120 });
  if (isFailure(emailRaw)) return emailRaw;

  const guard = emergencyGuard(d, call, "book_appointment", [notesIn.value, sIn.value]);
  if (guard) return guard;

  const fromCaller = call.fromNumber ? readPhone({ p: call.fromNumber }, "p") : undefined;
  const phone = phoneIn.value ?? (fromCaller && !isFailure(fromCaller) ? fromCaller.value : undefined);
  const missing = missingFields([
    ["which service", sIn.value],
    ["the day and time", startIn.value],
    ["your name", nameIn.value],
    ["a phone number", phone],
    ...(b.agent.collectAddress ? ([["the address for the visit", addrIn.value]] as [string, unknown][]) : []),
  ]);
  if (missing) return missing;
  let email: string | undefined;
  if (emailRaw.value !== undefined) {
    const e = normalizeSpokenEmail(emailRaw.value);
    if (!e) return fail("invalid_email", "I did not catch a valid email address. Could you spell it for me, letter by letter?", { field: "email" });
    email = e;
  }
  const service = resolveService(d, sIn.value as string);
  if (isFailure(service)) return service;
  const staff = resolveStaff(d, stIn.value, service);
  if (isFailure(staff)) return staff;
  const startUtc = startIn.value as number;
  const name = nameIn.value as string;

  // Idempotent: the same call asking again for the same booking gets the same appointment.
  const again = d.db.appointmentsForCall(call.callId).find((a) => a.status === "booked" && a.startUtc === startUtc && a.serviceId === service.id && a.customerName.toLowerCase() === name.toLowerCase());
  if (again) {
    if (email && !again.email) {
      again.email = email;
      d.db.saveAppointment(again);
      emailCaller(d, again, "booked", call);
    }
    const out: ToolOutput = { ok: true, already_booked: true, appointment: appointmentView(d, again), message: `You are already booked for ${spokenDateTime(again.startUtc, b.timezone)}. Your code is ${spellCode(again.code)}.` };
    log(d, call, "book_appointment", out, `Repeat request; same appointment ${again.code}.`, { appointmentId: again.id });
    return out;
  }

  const { busy } = await busyAround(d, startUtc - 86_400_000, startUtc + 86_400_000);
  // From here to saveAppointment everything is synchronous: no other request can interleave.
  const check = checkSlot(b, d.db, { startUtc, service, staffId: staff?.id, nowMs: call.nowMs, busy });
  if (!check.ok) {
    const out = slotProblem(d, check, service, startUtc, staff, call.nowMs, busy);
    log(d, call, "book_appointment", out as ToolOutput, `Booking refused: ${out.error}.`);
    return out as ToolOutput;
  }
  const deposit = d.depositsEnabled && service.depositUsd && service.depositUsd > 0 ? service.depositUsd : 0;
  const a: Appointment = {
    id: d.db.newAppointmentId(), code: d.db.newCode(), callId: call.callId, staffId: check.staff.id, serviceId: service.id,
    startUtc, endUtc: check.endUtc, customerName: name, phone: phone as string, email, address: addrIn.value, notes: notesIn.value,
    status: "booked", createdAtMs: call.nowMs, updatedAtMs: call.nowMs, calendarStatus: "none",
    depositUsd: deposit, depositStatus: deposit > 0 ? "due" : "none", history: [{ atMs: call.nowMs, callId: call.callId, action: "booked" }],
  };
  try {
    d.db.saveAppointment(a);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      const out = slotProblem(d, { ok: false, code: "slot_taken" }, service, startUtc, staff, call.nowMs, busy);
      log(d, call, "book_appointment", out as ToolOutput, "Booking refused: taken a moment ago by another call.");
      return out as ToolOutput;
    }
    throw err;
  }
  const calendarOk = await syncCalendar(d, a);
  emailCaller(d, a, "booked", call);
  const when = spokenDateTime(startUtc, b.timezone);
  const parts = [`You are booked for ${service.name.toLowerCase()} on ${when} with ${check.staff.short}.`, `Your confirmation code is ${spellCode(a.code)}.`];
  if (email) parts.push(`I am sending the details to ${email}${deposit > 0 ? `, with a link to pay the ${usd(deposit)} deposit that holds your time` : ""}.`);
  else if (deposit > 0) parts.push(`There is a ${usd(deposit)} deposit to hold the time; with an email address I can send you the payment link.`);
  const out: ToolOutput = { ok: true, appointment: appointmentView(d, a), calendar: calendarOk ? "synced" : "failed", email_queued: Boolean(email), message: parts.join(" ") };
  log(d, call, "book_appointment", out, `Booked ${service.name} ${when} with ${check.staff.short} for ${name}, code ${a.code}${calendarOk ? "" : " (CALENDAR SYNC FAILED: add it by hand)"}.`, { appointmentId: a.id });
  return out;
}

/** Finds the appointment a caller means: by code, else by phone (and the current time when there are several). */
function findTarget(d: Deps, args: Record<string, unknown>, call: ToolCall, verb: string): Appointment | SpokenError {
  const b = d.b;
  const codeRaw = typeof args["code"] === "string" ? args["code"].toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  if (codeRaw) {
    const a = d.db.byCode(codeRaw);
    if (!a) return fail("not_found", "I could not find an appointment with that code. Could you read it to me again, or give me the phone number it was booked under?", { field: "code" });
    return a;
  }
  const phoneIn = readPhone(args, "phone");
  if (isFailure(phoneIn)) return phoneIn;
  const fromCaller = call.fromNumber ? readPhone({ p: call.fromNumber }, "p") : undefined;
  const phone = phoneIn.value ?? (fromCaller && !isFailure(fromCaller) ? fromCaller.value : undefined);
  if (!phone) return fail("missing_fields", `Which ${b.agent.visitWord} should I ${verb}? Your confirmation code or the phone number it was booked under is enough.`, { hint: "send code, or phone" });
  const list = d.db.upcomingForPhone(phone, call.nowMs);
  if (list.length === 0) return fail("not_found", `I do not see an upcoming ${b.agent.visitWord} under ${formatPhone(phone)}. Was it booked under another number, or do you have the confirmation code?`, { field: "phone" });
  const curIn = readStart(args, "current_start", b.timezone, "the current appointment");
  if (isFailure(curIn)) return curIn;
  const chosen = curIn.value !== undefined ? list.filter((a) => a.startUtc === curIn.value) : list;
  if (chosen.length === 1) return chosen[0] as Appointment;
  return fail("which_appointment", `I see ${list.length} upcoming ${b.agent.visitWord}s under that number: ${joinList(list.map((a) => `${serviceOf(d, a.serviceId).name.toLowerCase()} on ${spokenDateTime(a.startUtc, b.timezone)}`))}. Which one?`, {
    appointments: list.map((a) => appointmentView(d, a)),
    hint: "send current_start of the one the caller means",
  });
}

async function rescheduleAppointment(d: Deps, args: Record<string, unknown>, call: ToolCall): Promise<ToolOutput> {
  const b = d.b;
  if (!call.callId) return fail("missing_call", "I am sorry, I cannot change bookings right now. Let me connect you with the team.", { hint: "call.call_id is required" });
  const target = findTarget(d, args, call, "move");
  if (isFailure(target)) return target;
  const a = target;
  if (a.status === "cancelled") return fail("already_cancelled", `That ${b.agent.visitWord} was cancelled. Would you like to book a new one?`);
  const newIn = readStart(args, "new_start", b.timezone, "the new time");
  if (isFailure(newIn)) return newIn;
  if (newIn.value === undefined) return fail("missing_fields", "What day and time would you like instead?", { hint: "new_start is required" });
  const newStart = newIn.value;
  const service = serviceOf(d, a.serviceId);
  if (newStart === a.startUtc) {
    const out: ToolOutput = { ok: true, unchanged: true, appointment: appointmentView(d, a), message: `You are already booked for ${spokenDateTime(a.startUtc, b.timezone)}.` };
    log(d, call, "reschedule_appointment", out, `Reschedule to the same time; nothing changed (${a.code}).`, { appointmentId: a.id });
    return out;
  }
  const { busy } = await busyAround(d, newStart - 86_400_000, newStart + 86_400_000);
  const check = checkSlot(b, d.db, { startUtc: newStart, service, preferStaffId: a.staffId, nowMs: call.nowMs, busy, ignoreAppointmentId: a.id });
  if (!check.ok) {
    const out = slotProblem(d, check, service, newStart, undefined, call.nowMs, busy, a.id);
    log(d, call, "reschedule_appointment", out as ToolOutput, `Reschedule refused: ${out.error}.`, { appointmentId: a.id });
    return out as ToolOutput;
  }
  const from = { start: a.startUtc, staff: a.staffId };
  a.history.push({ atMs: call.nowMs, callId: call.callId, action: "rescheduled", fromStartUtc: from.start, fromStaffId: from.staff });
  Object.assign(a, { startUtc: newStart, endUtc: check.endUtc, staffId: check.staff.id, updatedAtMs: call.nowMs });
  try {
    d.db.saveAppointment(a);
  } catch (err) {
    if (String(err).includes("UNIQUE")) return slotProblem(d, { ok: false, code: "slot_taken" }, service, newStart, undefined, call.nowMs, busy, a.id) as ToolOutput;
    throw err;
  }
  const calendarOk = await syncCalendar(d, a);
  emailCaller(d, a, "rescheduled", call);
  const out: ToolOutput = {
    ok: true, appointment: appointmentView(d, a), calendar: calendarOk ? "synced" : "failed",
    message: `Done. Your ${service.name.toLowerCase()} is now on ${spokenDateTime(newStart, b.timezone)} with ${check.staff.short}.${a.email ? " I have emailed you the new time." : ""}`,
  };
  log(d, call, "reschedule_appointment", out, `Moved ${a.code} from ${spokenDateTime(from.start, b.timezone)} to ${spokenDateTime(newStart, b.timezone)}${calendarOk ? "" : " (CALENDAR SYNC FAILED)"}.`, { appointmentId: a.id });
  return out;
}

async function cancelAppointment(d: Deps, args: Record<string, unknown>, call: ToolCall): Promise<ToolOutput> {
  const b = d.b;
  if (!call.callId) return fail("missing_call", "I am sorry, I cannot change bookings right now. Let me connect you with the team.", { hint: "call.call_id is required" });
  const target = findTarget(d, args, call, "cancel");
  if (isFailure(target)) return target;
  const a = target;
  if (a.status === "cancelled") {
    const out: ToolOutput = { ok: true, already_cancelled: true, appointment: appointmentView(d, a), message: `That ${b.agent.visitWord} is already cancelled.` };
    log(d, call, "cancel_appointment", out, `Cancel repeated; ${a.code} was already cancelled.`, { appointmentId: a.id });
    return out;
  }
  const late = a.startUtc - call.nowMs < b.policies.cancellationNoticeHours * MS_HOUR;
  a.status = "cancelled";
  a.lateCancellation = late;
  a.updatedAtMs = call.nowMs;
  a.history.push({ atMs: call.nowMs, callId: call.callId, action: "cancelled" });
  d.db.saveAppointment(a);
  const calendarOk = await syncCalendar(d, a);
  emailCaller(d, a, "cancelled", call);
  const fee = late && b.policies.lateCancelFeeUsd > 0 ? ` Because it is less than ${b.policies.cancellationNoticeHours} hours away, a late fee of ${usd(b.policies.lateCancelFeeUsd)} may apply; the team will confirm.` : "";
  const deposit = a.depositStatus === "paid" ? " The team will be in touch about your deposit." : "";
  const out: ToolOutput = { ok: true, appointment: appointmentView(d, a), late_cancellation: late, message: `Your ${b.agent.visitWord} on ${spokenDateTime(a.startUtc, b.timezone)} is cancelled.${fee}${deposit} Would you like to book another time?` };
  log(d, call, "cancel_appointment", out, `Cancelled ${a.code}${late ? " (LATE)" : ""}${calendarOk ? "" : " (CALENDAR SYNC FAILED)"}.`, { appointmentId: a.id });
  return out;
}

async function requestTransfer(d: Deps, args: Record<string, unknown>, call: ToolCall): Promise<ToolOutput> {
  const r = readText(args, "reason", { label: "the reason", max: 500 });
  if (isFailure(r)) return r;
  const t = decideTransfer(d, r.value ?? "", call.nowMs);
  const out: ToolOutput = { ok: true, ...t };
  log(d, call, "request_transfer", out, `Transfer asked (${t.urgency}); ${t.transfer ? `to ${t.destination}` : t.destination === "none" ? "closed: message taken" : "demo line: flagged"}.`, {
    ...(t.urgency === "emergency" ? { urgentLabel: "emergency" as const } : t.urgency === "review" ? { urgentLabel: "ambiguous" as const } : {}),
    transfer: { destination: t.destination, urgency: t.urgency },
  });
  return out;
}

const HANDLERS: Record<ToolName, (d: Deps, args: Record<string, unknown>, call: ToolCall) => Promise<ToolOutput>> = {
  lookup_faq: lookupFaq,
  get_availability: getAvailability,
  book_appointment: bookAppointment,
  reschedule_appointment: rescheduleAppointment,
  cancel_appointment: cancelAppointment,
  request_transfer: requestTransfer,
};

export async function runTool(d: Deps, name: ToolName, args: unknown, call: ToolCall): Promise<ToolOutput> {
  const a = isRecord(args) ? args : {};
  return HANDLERS[name](d, a, call);
}

