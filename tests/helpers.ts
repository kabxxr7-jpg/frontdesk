import { loadBusiness, type Business } from "../src/business.ts";
import { MemoryCalendar } from "../src/calendar.ts";
import { Db } from "../src/db.ts";
import { MemoryEmail } from "../src/email.ts";
import { createApp, type App, type AppConfig, type Res } from "../src/server.ts";
import { signBody } from "../src/signature.ts";
import { signStripePayload } from "../src/stripe.ts";

export const KEY = "key_test_retell_0123456789";
export const LINK = "link-secret-0123456789abcdef";
export const STRIPE_HOOK = "whsec_test_0123456789";
export const DENTAL_DIR = "businesses/brightside-family-dental";

/** Saturday 7 Nov 2026, 9:00 AM in New York (14:00 UTC). */
export const SAT_9AM = Date.UTC(2026, 10, 7, 14, 0);

export interface Rig {
  app: App;
  db: Db;
  cal: MemoryCalendar;
  mail: MemoryEmail;
  b: Business;
  now: { ms: number };
  fetchCalls: { url: string; init?: RequestInit }[];
  fetchReply: { status: number; body: unknown };
  tool(name: string, args: Record<string, unknown>, call?: Record<string, unknown>): Promise<Record<string, unknown>>;
  post(path: string, body: unknown, opts?: { sign?: boolean; headers?: Record<string, string> }): Promise<Res>;
  get(path: string): Promise<Res>;
  stripeEvent(ev: unknown, opts?: { badSig?: boolean }): Promise<Res>;
}

export function rig(over: Partial<AppConfig> = {}, b: Business = loadBusiness(DENTAL_DIR)): Rig {
  const db = new Db(":memory:");
  const cal = new MemoryCalendar();
  const mail = new MemoryEmail();
  const now = { ms: SAT_9AM };
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  const fetchReply = { status: 200, body: {} as unknown };
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({ url, ...(init ? { init } : {}) });
    if (url.startsWith("https://api.stripe.com/v1/checkout/sessions")) {
      return new Response(JSON.stringify({ id: `cs_test_${fetchCalls.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${fetchCalls.length}`, expires_at: Math.floor(now.ms / 1000) + 23 * 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(fetchReply.body), { status: fetchReply.status });
  };
  const { StripeClient } = awaitStripe();
  const app = createApp({
    b, db, calendar: cal, email: mail, retellApiKey: KEY, publicBaseUrl: "https://desk.test", linkSecret: LINK,
    stripe: { client: new StripeClient({ secretKey: "sk_test_abc", fetch: fakeFetch }), webhookSecret: STRIPE_HOOK },
    teamEmail: "team@desk.test", clock: () => now.ms, fetch: fakeFetch, summaryFallbackMs: 0, ...over,
  });
  const post = async (path: string, body: unknown, opts: { sign?: boolean; headers?: Record<string, string> } = {}) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (opts.sign !== false) headers["x-retell-signature"] = signBody(raw, KEY, now.ms);
    return app.handle({ method: "POST", url: path, headers, body: Buffer.from(raw) });
  };
  let seq = 0;
  return {
    app, db, cal, mail, b, now, fetchCalls, fetchReply, post,
    async tool(name, args, call = { call_id: "call_A", from_number: "+12015551234" }) {
      seq += 1;
      // A unique field keeps each signed body unique (the replay guard remembers digests).
      const r = await post(`/tools/${name}`, { name, args, call: { ...call, _seq: seq } });
      if (r.status !== 200) throw new Error(`tool ${name} answered ${r.status}: ${r.body}`);
      return JSON.parse(r.body) as Record<string, unknown>;
    },
    get: (path) => app.handle({ method: "GET", url: path, headers: {}, body: Buffer.alloc(0) }),
    stripeEvent: (ev, opts = {}) => {
      const raw = JSON.stringify(ev);
      return app.handle({ method: "POST", url: "/webhooks/stripe", headers: { "stripe-signature": signStripePayload(raw, opts.badSig ? "whsec_wrong" : STRIPE_HOOK, now.ms) }, body: Buffer.from(raw) });
    },
  };
}

import * as stripeModule from "../src/stripe.ts";
function awaitStripe() {
  return stripeModule;
}

export function checkoutCompleted(id: string, aptId: string, paid = true) {
  return { id, type: "checkout.session.completed", livemode: false, data: { object: { id: "cs_test_x", client_reference_id: aptId, payment_status: paid ? "paid" : "unpaid", payment_intent: "pi_test_1", metadata: { appointment_id: aptId } } } };
}
