// HTTP server (plain node:http). Routes:
//   GET  /healthz                    liveness (no secrets, no data)
//   POST /tools/<name>               Retell custom function, X-Retell-Signature over the raw body
//   POST /webhooks/retell            call_ended / call_analyzed, signed the same way
//   POST /webhooks/retell-inbound    call_inbound: rejects calls past the daily cap (bill protection)
//   POST /vapi                       Vapi: tool-calls and end-of-call-report, shared secret header (or ?token=)
//   POST /webhooks/stripe            checkout.session.completed, Stripe-Signature
//   GET  /pay/<token>                creates or reuses a Stripe test-mode Checkout Session and redirects to it
//   GET  /pay/done, /pay/cancelled   plain pages after Checkout
// Business outcomes are HTTP 200 with a spoken-style message; 4xx only for malformed or unauthenticated requests.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Business } from "./business.ts";
import type { Calendar } from "./calendar.ts";
import type { Db } from "./db.ts";
import { escapeHtml, sendOnce, type EmailSender } from "./email.ts";
import { CALL_ID, handleRetellWebhook } from "./postcall.ts";
import { DEFAULT_TOLERANCE_MS, ReplayGuard, verifyRetellSignature } from "./signature.ts";
import { readPayToken, verifyStripeSignature, type StripeClient } from "./stripe.ts";
import { appointmentEmail, eventForAppointment, isToolName, runTool, type Deps } from "./tools.ts";
import { usd } from "./text.ts";
import { localYmd, spokenDateTime, zonedToUtc } from "./time.ts";
import { isRecord } from "./validate.ts";
import { endOfCallAsRetell, readToolCalls, sameSecret, VAPI_TOKEN_HEADER, vapiCallInfo } from "./vapi.ts";

export interface AppConfig {
  b: Business;
  db: Db;
  calendar: Calendar;
  email: EmailSender;
  /** Retell's API key (signs Retell's requests). Optional when only Vapi is used. */
  retellApiKey?: string | undefined;
  /** Shared secret Vapi sends on every request (VAPI_SERVER_SECRET). Enables POST /vapi. */
  vapiSecret?: string | undefined;
  publicBaseUrl: string;
  linkSecret: string;
  stripe?: { client: StripeClient; webhookSecret: string } | undefined;
  teamEmail?: string | undefined;
  replyTo?: string | undefined;
  n8n?: { url: string; secret: string } | undefined;
  transfersLive?: boolean;
  maxCallsPerDay?: number;
  clock?: () => number;
  log?: (line: string) => void;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** How long after call_ended to send the summary if call_analyzed never comes. 0 disables. */
  summaryFallbackMs?: number;
  /** Static demo pages by path ("/", "/demos/<slug>/"), read once at startup from ./public. */
  sitePages?: Record<string, string>;
  /** Static files next to the demo pages (preview images), by path. */
  siteAssets?: Record<string, { type: string; data: Buffer }>;
}

