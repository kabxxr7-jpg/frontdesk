// After a call: Retell sends call_ended and later call_analyzed. The first event that arrives builds a summary from
// what the tools did on that call (bookings, emergencies, failed emails) plus what Retell knows (duration, its own
// summary) and sends it ONCE to n8n (which fans out to the CRM, GoHighLevel and the team inbox), or straight to the
// team inbox when n8n is not configured. De-duplicated per event and call id; a failed delivery answers 500 so
// Retell retries, and the delivery ledger stops a channel that already worked from sending twice.
import { createHmac } from "node:crypto";
import type { Business } from "./business.ts";
import type { Appointment, Db, ToolLogEntry } from "./db.ts";
import { sendOnce, type EmailSender } from "./email.ts";
import { formatPhone, usd } from "./text.ts";
import { spokenDateTime, toIsoWithOffset } from "./time.ts";
import { isRecord } from "./validate.ts";

export const CALL_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

export interface PostCallDeps {
  b: Business;
  db: Db;
  email: EmailSender;
  teamEmail?: string | undefined;
  n8n?: { url: string; secret: string } | undefined;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  nowMs: number;
}

export interface CallSummary {
  call_id: string;
  business: { slug: string; name: string; fictional: boolean };
  call_type: string | null;
  from_number: string | null;
  started_at: string | null;
  duration_seconds: number | null;
  disconnection_reason: string | null;
  urgency: "emergency" | "needs_person" | "routine";
  outcome: string;
  platform_summary: string | null;
  sentiment: string | null;
  customer: { name: string | null; phone: string | null; email: string | null };
  appointments: { code: string; service: string; start: string; spoken: string; staff: string; status: string; deposit_usd: number; deposit_status: string; calendar: string }[];
  actions: { tool: string; ok: boolean; note: string }[];
  problems: string[];
  recording_url: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 2000) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Only the fields we use; the transcript is never stored. */
export function pickCall(payload: Record<string, unknown>): Record<string, unknown> {
  const c = isRecord(payload["call"]) ? payload["call"] : {};
  const a = isRecord(c["call_analysis"]) ? c["call_analysis"] : {};
  return {
    call_id: c["call_id"], call_type: c["call_type"], from_number: c["from_number"], to_number: c["to_number"],
    start_timestamp: c["start_timestamp"], end_timestamp: c["end_timestamp"], duration_ms: c["duration_ms"],
    disconnection_reason: c["disconnection_reason"], recording_url: c["recording_url"],
    call_analysis: { call_summary: a["call_summary"], user_sentiment: a["user_sentiment"], call_successful: a["call_successful"] },
  };
}

export function buildSummary(b: Business, call: Record<string, unknown>, log: ToolLogEntry[], appts: Appointment[]): CallSummary {
  const analysis = isRecord(call["call_analysis"]) ? call["call_analysis"] : {};
  const start = num(call["start_timestamp"]);
  const end = num(call["end_timestamp"]);
  const dur = num(call["duration_ms"]) ?? (start !== null && end !== null ? end - start : null);
  const urgency: CallSummary["urgency"] = log.some((e) => e.urgentLabel === "emergency")
    ? "emergency"
    : log.some((e) => e.urgentLabel === "ambiguous" || e.transfer !== undefined) ? "needs_person" : "routine";
  const booked = appts.filter((a) => a.status === "booked");
  const outcome = log.some((e) => e.tool === "cancel_appointment" && e.ok && e.outcome === "ok" && !e.note.startsWith("Cancel repeated"))
    ? "cancelled"
    : log.some((e) => e.tool === "reschedule_appointment" && e.ok) ? "rescheduled"
    : booked.length > 0 ? "booked"
    : log.some((e) => e.tool === "request_transfer") ? "transfer_or_message"
    : log.some((e) => e.tool === "lookup_faq") ? "question_answered" : "no_action";
  const latest = appts[appts.length - 1];
  const problems = log.filter((e) => !e.ok && (e.outcome === "email_failed" || e.note.includes("FAILED"))).map((e) => e.note);
  for (const a of appts) if (a.calendarStatus === "failed") problems.push(`Calendar sync failed for ${a.code}: add it to the calendar by hand.`);
  return {
    call_id: String(call["call_id"]),
    business: { slug: b.slug, name: b.name, fictional: b.fictional },
    call_type: str(call["call_type"]),
    from_number: str(call["from_number"]),
    started_at: start !== null ? new Date(start).toISOString() : null,
    duration_seconds: dur !== null ? Math.round(dur / 1000) : null,
    disconnection_reason: str(call["disconnection_reason"]),
    urgency,
    outcome,
    platform_summary: str(analysis["call_summary"]),
    sentiment: str(analysis["user_sentiment"]),
    customer: { name: latest?.customerName ?? null, phone: latest?.phone ?? str(call["from_number"]), email: latest?.email ?? null },
    appointments: appts.map((a) => ({
      code: a.code,
      service: b.services.find((s) => s.id === a.serviceId)?.name ?? a.serviceId,
      start: toIsoWithOffset(a.startUtc, b.timezone),
      spoken: spokenDateTime(a.startUtc, b.timezone),
      staff: b.staff.find((s) => s.id === a.staffId)?.name ?? a.staffId,
      status: a.status,
      deposit_usd: a.depositUsd,
      deposit_status: a.depositStatus,
      calendar: a.calendarStatus,
    })),
    actions: log.map((e) => ({ tool: e.tool, ok: e.ok, note: e.note })),
    problems,
    recording_url: str(call["recording_url"]),
  };
}

