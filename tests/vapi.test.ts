import { afterEach, describe, expect, it } from "vitest";
import { loadBusiness } from "../src/business.ts";
import { MemoryCalendar } from "../src/calendar.ts";
import { Db } from "../src/db.ts";
import { MemoryEmail } from "../src/email.ts";
import { createApp } from "../src/server.ts";
import { buildVapiAssistant } from "../src/vapi.ts";
import { DENTAL_DIR, LINK, rig, SAT_9AM, type Rig } from "./helpers.ts";

const SECRET = "vapi-secret-0123456789abcdef0123";
let r: Rig | undefined;
afterEach(() => {
  r?.app.close();
  r?.db.close();
  r = undefined;
});

const call = { id: "3f1c2a9e-0000-4000-8000-000000000001", type: "inboundPhoneCall", customer: { number: "+12015551234" }, phoneNumber: { number: "+12015550000" } };
const toolMsg = (list: unknown[]) => ({ message: { type: "tool-calls", call, toolCallList: list } });
const BOOK = { service: "new_patient_visit", start: "2026-11-10T09:00", customer_name: "Ann Lee", email: "ann@example.com" };

async function vapi(rr: Rig, body: unknown, headers: Record<string, string> = { "x-frontdesk-token": SECRET }, url = "/vapi") {
  return rr.post(url, body, { sign: false, headers });
}

describe("Vapi adapter", () => {
  it("refuses requests without the shared secret", async () => {
    r = rig({ vapiSecret: SECRET });
    expect((await vapi(r, toolMsg([]), {})).status).toBe(401);
    expect((await vapi(r, toolMsg([]), { "x-frontdesk-token": "wrong-secret-0123456789abcdef01" })).status).toBe(401);
    expect(r.db.allAppointments()).toHaveLength(0);
  });

  it("books through a tool call and answers in Vapi's results format", async () => {
    r = rig({ vapiSecret: SECRET });
    const res = await vapi(r, toolMsg([{ id: "tc_1", type: "function", function: { name: "book_appointment", arguments: BOOK } }]));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { results: { toolCallId: string; result: string }[] };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.toolCallId).toBe("tc_1");
    const out = JSON.parse(body.results[0]!.result) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    const a = r.db.allAppointments()[0]!;
    expect(a.callId).toBe(call.id);
    expect(a.phone).toBe("+12015551234");
    await r.app.settle();
    expect(r.mail.sent.map((m) => m.to)).toContain("ann@example.com");
  });

  it("accepts arguments as a JSON string, several calls in one message, the token as a query or bearer", async () => {
    r = rig({ vapiSecret: SECRET });
    const res = await vapi(
      r,
      toolMsg([
        { id: "a", function: { name: "lookup_faq", arguments: JSON.stringify({ question: "Are you open on Saturday?" }) } },
        { id: "b", function: { name: "no_such_tool", arguments: {} } },
      ]),
      {},
      `/vapi?token=${SECRET}`,
    );
    const results = (JSON.parse(res.body) as { results: { toolCallId: string; result: string }[] }).results;
    expect(results.map((x) => x.toolCallId)).toEqual(["a", "b"]);
    expect(JSON.parse(results[0]!.result)["ok"]).toBe(true);
    expect(JSON.parse(results[1]!.result)["error"]).toBe("unknown_tool");
    expect((await vapi(r, toolMsg([]), { authorization: `Bearer ${SECRET}` })).status).toBe(200);
  });

  it("an end-of-call report sends one summary to the team", async () => {
    r = rig({ vapiSecret: SECRET });
    await vapi(r, toolMsg([{ id: "tc_1", function: { name: "book_appointment", arguments: BOOK } }]));
    const report = { message: { type: "end-of-call-report", call, endedReason: "customer-ended-call", startedAt: new Date(SAT_9AM).toISOString(), endedAt: new Date(SAT_9AM + 95_000).toISOString(), analysis: { summary: "Ann booked a new patient visit." }, recordingUrl: "https://storage.vapi.ai/rec.wav" } };
    const first = await vapi(r, report);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)["status"]).toMatch(/^summary_sent/);
    const again = await vapi(r, report);
    expect(JSON.parse(again.body)["status"]).toBe("duplicate");
    await r.app.settle();
    const team = r.mail.sent.filter((m) => m.to === "team@desk.test");
    expect(team).toHaveLength(1);
    expect(team[0]!.text).toContain("booked");
  });

  it("other server messages are acknowledged and ignored", async () => {
    r = rig({ vapiSecret: SECRET });
    const res = await vapi(r, { message: { type: "status-update", status: "in-progress", call } });
    expect(res.status).toBe(200);
  });

  it("runs with Vapi only: Retell routes are closed", async () => {
    const db = new Db(":memory:");
    const app = createApp({ b: loadBusiness(DENTAL_DIR), db, calendar: new MemoryCalendar(), email: new MemoryEmail(), vapiSecret: SECRET, publicBaseUrl: "https://desk.test", linkSecret: LINK, clock: () => SAT_9AM });
    const res = await app.handle({ method: "POST", url: "/tools/lookup_faq", headers: {}, body: Buffer.from("{}") });
    expect(res.status).toBe(404);
    db.close();
    expect(() => createApp({ b: loadBusiness(DENTAL_DIR), db: new Db(":memory:"), calendar: new MemoryCalendar(), email: new MemoryEmail(), publicBaseUrl: "https://desk.test", linkSecret: LINK })).toThrow();
  });

  it("serves the demo pages it was given, and nothing else, on GET", async () => {
    const db = new Db(":memory:");
    const app = createApp({ b: loadBusiness(DENTAL_DIR), db, calendar: new MemoryCalendar(), email: new MemoryEmail(), vapiSecret: SECRET, publicBaseUrl: "https://desk.test", linkSecret: LINK, sitePages: { "/": "<p>home</p>", "/demos/rapid-rooter-plumbing/": "<p>plumber</p>" } });
    const get = (url: string) => app.handle({ method: "GET", url, headers: {}, body: Buffer.alloc(0) });
    expect((await get("/")).body).toBe("<p>home</p>");
    expect((await get("/demos/rapid-rooter-plumbing")).body).toBe("<p>plumber</p>");
    expect((await get("/demos/rapid-rooter-plumbing/")).headers["content-type"]).toContain("text/html");
    expect((await get("/.env")).status).toBe(404);
    expect((await get("/healthz")).status).toBe(200);
    app.close();
    db.close();
  });

  it("the assistant config carries the secret header, the tools and Vapi's time variable", () => {
    const a = buildVapiAssistant(loadBusiness(DENTAL_DIR), { serverUrl: "https://desk.test/vapi", secret: SECRET, maxCallSeconds: 300 });
    const s = JSON.stringify(a);
    expect(s).not.toContain("current_time_");
    expect(s).not.toContain("{{user_number}}");
    expect(a.model.messages[0]!.content).toContain('{{"now" | date:');
    expect(a.model.tools.filter((t) => t.type === "function")).toHaveLength(6);
    expect(a.server.headers["x-frontdesk-token"]).toBe(SECRET);
    expect(a.maxDurationSeconds).toBe(300);
    expect(a.artifactPlan.recordingEnabled).toBe(false);
  });
});
