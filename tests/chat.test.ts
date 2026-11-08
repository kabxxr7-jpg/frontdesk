import { describe, expect, it } from "vitest";
import { loadBusiness } from "../src/business.ts";
import { MemoryCalendar } from "../src/calendar.ts";
import { Chat, ChatLimits, GeminiModel, buildChatPrompt, chatText, clientIp, type ChatModel, type Content, type ModelRequest, type ModelReply, type Part } from "../src/chat.ts";
import { Db } from "../src/db.ts";
import { MemoryEmail } from "../src/email.ts";
import { createApp, createRouter, type Tenant } from "../src/server.ts";
import { buildSite } from "../src/site.ts";
import { DENTAL_DIR, LINK, rig, type Rig } from "./helpers.ts";

/** A scripted model: each step looks at the conversation so far and returns the model's next turn. */
class FakeModel implements ChatModel {
  readonly name = "fake";
  readonly requests: ModelRequest[] = [];
  steps: ((contents: Content[]) => Part[] | Error)[] = [];
  tokens = { in: 1000, out: 100 };
  async generate(req: ModelRequest): Promise<ModelReply> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error("FakeModel: no step left");
    const parts = step(req.contents);
    if (parts instanceof Error) throw parts;
    return { content: { role: "model", parts }, inputTokens: this.tokens.in, outputTokens: this.tokens.out };
  }
}

const call = (name: string, args: Record<string, unknown>): Part[] => [{ functionCall: { name, args } }];
const say = (text: string): Part[] => [{ text }];
/** The last tool result the model was given. */
function lastResult(contents: Content[]): Record<string, unknown> {
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const fr = contents[i]?.parts.find((p) => p.functionResponse)?.functionResponse;
    if (fr) return fr.response;
  }
  throw new Error("no tool result yet");
}

function chatRig(limits = new ChatLimits(), extra: { allowedOrigins?: string[]; maxMessagesPerSession?: number } = {}): Rig & { model: FakeModel; send(message: unknown, o?: { session?: string; ip?: string; origin?: string; contentType?: string; raw?: string }): Promise<{ status: number; body: Record<string, unknown> }> } {
  const model = new FakeModel();
  const r = rig({ chat: { model, limits, ...extra } });
  return {
    ...r,
    model,
    async send(message, o = {}) {
      const raw = o.raw ?? JSON.stringify(o.session ? { session_id: o.session, message } : { message });
      const headers: Record<string, string> = { "content-type": o.contentType ?? "application/json", "cf-connecting-ip": o.ip ?? "203.0.113.7" };
      if (o.origin) headers["origin"] = o.origin;
      const res = await r.app.handle({ method: "POST", url: "/chat", headers, body: Buffer.from(raw) });
      return { status: res.status, body: JSON.parse(res.body) as Record<string, unknown> };
    },
  };
}

