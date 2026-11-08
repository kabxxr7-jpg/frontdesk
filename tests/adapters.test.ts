import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GoogleCalendar, signServiceAccountJwt } from "../src/calendar.ts";
import { Db } from "../src/db.ts";
import { normalizeSpokenEmail, ResendEmail, sendOnce } from "../src/email.ts";
import { payToken, readPayToken, signStripePayload, verifyStripeSignature } from "../src/stripe.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = { client_email: "fd@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };

describe("Google Calendar adapter", () => {
  it("signs an RS256 JWT the token endpoint can verify", () => {
    const jwt = signServiceAccountJwt(key, 1_800_000_000, "scope-x");
    const [h, c, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toMatchObject({ iss: key.client_email, scope: "scope-x", aud: "https://oauth2.googleapis.com/token", exp: 1_800_003_600 });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("gets a token once, creates events with our marker, ignores our own events and transparent ones as busy", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "evt1" }));
      return new Response(
        JSON.stringify({
          items: [
            { start: { dateTime: "2026-11-09T14:00:00Z" }, end: { dateTime: "2026-11-09T15:00:00Z" } },
            { start: { dateTime: "2026-11-09T16:00:00Z" }, end: { dateTime: "2026-11-09T17:00:00Z" }, extendedProperties: { private: { fd_id: "apt_1" } } },
            { start: { dateTime: "2026-11-09T18:00:00Z" }, end: { dateTime: "2026-11-09T19:00:00Z" }, transparency: "transparent" },
            { start: { date: "2026-11-10" }, end: { date: "2026-11-11" } },
          ],
        }),
      );
    };
    const cal = new GoogleCalendar({ key, calendarId: "abc@group.calendar.google.com", fetch: f, clock: () => 1_800_000_000_000, timeZone: "America/New_York" });
    const id = await cal.createEvent({ appointmentId: "apt_9", summary: "S", description: "D", startUtc: 0, endUtc: 1, timeZone: "America/New_York" });
    expect(id).toBe("evt1");
    const busy = await cal.externalBusy(Date.UTC(2026, 10, 9), Date.UTC(2026, 10, 12));
    expect(busy).toEqual([
      [Date.UTC(2026, 10, 9, 14), Date.UTC(2026, 10, 9, 15)],
      [Date.UTC(2026, 10, 10, 5), Date.UTC(2026, 10, 11, 5)], // all-day: local New York midnight to midnight
    ]);
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
    const post = calls.find((c) => c.init?.method === "POST" && c.url.includes("/events"))!;
    expect(post.url).toContain(encodeURIComponent("abc@group.calendar.google.com"));
    expect(JSON.parse(String(post.init?.body)).extendedProperties.private.fd_id).toBe("apt_9");
  });

  it("a 404 on delete counts as done; a 403 is an error with the status", async () => {
    let status = 404;
    const f = async (url: string) => (url.includes("oauth2") ? new Response(JSON.stringify({ access_token: "t" })) : new Response(JSON.stringify({ error: { message: "x" } }), { status }));
    const cal = new GoogleCalendar({ key, calendarId: "c", fetch: f });
    await expect(cal.deleteEvent("e")).resolves.toBeUndefined();
    status = 403;
    await expect(cal.deleteEvent("e")).rejects.toThrow(/403/);
  });
});

describe("Resend", () => {
  it("sends the documented shape with an idempotency key; sendOnce sends once", async () => {
    const calls: RequestInit[] = [];
    const f = async (_u: string, init?: RequestInit) => {
      calls.push(init as RequestInit);
      return new Response(JSON.stringify({ id: "em_1" }));
    };
    const r = new ResendEmail({ apiKey: "re_test_123", from: "Demo <a@b.test>", fetch: f });
    const db = new Db(":memory:");
    const m = { to: "x@y.test", subject: "s", text: "t", idempotencyKey: "k1" };
    expect(await sendOnce(db, r, m, 1)).toBe("sent");
    expect(await sendOnce(db, r, m, 2)).toBe("already_sent");
    expect(calls).toHaveLength(1);
    const key = (calls[0]!.headers as Record<string, string>)["idempotency-key"];
    expect(key).toMatch(/^k1:[0-9a-f]{24}$/);
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ from: "Demo <a@b.test>", to: ["x@y.test"], subject: "s", text: "t" });
    // A retry of the same email carries the same key; a different email with the same logical key does not
    // (each prospect sample's database starts its ids at apt_00001, and Resend's keys are account-wide).
    await r.send(m);
    await r.send({ ...m, to: "other@y.test", subject: "another business" });
    const keys = calls.map((c) => (c.headers as Record<string, string>)["idempotency-key"]);
    expect(keys[1]).toBe(key);
    expect(keys[2]).not.toBe(key);
    db.close();
  });
  it("an error answer throws with the reason", async () => {
    const r = new ResendEmail({ apiKey: "re_x", from: "a@b.test", fetch: async () => new Response(JSON.stringify({ name: "validation_error", message: "domain not verified" }), { status: 403 }) });
    await expect(r.send({ to: "x@y.test", subject: "s", text: "t", idempotencyKey: "k" })).rejects.toThrow(/domain not verified/);
  });
  it.each([
    ["jane dot doe at gmail dot com", "jane.doe@gmail.com"],
    ["J A N E at example.com", "jane@example.com"],
    ["sam_rivera@Example.org.", "sam_rivera@example.org"],
    ["no email here", null],
  ])("normalizes spoken email %s", (input, out) => expect(normalizeSpokenEmail(input)).toBe(out));
});

describe("Stripe helpers", () => {
  it("pay tokens verify and cannot be altered", () => {
    const t = payToken("apt_00012", "s".repeat(20));
    expect(readPayToken(t, "s".repeat(20))).toBe("apt_00012");
    expect(readPayToken(t.replace("apt_00012", "apt_00013"), "s".repeat(20))).toBe(null);
    expect(readPayToken(t, "t".repeat(20))).toBe(null);
  });
  it("webhook signature: valid, stale, tampered", () => {
    const body = '{"id":"evt_1"}';
    const h = signStripePayload(body, "whsec_a", 1_800_000_000_000);
    expect(verifyStripeSignature(body, h, "whsec_a", 1_800_000_000_000)).toEqual({ ok: true });
    expect(verifyStripeSignature(body, h, "whsec_a", 1_800_000_000_000 + 600_000)).toMatchObject({ ok: false, reason: "stale_timestamp" });
    expect(verifyStripeSignature(body.replace("1", "2"), h, "whsec_a", 1_800_000_000_000)).toMatchObject({ ok: false, reason: "bad_signature" });
  });
});
