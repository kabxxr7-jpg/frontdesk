// Retell request signature, implemented from https://docs.retellai.com/features/secure-webhook (read 2026-11-01):
//
//   header   X-Retell-Signature: v={timestamp_ms},d={hex_digest}
//   digest   HMAC-SHA256 over (raw request body bytes + the timestamp text), key = the Retell API key
//   fresh    reject when the timestamp is more than 5 minutes from now
//   compare  in constant time, on the raw bytes (never on a re-serialised body)
//
// The docs show this scheme for webhooks. For custom-function (tool) calls they only say the header is an HMAC of
// the body; this kit applies the same scheme there (docs/SOURCES.md, "Not confirmed" item 1).
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-retell-signature";
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

const HEADER_PATTERN = /^v=(\d{1,16}),d=([0-9a-fA-F]{64})$/;

export type SignatureFailure = "missing_header" | "malformed_header" | "bad_digest" | "stale_timestamp";
export type SignatureCheck =
  | { ok: true; timestampMs: number; digest: string }
  | { ok: false; reason: SignatureFailure };

/** The hex digest for a body and timestamp. `timestamp` is the text exactly as it appears in the header. */
export function computeDigest(rawBody: Uint8Array | string, timestamp: string, apiKey: string): string {
  const hmac = createHmac("sha256", apiKey);
  hmac.update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody);
  hmac.update(timestamp, "utf8");
  return hmac.digest("hex");
}

/** Builds a header the way the platform does. Used by the simulator and the tests, never by the server. */
export function signBody(rawBody: Uint8Array | string, apiKey: string, timestampMs: number): string {
  const ts = String(timestampMs);
  return `v=${ts},d=${computeDigest(rawBody, ts, apiKey)}`;
}

export function verifyRetellSignature(
  rawBody: Uint8Array,
  header: string | undefined,
  apiKey: string,
  nowMs: number,
  toleranceMs: number = DEFAULT_TOLERANCE_MS,
): SignatureCheck {
  if (header === undefined || header === "") return { ok: false, reason: "missing_header" };
  const m = HEADER_PATTERN.exec(header.trim());
  if (!m) return { ok: false, reason: "malformed_header" };
  const timestampText = m[1] as string;
  const given = Buffer.from((m[2] as string).toLowerCase(), "hex");
  const expected = Buffer.from(computeDigest(rawBody, timestampText, apiKey), "hex");
  // Both buffers are 32 bytes (the pattern fixes the length), so timingSafeEqual cannot throw.
  if (!timingSafeEqual(given, expected)) return { ok: false, reason: "bad_digest" };
  const timestampMs = Number(timestampText);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > toleranceMs) {
    return { ok: false, reason: "stale_timestamp" };
  }
  return { ok: true, timestampMs, digest: expected.toString("hex") };
}

// ---------------------------------------------------------------- replay guard

export interface CachedResponse {
  status: number;
  body: string;
}

export type ReplayPolicy = "reject" | "cached" | "off";

export type ReplayVerdict = { kind: "new" } | { kind: "replay"; cached?: CachedResponse };

/**
 * Remembers the digest of every request that passed verification. A digest covers body and timestamp, so the same
 * digest twice is the same bytes sent twice. Entries live as long as the signature could still be fresh.
 *
 * `reject`: a repeat is refused (HTTP 409). `cached`: a repeat gets the first answer again, so a platform that
 * retries with the same header still works, and nothing runs twice. `off`: no memory (only for tests).
 */
export class ReplayGuard {
  private readonly seen = new Map<string, { expiresAtMs: number; response?: CachedResponse }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: { toleranceMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = (opts.toleranceMs ?? DEFAULT_TOLERANCE_MS) * 2 + 1000;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  check(digest: string, nowMs: number): ReplayVerdict {
    this.purge(nowMs);
    const hit = this.seen.get(digest);
    if (!hit || hit.expiresAtMs <= nowMs) return { kind: "new" };
    return hit.response ? { kind: "replay", cached: hit.response } : { kind: "replay" };
  }

  remember(digest: string, nowMs: number, response?: CachedResponse): void {
    this.purge(nowMs);
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(digest, { expiresAtMs: nowMs + this.ttlMs, ...(response ? { response } : {}) });
  }

  forget(digest: string): void {
    this.seen.delete(digest);
  }

  get size(): number {
    return this.seen.size;
  }

  private purge(nowMs: number): void {
    for (const [k, v] of this.seen) {
      if (v.expiresAtMs <= nowMs) this.seen.delete(k);
      else break; // entries are inserted in time order, so the first live one ends the scan
    }
  }
}