describe("website chat", () => {
  it("books through the same tools: availability, booking, calendar event, confirmation email", async () => {
    const c = chatRig();
    c.model.steps = [
      () => call("get_availability", { service: "cleaning", date_from: "2026-11-09", date_to: "2026-11-09" }),
      (ct) => {
        const slots = lastResult(ct)["slots"] as { start: string; spoken: string }[];
        return say(`I have ${slots[0]?.spoken} or ${slots[1]?.spoken}. Which works?`);
      },
    ];
    const first = await c.send("Can I get a cleaning on Monday?", { origin: "https://desk.test" });
    expect(first.status).toBe(200);
    expect(String(first.body["reply"])).toContain("Monday, November 9th at 8:00 AM");
    const session = String(first.body["session_id"]);
    expect(session).toMatch(/^[A-Za-z0-9_-]{16,40}$/);

    c.model.steps = [
      (ct) => {
        // the model sees the whole conversation, including the earlier tool result
        expect(ct.some((x) => x.parts.some((p) => p.functionResponse?.name === "get_availability"))).toBe(true);
        return call("book_appointment", { service: "cleaning", start: "2026-11-09T08:00", customer_name: "Jordan Lake", phone: "201-555-0177", email: "jordan@example.com" });
      },
      (ct) => say(String(lastResult(ct)["message"])),
    ];
    const second = await c.send("8 AM please. Jordan Lake, 201-555-0177, jordan@example.com", { session });
    expect(second.status).toBe(200);
    const booked = second.body["booked"] as Record<string, unknown>;
    expect(booked["code"]).toMatch(/^[A-Z0-9]{4}$/);
    // The spoken "K-7-Q-M" reads as "K7QM" in text.
    expect(String(second.body["reply"])).toContain(`Your confirmation code is ${String(booked["code"])}.`);

    const appts = c.db.allAppointments();
    expect(appts).toHaveLength(1);
    expect(appts[0]).toMatchObject({ callId: Chat.callId(session), customerName: "Jordan Lake", phone: "+12015550177", email: "jordan@example.com", status: "booked", calendarStatus: "synced" });
    expect([...c.cal.events.values()][0]?.summary).toContain("Cleaning and checkup: Jordan Lake");
    await c.app.settle();
    expect(c.mail.sent.map((m) => [m.to, m.subject])).toEqual([["jordan@example.com", "Brightside Family Dental: your appointment on Monday, November 9th at 8:00 AM"]]);
    expect(c.db.toolLogFor(Chat.callId(session)).map((l) => l.tool)).toEqual(["get_availability", "book_appointment", "email"]);

    // Cancel by code, same tools.
    c.model.steps = [() => call("cancel_appointment", { code: String(booked["code"]) }), (ct) => say(String(lastResult(ct)["message"]))];
    const third = await c.send(`Cancel ${String(booked["code"])}`, { session });
    expect(String(third.body["reply"])).toContain("is cancelled");
    expect(c.db.allAppointments()[0]?.status).toBe("cancelled");
    expect(c.cal.events.size).toBe(0);
  });

  it("answers questions from the business's own facts (FAQ tool) and sends the chat prompt", async () => {
    const c = chatRig();
    c.model.steps = [() => call("lookup_faq", { question: "Do you take Delta Dental?" }), (ct) => say(String(lastResult(ct)["message"]))];
    const r = await c.send("Do you take Delta Dental?");
    expect(r.status).toBe(200);
    const faq = lastResult(c.model.requests[1]?.contents ?? []);
    expect(faq["ok"]).toBe(true);
    expect(faq["matched"]).not.toBeNull();
    expect(r.body["reply"]).toBe(chatText(String(faq["message"])));
    const req = c.model.requests[0] as ModelRequest;
    expect(req.tools.map((t) => t.name)).toEqual(["lookup_faq", "get_availability", "book_appointment", "reschedule_appointment", "cancel_appointment", "request_transfer"]);
    expect(req.system).toContain("text chat on the website");
    expect(req.system).toContain("Saturday, November 7th at 9:00 AM");
    expect(req.system).toContain("Monday, November 9th = 2026-11-09");
  });

  it("routes an emergency straight to the urgent rules, without the model", async () => {
    const c = chatRig();
    const r = await c.send("My son's tooth got knocked out playing football");
    expect(r.status).toBe(200);
    expect(c.model.requests).toHaveLength(0);
    expect(String(r.body["reply"])).toContain("flagged this chat as urgent");
    const logged = c.db.toolLogFor(Chat.callId(String(r.body["session_id"])));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ tool: "request_transfer", urgentLabel: "emergency" });
  });

  it("never tells the model to transfer a chat, even when transfers are live", async () => {
    const model = new FakeModel();
    const r = rig({ chat: { model, limits: new ChatLimits() }, transfersLive: true });
    model.steps = [() => call("request_transfer", { reason: "I want to talk to a person" }), (ct) => say(String(lastResult(ct)["message"]))];
    r.now.ms = Date.UTC(2026, 10, 9, 15); // Monday 10 AM, open
    await r.app.handle({ method: "POST", url: "/chat", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ message: "Can I talk to a person?" })) });
    const out = lastResult(model.requests[1]?.contents ?? []);
    expect(out["transfer"]).toBe(false);
    expect(String(out["instruction"])).toContain("cannot transfer");
  });

  it("rate limits per IP, per session and per day, before calling the model", async () => {
    const c = chatRig(new ChatLimits({ perIp10Min: 2, perIpDay: 3 }));
    c.model.steps = Array.from({ length: 10 }, () => () => say("Hi!"));
    expect((await c.send("hi", { ip: "198.51.100.1" })).status).toBe(200);
    expect((await c.send("hi", { ip: "198.51.100.1" })).status).toBe(200);
    const third = await c.send("hi", { ip: "198.51.100.1" });
    expect(third.status).toBe(429);
    expect(third.body["error"]).toBe("rate_limited");
    expect((await c.send("hi", { ip: "198.51.100.2" })).status).toBe(200);
    c.now.ms += 11 * 60_000;
    expect((await c.send("hi", { ip: "198.51.100.1" })).status).toBe(200);
    expect((await c.send("hi", { ip: "198.51.100.1" })).body["error"]).toBe("rate_limited"); // 3 a day
    expect(c.model.requests).toHaveLength(4);

    const s = chatRig(new ChatLimits(), { maxMessagesPerSession: 2 });
    s.model.steps = Array.from({ length: 5 }, () => () => say("Sure."));
    const a = await s.send("one");
    const session = String(a.body["session_id"]);
    await s.send("two", { session });
    const over = await s.send("three", { session });
    expect(over).toMatchObject({ status: 429, body: { error: "session_limit", ended: true } });
  });

  it("stops for the day at the spend cap, shared by every front desk on the server", async () => {
    const limits = new ChatLimits({ dailyUsd: 0.001 });
    const c = chatRig(limits);
    c.model.tokens = { in: 3000, out: 200 }; // 0.0009 + 0.0005 USD
    c.model.steps = [() => say("Hello!"), () => say("unused")];
    expect((await c.send("hi")).status).toBe(200);
    const capped = await c.send("hi again", { ip: "192.0.2.9" });
    expect(capped).toMatchObject({ status: 429, body: { error: "daily_cap" } });
    expect(c.model.requests).toHaveLength(1);
    // A second front desk sharing the limits is capped too; the next day it opens again.
    const other = chatRig(limits);
    other.model.steps = [() => say("Hello!")];
    expect((await other.send("hi")).body["error"]).toBe("daily_cap");
    expect(limits.take("192.0.2.9", Date.UTC(2026, 10, 8, 12))).toBe("ok");
  });

  it("refuses oversized, empty, non-JSON and cross-site messages", async () => {
    const c = chatRig();
    const long = await c.send("x".repeat(501));
    expect(long).toMatchObject({ status: 413, body: { error: "message_too_long" } });
    expect((await c.send("", {})).status).toBe(400);
    expect((await c.send(42)).status).toBe(400);
    expect((await c.send("hi", { raw: JSON.stringify({ message: "y".repeat(5000) }) })).status).toBe(413);
    expect((await c.send("hi", { contentType: "text/plain" })).status).toBe(415);
    expect((await c.send("hi", { origin: "https://evil.example" })).status).toBe(403);
    expect(c.model.requests).toHaveLength(0);
    // The page's own origin, and extra ones from config, are fine.
    const o = chatRig(new ChatLimits(), { allowedOrigins: ["http://localhost:8090"] });
    o.model.steps = [() => say("Hi"), () => say("Hi")];
    expect((await o.send("hi", { origin: "https://desk.test" })).status).toBe(200);
    expect((await o.send("hi", { origin: "http://localhost:8090" })).status).toBe(200);
  });

  it("never books a different time on its own after the wanted time was refused", async () => {
    const c = chatRig();
    c.model.steps = [
      () => call("book_appointment", { service: "cleaning", start: "2026-11-08T08:00", customer_name: "Jordan Lake", phone: "2015550177" }), // Sunday: closed
      (ct) => {
        const alts = lastResult(ct)["alternatives"] as { start: string }[];
        return call("book_appointment", { service: "cleaning", start: alts[0]?.start, customer_name: "Jordan Lake", phone: "2015550177" });
      },
      (ct) => say(String(lastResult(ct)["message"])),
    ];
    const r = await c.send("Book me Sunday 8 AM, Jordan Lake, 2015550177");
    expect(lastResult(c.model.requests[2]?.contents ?? [])).toMatchObject({ ok: false, error: "ask_visitor_first" });
    expect(c.db.allAppointments()).toHaveLength(0);
    expect(r.body["booked"]).toBeUndefined();
  });

  it("survives a tool that throws: the model is told nothing changed, and no booking is made", async () => {
    const c = chatRig();
    c.db.saveAppointment = () => {
      throw new Error("disk I/O error");
    };
    c.model.steps = [() => call("book_appointment", { service: "cleaning", start: "2026-11-09T08:00", customer_name: "Jordan Lake", phone: "2015550177" }), (ct) => say(String(lastResult(ct)["message"]))];
    const r = await c.send("Book me Monday 8 AM, Jordan Lake, 2015550177");
    expect(r.status).toBe(200);
    expect(lastResult(c.model.requests[1]?.contents ?? [])).toMatchObject({ ok: false, error: "tool_failed" });
    expect(String(r.body["reply"])).toContain("nothing was changed");
    expect(r.body["booked"]).toBeUndefined();
  });

  it("answers 502 when the model fails, and forgets the half-finished turn", async () => {
    const c = chatRig();
    c.model.steps = [() => say("Hello! How can I help?")];
    const a = await c.send("hi");
    const session = String(a.body["session_id"]);
    c.model.steps = [() => new Error("gemini 503: overloaded")];
    const b = await c.send("are you there?", { session });
    expect(b).toMatchObject({ status: 502, body: { error: "model_unavailable" } });
    c.model.steps = [(ct) => {
      expect(ct.map((x) => x.role)).toEqual(["user", "model", "user"]);
      return say("Yes!");
    }];
    expect((await c.send("hello?", { session })).body["reply"]).toBe("Yes!");
  });

  it("stops a model that keeps calling tools, and refuses tools it does not have", async () => {
    const c = chatRig();
    c.model.steps = Array.from({ length: 5 }, () => () => call("transfer_to_front_desk", {}));
    const r = await c.send("hi");
    expect(r.status).toBe(502);
    expect(lastResult(c.model.requests[1]?.contents ?? [])).toMatchObject({ ok: false, error: "unknown_tool" });
    expect(c.model.requests).toHaveLength(5);
  });

  it("works for a prospect sample under /t/<slug>/chat, with its own sessions", async () => {
    const model = new FakeModel();
    const limits = new ChatLimits();
    const b = loadBusiness(DENTAL_DIR);
    const mk = (base: string) => createApp({ b, db: new Db(":memory:"), calendar: new MemoryCalendar(), email: new MemoryEmail(), vapiSecret: "v".repeat(32), publicBaseUrl: base, linkSecret: LINK, chat: { model, limits } });
    const tenants = new Map<string, Tenant>([["sample-x1", { app: mk("https://desk.test/t/sample-x1"), expiresAt: "2099-01-01" }]]);
    const router = createRouter(mk("https://desk.test"), tenants);
    model.steps = [() => say("Hi from the sample")];
    const res = await router.handle({ method: "POST", url: "/t/sample-x1/chat", headers: { "content-type": "application/json", origin: "https://desk.test" }, body: Buffer.from(JSON.stringify({ message: "hello" })) });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)["reply"]).toBe("Hi from the sample");
    // Without chat configured the route is off.
    const off = rig();
    expect((await off.app.handle({ method: "POST", url: "/chat", headers: { "content-type": "application/json" }, body: Buffer.from('{"message":"hi"}') })).status).toBe(404);
  });
});