export function summaryEmail(s: CallSummary): { subject: string; text: string } {
  const flag = s.urgency === "emergency" ? "URGENT " : s.urgency === "needs_person" ? "Follow up " : "";
  const who = s.customer.name ?? (s.from_number ? formatPhone(s.from_number) : "Unknown caller");
  const subject = `${flag}${s.business.name}: ${s.outcome.replace(/_/g, " ")} - ${who}`.slice(0, 160);
  const lines = [
    `${s.business.name}${s.business.fictional ? " (demo, fictional business)" : ""}`,
    `Call ${s.call_id} (${s.call_type ?? "call"}), ${s.duration_seconds ?? "?"} s, from ${s.from_number ? formatPhone(s.from_number) : "unknown"}`,
    `Urgency: ${s.urgency}. Outcome: ${s.outcome.replace(/_/g, " ")}.`,
    "",
    ...(s.problems.length ? ["PROBLEMS:", ...s.problems.map((p) => `- ${p}`), ""] : []),
    ...(s.appointments.length
      ? ["Appointments:", ...s.appointments.map((a) => `- ${a.code} ${a.service}, ${a.spoken}, ${a.staff}, ${a.status}${a.deposit_usd ? `, deposit ${usd(a.deposit_usd)} ${a.deposit_status}` : ""}`), ""]
      : []),
    `Customer: ${s.customer.name ?? "-"} | ${s.customer.phone ?? "-"} | ${s.customer.email ?? "-"}`,
    "",
    "What happened:",
    ...s.actions.map((a) => `- ${a.note}`),
    "",
    `Platform summary: ${s.platform_summary ?? "(not yet available)"}`,
  ];
  return { subject, text: lines.join("\n") };
}

export function signN8n(body: string, secret: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

async function deliver(d: PostCallDeps, key: string, s: CallSummary): Promise<string[]> {
  const sent: string[] = [];
  const failures: string[] = [];
  if (d.n8n) {
    const k = `n8n:${key}`;
    if (!d.db.hasDelivery(k)) {
      try {
        const body = JSON.stringify({ event: key.split(":")[0], summary: s, email: summaryEmail(s) });
        const f = d.fetch ?? ((u, i) => fetch(u, i));
        const res = await f(d.n8n.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // n8n's Webhook node checks this with a Header Auth credential; the HMAC lets a Code node verify the body too.
            "x-frontdesk-token": d.n8n.secret,
            "x-frontdesk-signature": signN8n(body, d.n8n.secret, d.nowMs),
            "x-frontdesk-delivery": k,
          },
          body,
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) throw new Error(`n8n answered ${res.status}`);
        d.db.markDelivery(k, d.nowMs);
        sent.push("n8n");
      } catch (err) {
        failures.push(`n8n: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // Without n8n, or when n8n failed, the team inbox gets the summary directly so nothing is lost.
  if (d.teamEmail && (!d.n8n || failures.length > 0)) {
    const m = summaryEmail(s);
    try {
      await sendOnce(d.db, d.email, { to: d.teamEmail, subject: m.subject, text: m.text, idempotencyKey: `team:${key}` }, d.nowMs);
      sent.push("team_email");
      if (failures.length > 0) failures.length = 0; // the fallback delivered it
    } catch (err) {
      failures.push(`team email: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
  return sent;
}

export async function handleRetellWebhook(payload: unknown, d: PostCallDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isRecord(payload) || typeof payload["event"] !== "string" || !isRecord(payload["call"])) return { status: 400, body: { error: "invalid_payload" } };
  const event = payload["event"];
  if (event !== "call_ended" && event !== "call_analyzed") return { status: 200, body: { status: "ignored", event } };
  const callId = payload["call"]["call_id"];
  if (typeof callId !== "string" || !CALL_ID.test(callId)) return { status: 400, body: { error: "missing_call_id" } };
  const key = `${event}:${callId}`;
  const claim = d.db.claimEvent(key, d.nowMs);
  if (claim === "done") return { status: 200, body: { status: "duplicate", event, call_id: callId } };
  if (claim === "in_flight") return { status: 409, body: { error: "in_flight" } };
  try {
    const picked = pickCall(payload);
    const before = d.db.getCall(callId);
    const other = event === "call_ended" ? before?.analyzedPayload : before?.endedPayload;
    d.db.updateCall(callId, event === "call_ended" ? { endedPayload: picked } : { analyzedPayload: picked });
    const merged: Record<string, unknown> = { ...(isRecord(other) ? other : {}), ...Object.fromEntries(Object.entries(picked).filter(([, v]) => v !== undefined)) };
    if (isRecord(other) && isRecord(other["call_analysis"]) && isRecord(picked["call_analysis"])) {
      merged["call_analysis"] = { ...other["call_analysis"], ...Object.fromEntries(Object.entries(picked["call_analysis"]).filter(([, v]) => v !== undefined)) };
    }
    const summary = buildSummary(d.b, merged, d.db.toolLogFor(callId), d.db.appointmentsForCall(callId));
    // One summary per call. call_analyzed carries Retell's own summary, so it is the one we send; call_ended only
    // records the call, unless call_analyzed already came (then nothing more is sent).
    let status = "recorded";
    if (event === "call_analyzed" && !before?.summarySent) {
      const sent = await deliver(d, `summary:${callId}`, summary);
      d.db.updateCall(callId, { summarySent: true });
      status = `summary_sent:${sent.join("+") || "nowhere_configured"}`;
    }
    d.db.completeEvent(key);
    return { status: 200, body: { status, event, call_id: callId } };
  } catch (err) {
    d.db.releaseEvent(key);
    // The reason stays in our log; the platform only needs to know to retry.
    console.error(`post-call delivery failed for ${callId}: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
    return { status: 500, body: { error: "delivery_failed", message: "summary delivery failed; retry" } };
  }
}
