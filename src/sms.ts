// Text-message confirmations through Twilio's Messaging REST API (no SDK), or a memory outbox for tests and for
// running without keys. A text goes out only when the caller said yes to texts, never to a number that replied STOP,
// and at most once per event: the database ledger records what was delivered, and an in-flight claim stops two
// requests sending the same text at once (Twilio has no idempotency key for messages).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";
import type { FetchLike } from "./email.ts";

export interface SmsMessage {
  /** E.164 */
  to: string;
  body: string;
  /** Stable per logical message; the same key never sends twice. */
  idempotencyKey: string;
}

export interface SmsSender {
  readonly kind: "twilio" | "memory";
  send(m: SmsMessage): Promise<{ id: string }>;
}

/** A refusal from Twilio, with its error code (21610: the number replied STOP; 21608: trial, number not verified). */
export class SmsError extends Error {
  readonly code: number | undefined;
  readonly status: number;
  constructor(message: string, status: number, code?: number) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Twilio error codes that mean "this number cannot get texts from us"; retrying will not help. */
export const UNSUBSCRIBED = 21610;
const PERMANENT = new Set([UNSUBSCRIBED, 21211, 21408, 21608, 21612, 21614, 21606]);

export class MemorySms implements SmsSender {
  readonly kind = "memory" as const;
  readonly sent: SmsMessage[] = [];
  failNext = 0;
  failCode: number | undefined;
  async send(m: SmsMessage): Promise<{ id: string }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new SmsError("SMS provider unavailable (simulated)", this.failCode ? 400 : 503, this.failCode);
    }
    this.sent.push(m);
    return { id: `SM_mem_${this.sent.length}` };
  }
}

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** A Twilio number in E.164 (+1...), or a Messaging Service SID (MG...). */
  from: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class TwilioSms implements SmsSender {
  readonly kind = "twilio" as const;
  private readonly o: TwilioOptions;
  constructor(o: TwilioOptions) {
    if (!/^AC[0-9a-f]{32}$/i.test(o.accountSid)) throw new Error("TWILIO_ACCOUNT_SID does not look like an Account SID (AC + 32 hex)");
    if (!/^[0-9a-f]{32}$/i.test(o.authToken)) throw new Error("TWILIO_AUTH_TOKEN does not look like an Auth Token (32 hex)");
    if (!/^\+[1-9]\d{6,14}$/.test(o.from) && !/^MG[0-9a-f]{32}$/i.test(o.from)) throw new Error("TWILIO_FROM must be a number in +E.164 form or a Messaging Service SID (MG...)");
    this.o = o;
  }

  async send(m: SmsMessage): Promise<{ id: string }> {
    const f = this.o.fetch ?? ((url, init) => fetch(url, init));
    const form = new URLSearchParams({ To: m.to, Body: m.body });
    form.set(this.o.from.startsWith("MG") ? "MessagingServiceSid" : "From", this.o.from);
    const res = await f(`https://api.twilio.com/2010-04-01/Accounts/${this.o.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000),
    });
    const body = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (!res.ok || !body.sid) throw new SmsError(`Twilio refused the text: ${res.status}${body.code ? ` (error ${body.code})` : ""} ${body.message ?? ""}`.trim().slice(0, 300), res.status, body.code);
    return { id: body.sid };
  }
}

// ---- opt-outs (STOP). Kept in their own table so the core schema is untouched.

function ensureTable(db: Db): void {
  db.sql.exec("CREATE TABLE IF NOT EXISTS sms_opt_out (phone TEXT PRIMARY KEY, at INTEGER NOT NULL, source TEXT NOT NULL)");
}

export function isOptedOut(db: Db, phone: string): boolean {
  ensureTable(db);
  return db.sql.prepare("SELECT 1 FROM sms_opt_out WHERE phone = ?").get(phone) !== undefined;
}

export function setOptOut(db: Db, phone: string, optedOut: boolean, nowMs: number, source: string): void {
  ensureTable(db);
  if (optedOut) db.sql.prepare("INSERT INTO sms_opt_out (phone, at, source) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET at = excluded.at, source = excluded.source").run(phone, nowMs, source);
  else db.sql.prepare("DELETE FROM sms_opt_out WHERE phone = ?").run(phone);
}

/** The standard carrier keywords. Twilio itself also honours them on its numbers; this keeps our own list in step. */
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);

export function keywordOf(body: string): "stop" | "start" | null {
  const w = body.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (STOP_WORDS.has(w)) return "stop";
  if (START_WORDS.has(w)) return "start";
  return null;
}

export type SmsResult = "sent" | "already_sent" | "opted_out";

/** Sends once per key. Returns "sent", "already_sent" (or in flight), "opted_out", or throws the provider's error. */
export async function sendSmsOnce(db: Db, sender: SmsSender, m: SmsMessage, nowMs: number): Promise<SmsResult> {
  const key = `sms:${m.idempotencyKey}`;
  if (db.hasDelivery(key)) return "already_sent";
  if (isOptedOut(db, m.to)) return "opted_out";
  if (db.claimEvent(key, nowMs) !== "claimed") return "already_sent";
  try {
    const r = await sender.send(m);
    db.markDelivery(key, nowMs, r.id);
    db.completeEvent(key);
    return "sent";
  } catch (err) {
    db.releaseEvent(key);
    // The number replied STOP to this sender at some point: remember it so we stop trying.
    if (err instanceof SmsError && err.code === UNSUBSCRIBED) {
      setOptOut(db, m.to, true, nowMs, "twilio_21610");
      return "opted_out";
    }
    throw err;
  }
}

export function isPermanent(err: unknown): boolean {
  return err instanceof SmsError && err.code !== undefined && PERMANENT.has(err.code);
}

// ---- inbound webhook signature (X-Twilio-Signature)

/** base64(HMAC-SHA1(authToken, url + each POST param name and value, sorted by name)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, given: string | undefined): boolean {
  if (!given) return false;
  const want = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Plain characters only (GSM-7), so a confirmation stays one or two segments. */
export function gsmSafe(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\n]/g, "");
}