describe("gemini client", () => {
  it("sends the key in a header only, with tools and system prompt, and reads function calls and usage", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const m = new GeminiModel({
      apiKey: "test-key-123",
      model: "gemini-flash-latest",
      fetch: async (url, init) => {
        seen.push({ url, ...(init ? { init } : {}) });
        return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "lookup_faq", args: { question: "hours" } }, thoughtSignature: "sig" }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 20, thoughtsTokenCount: 30 } }));
      },
    });
    const r = await m.generate({ system: "SYS", contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ name: "lookup_faq", description: "d", parameters: { type: "object", properties: {} } }] });
    expect(seen[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent");
    expect((seen[0]?.init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key-123");
    const body = String(seen[0]?.init?.body);
    expect(body).not.toContain("test-key-123");
    expect(JSON.parse(body)).toMatchObject({ systemInstruction: { parts: [{ text: "SYS" }] }, tools: [{ functionDeclarations: [{ name: "lookup_faq" }] }] });
    // Parts come back as they were (the thought signature must be sent back on the next turn).
    expect(r).toEqual({ content: { role: "model", parts: [{ functionCall: { name: "lookup_faq", args: { question: "hours" } }, thoughtSignature: "sig" }] }, inputTokens: 900, outputTokens: 50 });
  });

  it("throws on an API error or an empty answer", async () => {
    const m = (status: number, body: unknown) => new GeminiModel({ apiKey: "k", fallbacks: [], sleep: async () => {}, fetch: async () => new Response(JSON.stringify(body), { status }) });
    await expect(m(429, { error: { message: "quota" } }).generate({ system: "", contents: [], tools: [] })).rejects.toThrow("429");
    await expect(m(400, { error: { message: "bad" } }).generate({ system: "", contents: [], tools: [] })).rejects.toThrow("400");
    await expect(m(200, { candidates: [{ finishReason: "SAFETY" }] }).generate({ system: "", contents: [], tools: [] })).rejects.toThrow("SAFETY");
    expect(() => new GeminiModel({ apiKey: "" })).toThrow();
  });
});

