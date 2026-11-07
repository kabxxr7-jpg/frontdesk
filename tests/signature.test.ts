import { describe, expect, it } from "vitest";
import { computeDigest, DEFAULT_TOLERANCE_MS, ReplayGuard, signBody, verifyRetellSignature } from "../src/signature.ts";

const KEY = "test-api-key-123";
const TS = 1_730_000_000_000;
const BODY = '{"event":"call_ended","call":{"call_id":"abc"}}';
// Computed independently with Python's hmac module: HMAC-SHA256(key, body + "1730000000000").
const KNOWN_DIGEST = "1bc4e1ec20c6b40d5f87131ba1ed437ed5180025a476db68e8603fbef99f8313";
const KNOWN_DIGEST_UTF8 = "226b49aee68ec41efb30f3c6dbd25375614b746c8c8b28b8dcd9f4a4c9fbd6b9";
const UTF8_BODY = '{"name":"lookup_faq","args":{"question":"héllo"}}';

const verify = (body: string | Buffer, header: string | undefined, now = TS, tol?: number) =>
  verifyRetellSignature(typeof body === "string" ? Buffer.from(body) : body, header, KEY, now, tol);

describe("the digest matches the documented construction (raw body + timestamp text, HMAC-SHA256, hex)", () => {
  it("equals an independently computed value", () => {
    expect(computeDigest(BODY, String(TS), KEY)).toBe(KNOWN_DIGEST);
    expect(computeDigest(UTF8_BODY, String(TS), KEY)).toBe(KNOWN_DIGEST_UTF8);
    expect(signBody(BODY, KEY, TS)).toBe(`v=${TS},d=${KNOWN_DIGEST}`);
  });

  it("hashes bytes, not characters: bytes that are not valid UTF-8 still verify", () => {
    const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    const header = signBody(bytes, KEY, TS);
    expect(verify(bytes, header).ok).toBe(true);
    expect(verify(Buffer.from([0x7b, 0xff, 0xfd, 0x7d]), header)).toEqual({ ok: false, reason: "bad_digest" });
  });
});

describe("verifyRetellSignature", () => {
  const good = `v=${TS},d=${KNOWN_DIGEST}`;

  it("accepts a correct signature and returns the timestamp and digest", () => {
    expect(verify(BODY, good)).toEqual({ ok: true, timestampMs: TS, digest: KNOWN_DIGEST });
  });

  it("accepts an upper-case hex digest", () => {
    expect(verify(BODY, `v=${TS},d=${KNOWN_DIGEST.toUpperCase()}`).ok).toBe(true);
  });

  it("rejects a different key", () => {
    expect(verifyRetellSignature(Buffer.from(BODY), good, "another-key-123", TS)).toEqual({ ok: false, reason: "bad_digest" });
  });

  it("rejects a body changed by a single byte", () => {
    expect(verify(BODY.replace("abc", "abd"), good)).toEqual({ ok: false, reason: "bad_digest" });
  });

  it("rejects a re-serialised body: the signature covers the exact bytes that were sent", () => {
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verify(reserialised, good)).toEqual({ ok: false, reason: "bad_digest" });
    const spaced = '{"event": "call_ended", "call": {"call_id": "abc"}}';
    const header = signBody(spaced, KEY, TS);
    expect(verify(spaced, header).ok).toBe(true);
    expect(verify(BODY, header).ok).toBe(false);
  });

  it("the timestamp is part of what is signed: swapping it breaks the signature", () => {
    expect(verify(BODY, `v=${TS + 1},d=${KNOWN_DIGEST}`)).toEqual({ ok: false, reason: "bad_digest" });
  });

  it("known property of the documented scheme: body and timestamp are concatenated with no delimiter", () => {
    // Moving trailing digits between the body and the timestamp text gives the same signed string, so the same
    // digest. The docs define the scheme this way and the kit follows them exactly. It cannot be abused here,
    // because every body this server accepts is a JSON object, which ends in "}" and never in digits.
    const header = signBody(`${BODY}1`, KEY, 730_000_000_000);
    expect(verify(BODY, header.replace("v=730000000000", "v=1730000000000")).ok).toBe(true);
    expect(() => JSON.parse(`${BODY}1`)).toThrow();
    expect(BODY.endsWith("}")).toBe(true);
  });

  const malformed: [string, string | undefined][] = [
    ["missing", undefined],
    ["empty", ""],
    ["no version", `d=${KNOWN_DIGEST}`],
    ["no digest", `v=${TS}`],
    ["swapped order", `d=${KNOWN_DIGEST},v=${TS}`],
    ["digest too short", `v=${TS},d=${KNOWN_DIGEST.slice(0, 63)}`],
    ["digest too long", `v=${TS},d=${KNOWN_DIGEST}0`],
    ["digest not hex", `v=${TS},d=${"z".repeat(64)}`],
    ["negative timestamp", `v=-${TS},d=${KNOWN_DIGEST}`],
    ["timestamp with decimals", `v=${TS}.5,d=${KNOWN_DIGEST}`],
    ["timestamp in words", `v=now,d=${KNOWN_DIGEST}`],
    ["a scheme prefix", `sha256=${KNOWN_DIGEST}`],
    ["extra fields", `v=${TS},d=${KNOWN_DIGEST},x=1`],
    ["a very long timestamp", `v=${"9".repeat(40)},d=${KNOWN_DIGEST}`],
  ];
  it.each(malformed)("rejects a %s header", (_name, header) => {
    const r = verify(BODY, header);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["missing_header", "malformed_header"]).toContain(r.reason);
  });

  it("tolerates whitespace around the header value but not inside it", () => {
    expect(verify(BODY, `  ${good}  `).ok).toBe(true);
    expect(verify(BODY, `v=${TS}, d=${KNOWN_DIGEST}`).ok).toBe(false);
  });
});

