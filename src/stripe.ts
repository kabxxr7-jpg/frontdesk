// Stripe deposits, TEST MODE ONLY. The confirmation email links to /pay/<token> on this server; that page creates (or
// reuses) a Checkout Session and redirects, so a link never expires before the caller clicks it. The webhook
// (checkout.session.completed) marks the appointment deposit-paid, once, whatever order or how often Stripe sends it.
import { createHmac, timingSafeEqual } from "node:crypto";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function assertTestKey(key: string): void {
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) throw new Error("STRIPE_SECRET_KEY is a LIVE key. This demo runs in Stripe test mode only; use sk_test_...");
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) throw new Error("STRIPE_SECRET_KEY must be a test key (sk_test_...)");
}

// ---------------------------------------------------------------- pay-link tokens

/** `<appointment id>.<first 24 hex of HMAC>`: unguessable, needs no database row. */
export function payToken(appointmentId: string, secret: string): string {
  return `${appointmentId}.${createHmac("sha256", secret).update(`pay:${appointmentId}`).digest("hex").slice(0, 24)}`;
}

export function readPayToken(token: string, secret: string): string | null {
  const m = /^(apt_\d{1,10})\.([0-9a-f]{24})$/.exec(token);
  if (!m) return null;
  const expected = payToken(m[1] as string, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b) ? (m[1] as string) : null;
}

// ---------------------------------------------------------------- Checkout

export interface CheckoutInput {
  appointmentId: string;
  amountUsd: number;
  productName: string;
  customerEmail?: string | undefined;
  successUrl: string;
  cancelUrl: string;
  /** Unix seconds; Stripe allows 30 minutes to 24 hours from now. */
  expiresAtSec: number;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAtSec: number;
}

export class StripeClient {
  private readonly fetch: FetchLike;
  private readonly o: { secretKey: string; fetch?: FetchLike; timeoutMs?: number };
  constructor(o: { secretKey: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.o = o;
    assertTestKey(o.secretKey);
    this.fetch = o.fetch ?? ((url, init) => fetch(url, init));
  }

  private async post(path: string, form: Record<string, string>, idempotencyKey: string): Promise<Record<string, unknown>> {
    const res = await this.fetch(`https://api.stripe.com/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.o.secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": idempotencyKey },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Stripe ${path} failed: ${res.status} ${json.error?.message ?? ""}`.trim().slice(0, 300));
    return json;
  }

  /** Stops an open Checkout Session from taking payment (used when the booking is cancelled). */
  async expireCheckout(sessionId: string): Promise<void> {
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) throw new Error("not a checkout session id");
    await this.post(`/checkout/sessions/${sessionId}/expire`, {}, `expire:${sessionId}`);
  }

  async createCheckout(i: CheckoutInput, idempotencyKey: string): Promise<CheckoutSession> {
    const cents = Math.round(i.amountUsd * 100);
    const form: Record<string, string> = {
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(cents),
      "line_items[0][price_data][product_data][name]": i.productName,
      success_url: i.successUrl,
      cancel_url: i.cancelUrl,
      client_reference_id: i.appointmentId,
      "metadata[appointment_id]": i.appointmentId,
      "payment_intent_data[metadata][appointment_id]": i.appointmentId,
      expires_at: String(i.expiresAtSec),
    };
    if (i.customerEmail) form["customer_email"] = i.customerEmail;
    const s = await this.post("/checkout/sessions", form, idempotencyKey);
    if (typeof s["id"] !== "string" || typeof s["url"] !== "string") throw new Error("Stripe returned no session url");
    return { id: s["id"], url: s["url"], expiresAtSec: Number(s["expires_at"] ?? i.expiresAtSec) };
  }
}

// ---------------------------------------------------------------- webhook signature

/**
 * Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed with the endpoint secret>
 * (several v1 entries are possible during secret rotation). Rejects beyond `toleranceSec`.
 */
export function verifyStripeSignature(rawBody: Buffer | string, header: string | undefined, secret: string, nowMs: number, toleranceSec = 300): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing_header" };
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((x) => x.trim());
    if (k === "t" && v) t = v;
    if (k === "v1" && v) v1.push(v);
  }
  if (!t || !/^\d{1,12}$/.test(t) || v1.length === 0) return { ok: false, reason: "malformed_header" };
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex"));
  const match = v1.some((sig) => {
    const got = Buffer.from(sig);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return match ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/** Builds a valid header (tests, and the local end-to-end script). */
export function signStripePayload(rawBody: string, secret: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}