export interface Req {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
export interface Res {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Binary body (images); sent instead of `body` when set. */
  raw?: Buffer;
}

const JSON_H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const HTML_H = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
const json = (status: number, body: unknown): Res => ({ status, headers: JSON_H, body: JSON.stringify(body) });
const MAX_BODY = 256 * 1024;

function header(req: Req, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? undefined : v;
}

function page(b: Business, title: string, bodyHtml: string, status = 200): Res {
  const color = /^#[0-9a-fA-F]{6}$/.test(b.brand.color) ? b.brand.color : "#0f766e";
  return {
    status,
    headers: HTML_H,
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f6f7f9;color:#111}main{max-width:520px;margin:48px auto;padding:0 16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px}h1{font-size:20px;margin:0 0 12px;color:${color}}p{line-height:1.5}.note{font-size:13px;color:#6b7280}</style></head>
<body><main><div class="card"><h1>${escapeHtml(title)}</h1>${bodyHtml}${b.fictional ? `<p class="note">${escapeHtml(b.fictionNote)} Payments use Stripe test mode: no real money moves.</p>` : ""}</div></main></body></html>`,
  };
}

/** Paths without query strings, and pay links without their token (the token opens a customer's page). */
const redact = (url: string): string => (url.split("?")[0] ?? "/").replace(/^\/pay\/apt_[^/]+$/, "/pay/<token>");

export interface App {
  handle(req: Req): Promise<Res>;
  deps: Deps;
  /** Resolves when background work started so far has finished (tests). */
  settle(): Promise<void>;
  close(): void;
}

export function createApp(c: AppConfig): App {
  const retellKey = c.retellApiKey && c.retellApiKey.length >= 8 ? c.retellApiKey : undefined;
  const vapiSecret = c.vapiSecret && c.vapiSecret.length >= 24 ? c.vapiSecret : undefined;
  if (c.vapiSecret && !vapiSecret) throw new Error("VAPI_SERVER_SECRET must be 24+ characters");
  if (!retellKey && !vapiSecret) throw new Error("RETELL_API_KEY or VAPI_SERVER_SECRET is required");
  if (!c.linkSecret || c.linkSecret.length < 16) throw new Error("LINK_SECRET is required (16+ characters)");
  const clock = c.clock ?? Date.now;
  const log = c.log ?? (() => {});
  const pending = new Set<Promise<unknown>>();
  const timers = new Set<NodeJS.Timeout>();
  const deps: Deps = {
    b: c.b, db: c.db, calendar: c.calendar, email: c.email, publicBaseUrl: c.publicBaseUrl.replace(/\/+$/, ""), linkSecret: c.linkSecret,
    depositsEnabled: Boolean(c.stripe), transfersLive: c.transfersLive ?? false, replyTo: c.replyTo, log,
    ...(c.stripe ? { expireCheckout: (id: string) => (c.stripe as NonNullable<AppConfig["stripe"]>).client.expireCheckout(id) } : {}),
    background: (p) => {
      pending.add(p);
      void p.finally(() => pending.delete(p));
    },
  };
  const guard = new ReplayGuard({ toleranceMs: DEFAULT_TOLERANCE_MS });

  function verifyRetell(req: Req): { ok: true; digest: string } | { ok: false; res: Res } {
    if (!retellKey) return { ok: false, res: json(404, { error: "not_found" }) };
    const check = verifyRetellSignature(req.body, header(req, "x-retell-signature"), retellKey, clock());
    if (!check.ok) return { ok: false, res: json(401, { error: "unauthorized", reason: check.reason }) };
    return { ok: true, digest: check.digest };
  }

  function parse(req: Req): unknown | undefined {
    try {
      return JSON.parse(req.body.toString("utf8"));
    } catch {
      return undefined;
    }
  }

  const postCallDeps = () => ({ b: c.b, db: c.db, email: c.email, teamEmail: c.teamEmail, n8n: c.n8n, nowMs: clock(), ...(c.fetch ? { fetch: c.fetch } : {}) });

  async function toolRoute(req: Req, name: string): Promise<Res> {
    if (!isToolName(name)) return json(404, { error: "unknown_tool" });
    const v = verifyRetell(req);
    if (!v.ok) return v.res;
    const replay = guard.check(v.digest, clock());
    if (replay.kind === "replay") return replay.cached ? { status: replay.cached.status, headers: JSON_H, body: replay.cached.body } : json(409, { error: "replay" });
    guard.remember(v.digest, clock());
    const body = parse(req);
    if (!isRecord(body)) return json(400, { error: "invalid_json" });
    if (body["name"] !== undefined && body["name"] !== name) return json(400, { error: "tool_name_mismatch" });
    const call = isRecord(body["call"]) ? body["call"] : {};
    const callId = typeof call["call_id"] === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(call["call_id"]) ? call["call_id"] : undefined;
    const fromNumber = typeof call["from_number"] === "string" ? call["from_number"] : undefined;
    let out;
    try {
      out = await runTool(deps, name, body["args"], { nowMs: clock(), callId, fromNumber });
    } catch (err) {
      guard.forget(v.digest); // a retry of a request that crashed must be allowed to run
      throw err;
    }
    const res = json(200, out);
    guard.remember(v.digest, clock(), { status: res.status, body: res.body });
    return res;
  }

  async function retellWebhook(req: Req): Promise<Res> {
    const v = verifyRetell(req);
    if (!v.ok) return v.res;
    const body = parse(req);
    if (body === undefined) return json(400, { error: "invalid_json" });
    const r = await handleRetellWebhook(body, postCallDeps());
    // If call_analyzed never arrives, send the summary from what we have after a while.
    if (r.status === 200 && isRecord(body) && body["event"] === "call_ended" && (c.summaryFallbackMs ?? 180_000) > 0) {
      const callId = String(r.body["call_id"]);
      const t = setTimeout(() => {
        timers.delete(t);
        try {
          if (c.db.getCall(callId)?.summarySent) return;
          const ended = c.db.getCall(callId)?.endedPayload;
          const synthetic = { event: "call_analyzed", call: isRecord(ended) ? ended : { call_id: callId } };
          handleRetellWebhook(synthetic, postCallDeps())
            .then((x) => log(`summary fallback for ${callId}: ${x.status} ${JSON.stringify(x.body)}`))
            .catch((err: unknown) => log(`summary fallback for ${callId} failed: ${err instanceof Error ? err.message : String(err)}`));
        } catch (err) {
          log(`summary fallback for ${callId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, c.summaryFallbackMs ?? 180_000);
      t.unref();
      timers.add(t);
    }
    return json(r.status, r.body);
  }