describe("freshness: 5 minutes either way", () => {
  const header = `v=${TS},d=${KNOWN_DIGEST}`;
  it("is fresh at exactly 5 minutes, stale one millisecond later, in both directions", () => {
    expect(DEFAULT_TOLERANCE_MS).toBe(300_000);
    expect(verify(BODY, header, TS + 300_000).ok).toBe(true);
    expect(verify(BODY, header, TS + 300_001)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(verify(BODY, header, TS - 300_000).ok).toBe(true);
    expect(verify(BODY, header, TS - 300_001)).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("a stale request with a WRONG digest is reported as a bad digest, not as stale (nothing is revealed to a forger)", () => {
    expect(verify(BODY, `v=${TS},d=${"0".repeat(64)}`, TS + 10_000_000)).toEqual({ ok: false, reason: "bad_digest" });
  });

  it("honours a custom tolerance", () => {
    expect(verify(BODY, header, TS + 1_001, 1_000)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(verify(BODY, header, TS + 1_000, 1_000).ok).toBe(true);
  });

  it("treats a timestamp in seconds (a likely integration mistake) as stale", () => {
    const seconds = Math.floor(TS / 1000);
    expect(verify(BODY, signBody(BODY, KEY, seconds))).toEqual({ ok: false, reason: "stale_timestamp" });
  });
});

describe("ReplayGuard", () => {
  it("remembers a digest until its signature could no longer be fresh", () => {
    const g = new ReplayGuard();
    expect(g.check("d1", 0)).toEqual({ kind: "new" });
    g.remember("d1", 0);
    expect(g.check("d1", 1)).toEqual({ kind: "replay" });
    // ttl = 2 * tolerance + 1 s
    expect(g.check("d1", 600_999)).toEqual({ kind: "replay" });
    expect(g.check("d1", 601_000)).toEqual({ kind: "new" });
    expect(g.size).toBe(0);
  });

  it("returns the cached response when one was stored", () => {
    const g = new ReplayGuard();
    g.remember("d1", 0, { status: 200, body: '{"ok":true}' });
    expect(g.check("d1", 5)).toEqual({ kind: "replay", cached: { status: 200, body: '{"ok":true}' } });
  });

  it("never grows past its cap: the oldest entry is dropped", () => {
    const g = new ReplayGuard({ maxEntries: 3 });
    for (let i = 0; i < 5; i += 1) g.remember(`d${i}`, i);
    expect(g.size).toBe(3);
    expect(g.check("d0", 10).kind).toBe("new");
    expect(g.check("d1", 10).kind).toBe("new");
    expect(g.check("d4", 10).kind).toBe("replay");
  });

  it("distinct digests do not interfere", () => {
    const g = new ReplayGuard();
    g.remember("a", 0);
    expect(g.check("b", 0).kind).toBe("new");
  });
});
