// Email through Resend's REST API (no SDK), or a memory outbox for tests and for running without a key.
// Every send carries an idempotency key, and the database ledger records what was delivered, so a retried webhook
// or a double click never sends the same email twice.
import type { Db } from "./db.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Stable per logical message; the same key never sends twice. */
  idempotencyKey: string;
}

export interface EmailSender {
  readonly kind: "resend" | "memory";
  send(m: EmailMessage): Promise<{ id: string }>;
}

export class MemoryEmail implements EmailSender {
  readonly kind = "memory" as const;
  readonly sent: EmailMessage[] = [];
  failNext = 0;
  async send(m: EmailMessage): Promise<{ id: string }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("email provider unavailable (simulated)");
    }
    this.sent.push(m);
    return { id: `mem_${this.sent.length}` };
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ResendEmail implements EmailSender {
  readonly kind = "resend" as const;
  private readonly o: { apiKey: string; from: string; fetch?: FetchLike; timeoutMs?: number };
  constructor(o: { apiKey: string; from: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.o = o;
    if (!o.apiKey.startsWith("re_")) throw new Error("RESEND_API_KEY does not look like a Resend key (re_...)");
  }

  async send(m: EmailMessage): Promise<{ id: string }> {
    const f = this.o.fetch ?? ((url, init) => fetch(url, init));
    const res = await f("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.o.apiKey}`,
        "content-type": "application/json",
        // Resend keeps idempotency keys for 24 hours; at most 256 characters.
        "idempotency-key": m.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({
        from: this.o.from,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok || !body.id) throw new Error(`Resend refused the email: ${res.status} ${body.name ?? ""} ${body.message ?? ""}`.trim().slice(0, 300));
    return { id: body.id };
  }
}

/** Sends once per idempotency key, recorded in the database ledger. Returns "sent", "already_sent" or throws. */
export async function sendOnce(db: Db, sender: EmailSender, m: EmailMessage, nowMs: number): Promise<"sent" | "already_sent"> {
  const key = `email:${m.idempotencyKey}`;
  if (db.hasDelivery(key)) return "already_sent";
  const r = await sender.send(m);
  db.markDelivery(key, nowMs, r.id);
  return "sent";
}

export const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;

/**
 * Speech-to-text writes emails as "jane dot doe at gmail dot com" or "j a n e at gmail.com". Turns that into an
 * address, or returns null when it still does not look like one.
 */
export function normalizeSpokenEmail(input: string): string | null {
  let t = input.trim().toLowerCase();
  t = t.replace(/\s+(at)\s+/g, "@").replace(/\s*\(at\)\s*/g, "@");
  t = t.replace(/\s+(dot)\s+/g, ".").replace(/\s+dot$/g, "");
  t = t.replace(/\s+underscore\s+/g, "_").replace(/\s+(dash|hyphen)\s+/g, "-");
  t = t.replace(/\s+/g, "");
  t = t.replace(/\.+$/, "");
  return EMAIL_PATTERN.test(t) ? t : null;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