  async function vapi(req: Req): Promise<Res> {
    if (!vapiSecret) return json(404, { error: "not_found" });
    const bearer = header(req, "authorization")?.replace(/^Bearer\s+/i, "");
    const query = new URLSearchParams(req.url.split("?")[1] ?? "").get("token") ?? undefined;
    const given = [header(req, VAPI_TOKEN_HEADER), header(req, "x-vapi-secret"), bearer, query].find((x) => sameSecret(x, vapiSecret));
    if (!given) return json(401, { error: "unauthorized" });
    const body = parse(req);
    const message = isRecord(body) && isRecord(body["message"]) ? body["message"] : undefined;
    if (!message || typeof message["type"] !== "string") return json(400, { error: "invalid_payload" });
    const info = vapiCallInfo(message);
    const callId = info.callId && CALL_ID.test(info.callId) ? info.callId : undefined;
    if (message["type"] === "tool-calls") {
      const results: { toolCallId: string; result: string }[] = [];
      // One at a time and in order: a booking and its follow-up in the same turn must not race each other.
      for (const tc of readToolCalls(message)) {
        if (!isToolName(tc.name)) {
          results.push({ toolCallId: tc.id, result: JSON.stringify({ ok: false, error: "unknown_tool", message: "Sorry, I can't do that here." }) });
          continue;
        }
        const out = await runTool(deps, tc.name, tc.args, { nowMs: clock(), callId, fromNumber: info.fromNumber });
        results.push({ toolCallId: tc.id, result: JSON.stringify(out) });
      }
      return json(200, { results });
    }
    if (message["type"] === "end-of-call-report") {
      if (!callId) return json(400, { error: "missing_call_id" });
      const r = await handleRetellWebhook(endOfCallAsRetell(message), postCallDeps());
      return json(r.status, r.body);
    }
    return json(200, { status: "ignored", type: message["type"] });
  }

