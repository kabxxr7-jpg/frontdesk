// Booking log in Airtable through its REST API (no SDK). Every booking, move, cancel and deposit payment upserts one
// row per confirmation code (performUpsert on "Code"), so a retried event or a replay never makes a duplicate row.
// Writes for the same appointment run one after another and always send the latest stored state, so a quick
// book-then-cancel can never leave the row saying "Booked". No names, phone numbers or emails are sent: the table is
// meant to be shareable.
import type { Appointment } from "./db.ts";
import type { FetchLike } from "./email.ts";

export interface BookingRow {
  Code: string;
  Service: string;
  /** ISO 8601 with offset. */
  Time: string;
  Staff: string;
  Status: "Booked" | "Rescheduled" | "Cancelled";
  Deposit: string;
  Source: "Voice" | "Chat";
  /** ISO 8601, when the row was last written. */
  Updated: string;
}

export interface BookingLog {
  readonly kind: "airtable" | "memory";
  upsert(row: BookingRow): Promise<void>;
}

export class MemoryBookingLog implements BookingLog {
  readonly kind = "memory" as const;
  readonly rows = new Map<string, BookingRow>();
  readonly writes: BookingRow[] = [];
  failNext = 0;
  async upsert(row: BookingRow): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("Airtable unavailable (simulated)");
    }
    this.writes.push(row);
    this.rows.set(row.Code, row);
  }
}

export interface AirtableOptions {
  /** Personal access token (pat...), scoped to one base. */
  token: string;
  baseId: string;
  table: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Waits between retries on 429 / 5xx (tests pass zeros). */
  retryDelaysMs?: number[];
}

export class AirtableLog implements BookingLog {
  readonly kind = "airtable" as const;
  private readonly o: AirtableOptions;
  constructor(o: AirtableOptions) {
    if (!/^pat[A-Za-z0-9.]{20,}$/.test(o.token)) throw new Error("AIRTABLE_TOKEN does not look like a personal access token (pat...)");
    if (!/^app[A-Za-z0-9]{14}$/.test(o.baseId)) throw new Error("AIRTABLE_BASE_ID does not look like a base id (app + 14 characters)");
    if (!o.table.trim()) throw new Error("AIRTABLE_TABLE is empty");
    this.o = o;
  }

  async upsert(row: BookingRow): Promise<void> {
    const f = this.o.fetch ?? ((url, init) => fetch(url, init));
    const url = `https://api.airtable.com/v0/${this.o.baseId}/${encodeURIComponent(this.o.table)}`;
    const body = JSON.stringify({ performUpsert: { fieldsToMergeOn: ["Code"] }, typecast: true, records: [{ fields: row }] });
    const delays = this.o.retryDelaysMs ?? [1000, 3000];
    for (let attempt = 0; ; attempt += 1) {
      const res = await f(url, {
        method: "PATCH",
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000),
      });
      if (res.ok) return;
      // Airtable allows 5 requests a second per base and answers 429 above that; 5xx is worth one more try too.
      const retry = (res.status === 429 || res.status >= 500) && attempt < delays.length;
      if (!retry) {
        const b = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } | string };
        const e = typeof b.error === "string" ? b.error : `${b.error?.type ?? ""} ${b.error?.message ?? ""}`;
        throw new Error(`Airtable refused the row: ${res.status} ${e}`.trim().slice(0, 300));
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

export function sourceOf(callId: string): "Voice" | "Chat" {
  return callId.startsWith("chat_") ? "Chat" : "Voice";
}

export function statusOf(a: Appointment): BookingRow["Status"] {
  if (a.status === "cancelled") return "Cancelled";
  return a.history.some((h) => h.action === "rescheduled") ? "Rescheduled" : "Booked";
}

export function depositOf(a: Appointment): string {
  if (a.depositStatus === "none" || a.depositUsd <= 0) return "None";
  const amount = `$${a.depositUsd % 1 === 0 ? a.depositUsd : a.depositUsd.toFixed(2)}`;
  return a.depositStatus === "paid" ? `${amount} paid` : `${amount} due`;
}

/**
 * Runs writes for the same key strictly one after another (a later write waits for the earlier one, whatever its
 * outcome). Keys are dropped once their queue is empty.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