describe("gemini client when the model is busy", () => {
  const ok = { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] };
  it("retries a 503 once, then falls back to the next model; a 400 is not retried", async () => {
    const urls: string[] = [];
    const replies = [503, 503, 200];
    const sleeps: number[] = [];
    const m = new GeminiModel({
      apiKey: "k", model: "gemini-flash-latest", fallbacks: ["gemini-3.5-flash-lite"], backoffMs: 5, sleep: async (ms) => { sleeps.push(ms); },
      fetch: async (url) => {
        urls.push(url.replace(/^.*models\//, "").replace(/:generateContent$/, ""));
        const s = replies.shift() ?? 200;
        return new Response(JSON.stringify(s === 200 ? ok : { error: { message: "busy" } }), { status: s });
      },
    });
    const r = await m.generate({ system: "", contents: [], tools: [] });
    expect(r.content.parts[0]?.text).toBe("Hi");
    expect(urls).toEqual(["gemini-flash-latest", "gemini-flash-latest", "gemini-3.5-flash-lite"]);
    expect(sleeps).toEqual([5]);
    expect(m.lastModel).toBe("gemini-3.5-flash-lite");

    let calls = 0;
    const bad = new GeminiModel({ apiKey: "k", sleep: async () => {}, fetch: async () => { calls += 1; return new Response("{}", { status: 400 }); } });
    await expect(bad.generate({ system: "", contents: [], tools: [] })).rejects.toThrow("400");
    expect(calls).toBe(1);
    // A network failure counts as busy.
    let n = 0;
    const flaky = new GeminiModel({ apiKey: "k", sleep: async () => {}, fetch: async () => { n += 1; if (n === 1) throw new Error("ECONNRESET"); return new Response(JSON.stringify(ok)); } });
    expect((await flaky.generate({ system: "", contents: [], tools: [] })).content.parts[0]?.text).toBe("Hi");
  });
});

describe("chat page and helpers", () => {
  const b = loadBusiness(DENTAL_DIR);
  it("puts the widget on the page only when chat is on, with the right endpoint and no secrets", () => {
    const on = buildSite(b, { depositsOn: false, crmOn: false, chat: { endpoint: "/t/sample-x1/chat" } });
    expect(on).toContain('"endpoint":"/t/sample-x1/chat"');
    expect(on).toContain("Chat with Ava");
    expect(on).toContain("data-chat-open");
    expect(on).toContain("Do you take Delta Dental?");
    expect(on).not.toMatch(/GEMINI|x-goog-api-key|AIza/);
    const off = buildSite(b, { depositsOn: false, crmOn: false });
    expect(off).not.toContain("fdc-panel");
    // A hostile business name cannot break out of the inline script.
    const evil = buildSite({ ...b, name: "</script><img src=x onerror=alert(1)>" }, { depositsOn: false, crmOn: false, chat: { endpoint: "/chat" } });
    expect(evil).not.toContain("</script><img");
  });

  it("reads the visitor's IP from Cloudflare, and tidies spoken text for chat", () => {
    expect(clientIp({ "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "1.1.1.1" })).toBe("203.0.113.5");
    expect(clientIp({ "x-forwarded-for": "198.51.100.3, 10.0.0.1" })).toBe("198.51.100.3");
    expect(clientIp({})).toBe("local");
    expect(chatText("Your code is K-7-Q-M. **Thanks**")).toBe("Your code is K7QM. Thanks");
    expect(chatText("Please hang up and call 911. This is a demonstration line, so I have flagged the call.")).toBe("Please call 911. This is a demonstration, so I have flagged this chat.");
  });

  it("builds a chat prompt that keeps the voice facts and adds the text rules", () => {
    const d = rig().app.deps;
    const p = buildChatPrompt(d, Date.UTC(2026, 10, 7, 14));
    expect(p).toContain("You are Ava");
    expect(p).toContain("Looking up by phone number does not work in chat");
    expect(p).toContain("(201) 555-0100");
  });
});