  function inbound(req: Req): Res {
    const v = verifyRetell(req);
    if (!v.ok) return v.res;
    const body = parse(req);
    if (!isRecord(body) || body["event"] !== "call_inbound" || !isRecord(body["call_inbound"])) return json(400, { error: "invalid_payload" });
    const ci = body["call_inbound"];
    const now = clock();
    const today = localYmd(now, c.b.timezone);
    const midnight = zonedToUtc(today, 0, c.b.timezone);
    const since = midnight.kind === "gap" ? now - 86_400_000 : midnight.utcMs;
    const count = c.db.countCallsSince(since);
    const cap = c.maxCallsPerDay ?? 40;
    if (count >= cap) {
      log(`inbound call rejected: daily cap ${cap} reached`);
      return json(200, { call_inbound: { reject: true } });
    }
    const id = typeof ci["call_id"] === "string" ? ci["call_id"] : `${now}`;
    c.db.recordEvent(`inbound:${id}`, now);
    return json(200, { call_inbound: { dynamic_variables: { business_name: c.b.name } } });
  }

  async function stripeWebhook(req: Req): Promise<Res> {
    if (!c.stripe) return json(404, { error: "not_found" });
    const sig = verifyStripeSignature(req.body, header(req, "stripe-signature"), c.stripe.webhookSecret, clock());
    if (!sig.ok) return json(400, { error: "bad_signature", reason: sig.reason });
    const ev = parse(req);
    if (!isRecord(ev) || typeof ev["id"] !== "string" || typeof ev["type"] !== "string") return json(400, { error: "invalid_payload" });
    if (ev["livemode"] === true) return json(400, { error: "live_mode_event_refused" });
    if (ev["type"] !== "checkout.session.completed" && ev["type"] !== "checkout.session.async_payment_succeeded") return json(200, { status: "ignored" });
    const key = `stripe:${ev["id"]}`;
    const claim = c.db.claimEvent(key, clock());
    if (claim === "done") return json(200, { status: "duplicate" });
    if (claim === "in_flight") return json(409, { error: "in_flight" });
    try {
      const obj = isRecord(ev["data"]) && isRecord(ev["data"]["object"]) ? ev["data"]["object"] : {};
      const meta = isRecord(obj["metadata"]) ? obj["metadata"] : {};
      const aptId = typeof meta["appointment_id"] === "string" ? meta["appointment_id"] : typeof obj["client_reference_id"] === "string" ? obj["client_reference_id"] : undefined;
      const a = aptId ? c.db.getAppointment(aptId) : undefined;
      if (!a) {
        c.db.completeEvent(key);
        log(`stripe event ${String(ev["id"])}: no matching appointment`);
        return json(200, { status: "no_matching_appointment" });
      }
      if (obj["payment_status"] !== "paid") {
        c.db.completeEvent(key);
        return json(200, { status: "not_paid_yet" });
      }
      if (a.status === "cancelled" && a.depositStatus !== "paid") {
        a.depositStatus = "paid";
        a.depositPaidAtMs = clock();
        a.stripePaymentIntent = typeof obj["payment_intent"] === "string" ? obj["payment_intent"] : undefined;
        a.history.push({ atMs: clock(), callId: a.callId, action: "deposit_paid" });
        c.db.saveAppointment(a);
        c.db.logTool({ callId: a.callId, atMs: clock(), tool: "stripe", ok: false, outcome: "refund_needed", note: `Deposit ${usd(a.depositUsd)} paid for ${a.code} AFTER it was cancelled: REFUND NEEDED (Stripe test mode).`, appointmentId: a.id });
        if (a.email) {
          const m = appointmentEmail(deps, a, "deposit_after_cancel");
          deps.background?.(
            sendOnce(c.db, c.email, { to: a.email, subject: m.subject, text: m.text, html: m.html, idempotencyKey: `${a.id}:deposit_after_cancel` }, clock()).catch((err: unknown) =>
              log(`refund notice email failed: ${err instanceof Error ? err.message : String(err)}`),
            ),
          );
        }
        if (c.teamEmail) {
          deps.background?.(
            sendOnce(c.db, c.email, { to: c.teamEmail, subject: `REFUND NEEDED: deposit paid for cancelled ${a.code}`, text: `A ${usd(a.depositUsd)} deposit (Stripe test mode, payment ${a.stripePaymentIntent ?? "?"}) was paid for ${a.code}, which was already cancelled. Refund it in Stripe.`, idempotencyKey: `${a.id}:refund_team` }, clock()).catch((err: unknown) =>
              log(`refund team email failed: ${err instanceof Error ? err.message : String(err)}`),
            ),
          );
        }
        c.db.completeEvent(key);
        return json(200, { status: "paid_after_cancel_refund_needed", appointment: a.code });
      }
      if (a.depositStatus !== "paid") {
        a.depositStatus = "paid";
        a.depositPaidAtMs = clock();
        a.stripePaymentIntent = typeof obj["payment_intent"] === "string" ? obj["payment_intent"] : undefined;
        a.history.push({ atMs: clock(), callId: a.callId, action: "deposit_paid" });
        c.db.saveAppointment(a);
        if (a.calendarEventId && a.status === "booked") {
          try {
            await c.calendar.updateEvent(a.calendarEventId, eventForAppointment(deps, a));
          } catch (err) {
            log(`calendar update after deposit failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (a.email) {
          const m = appointmentEmail(deps, a, "deposit_paid");
          deps.background?.(
            sendOnce(c.db, c.email, { to: a.email, subject: m.subject, text: m.text, html: m.html, idempotencyKey: `${a.id}:deposit_paid:` }, clock()).catch((err: unknown) =>
              log(`deposit receipt email failed: ${err instanceof Error ? err.message : String(err)}`),
            ),
          );
        }
        c.db.logTool({ callId: a.callId, atMs: clock(), tool: "stripe", ok: true, outcome: "ok", note: `Deposit ${usd(a.depositUsd)} paid for ${a.code} (Stripe test mode).`, appointmentId: a.id });
      }
      c.db.completeEvent(key);
      return json(200, { status: "deposit_paid", appointment: a.code });
    } catch (err) {
      c.db.releaseEvent(key);
      log(`stripe webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      return json(500, { error: "internal_error" });
    }
  }

  async function pay(token: string): Promise<Res> {
    const b = c.b;
    const id = readPayToken(token, c.linkSecret);
    const a = id ? c.db.getAppointment(id) : undefined;
    if (!a) return page(b, "Link not valid", "<p>This payment link is not valid. Please call us.</p>", 404);
    const when = escapeHtml(spokenDateTime(a.startUtc, b.timezone));
    if (a.status === "cancelled") return page(b, "Appointment cancelled", `<p>The ${escapeHtml(b.agent.visitWord)} on ${when} was cancelled, so no deposit is needed.</p>`);
    if (a.depositStatus === "paid") return page(b, "Deposit already paid", `<p>Thank you, ${escapeHtml(a.customerName)}. Your deposit for ${when} is paid.</p>`);
    if (a.depositStatus !== "due" || !c.stripe) return page(b, "No deposit needed", `<p>There is no deposit to pay for ${when}.</p>`);
    if (a.startUtc < clock()) return page(b, "Appointment passed", "<p>This appointment time has passed.</p>");
    const now = clock();
    if (a.stripeSessionId && a.stripeSessionExpiresMs && a.stripeSessionExpiresMs - now > 10 * 60_000 && a.stripeSessionUrl) {
      return { status: 303, headers: { location: a.stripeSessionUrl, "cache-control": "no-store" }, body: "" };
    }
    try {
      const svc = b.services.find((s) => s.id === a.serviceId);
      const expiresAtSec = Math.floor(now / 1000) + 23 * 3600;
      const session = await c.stripe.client.createCheckout(
        {
          appointmentId: a.id,
          amountUsd: a.depositUsd,
          productName: `Deposit: ${svc?.name ?? "appointment"} on ${spokenDateTime(a.startUtc, b.timezone)} - ${b.name}${b.fictional ? " (demo)" : ""}`.slice(0, 250),
          customerEmail: a.email,
          successUrl: `${deps.publicBaseUrl}/pay/done`,
          cancelUrl: `${deps.publicBaseUrl}/pay/cancelled`,
          expiresAtSec,
        },
        `checkout:${a.id}:${Math.floor(now / 3_600_000)}`,
      );
      // Re-read: a cancel or a payment may have landed while Stripe answered. Change only the session fields.
      const latest = c.db.getAppointment(a.id);
      if (latest) c.db.saveAppointment({ ...latest, stripeSessionId: session.id, stripeSessionUrl: session.url, stripeSessionExpiresMs: session.expiresAtSec * 1000 });
      if (latest && (latest.status === "cancelled" || latest.depositStatus === "paid")) {
        if (latest.status === "cancelled") void deps.expireCheckout?.(session.id).catch(() => {});
        return page(b, latest.status === "cancelled" ? "Appointment cancelled" : "Deposit already paid", latest.status === "cancelled" ? "<p>This appointment was cancelled, so no deposit is needed.</p>" : "<p>Your deposit is already paid. Thank you.</p>");
      }
      return { status: 303, headers: { location: session.url, "cache-control": "no-store" }, body: "" };
    } catch (err) {
      log(`checkout creation failed: ${err instanceof Error ? err.message : String(err)}`);
      return page(b, "Payment page unavailable", "<p>We could not open the payment page just now. Please try again in a few minutes.</p>", 502);
    }
  }

  async function handle(req: Req): Promise<Res> {
    const path = req.url.split("?")[0] ?? "/";
    if (req.body.length > MAX_BODY) return json(413, { error: "too_large" });
    if (req.method === "GET" || req.method === "HEAD") {
      const html = c.sitePages?.[path.endsWith("/") ? path : `${path}/`];
      if (html !== undefined) return { status: 200, headers: { ...HTML_H, "cache-control": "public, max-age=60" }, body: html };
      const asset = c.siteAssets?.[path];
      if (asset) return { status: 200, headers: { "content-type": asset.type, "cache-control": "public, max-age=3600" }, body: "", raw: asset.data };
    }
    if (path === "/healthz") return json(200, { ok: true, business: c.b.slug, calendar: c.calendar.kind, email: c.email.kind, deposits: Boolean(c.stripe), n8n: Boolean(c.n8n) });
    if (path === "/pay/done" && req.method === "GET") return page(c.b, "Deposit received", "<p>Thank you. Your deposit is being confirmed; you will get an email receipt shortly.</p>");
    if (path === "/pay/cancelled" && req.method === "GET") return page(c.b, "Payment not completed", "<p>No payment was taken. You can use the link in your email again at any time.</p>");
    const payMatch = /^\/pay\/([A-Za-z0-9_.]{1,80})$/.exec(path);
    if (payMatch && req.method === "GET") return pay(payMatch[1] as string);
    if (req.method !== "POST") return json(path.startsWith("/tools/") || path.startsWith("/webhooks/") ? 405 : 404, { error: "not_found" });
    const toolMatch = /^\/tools\/([a-z_]{1,40})$/.exec(path);
    if (toolMatch) return toolRoute(req, toolMatch[1] as string);
    if (path === "/webhooks/retell") return retellWebhook(req);
    if (path === "/webhooks/retell-inbound") return inbound(req);
    if (path === "/webhooks/stripe") return stripeWebhook(req);
    if (path === "/vapi") return vapi(req);
    return json(404, { error: "not_found" });
  }

  return {
    deps,
    async handle(req) {
      try {
        const res = await handle(req);
        log(`${req.method} ${redact(req.url)} ${res.status}`);
        return res;
      } catch (err) {
        log(`${req.method} ${redact(req.url)} 500 ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        return json(500, { error: "internal_error" });
      }
    },
    async settle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

export function createHttpServer(app: App): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        res.writeHead(413, JSON_H).end(JSON.stringify({ error: "too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      void app
        .handle({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks) })
        .then((r) => res.writeHead(r.status, r.headers).end(r.raw ?? r.body))
        .catch(() => {
          if (!res.headersSent) res.writeHead(500, JSON_H);
          res.end(JSON.stringify({ error: "internal_error" }));
        });
    });
  });
}
