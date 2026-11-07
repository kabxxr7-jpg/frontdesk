// SQLite store (node:sqlite, no dependency). One file on the droplet's volume; survives restarts. A partial unique
// index makes a double booking of the same person at the same start impossible even if two calls race, and the
// overlap check (a 60-minute visit against a 30-minute one) runs inside the same synchronous transaction.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface HistoryEntry {
  atMs: number;
  callId: string;
  action: "booked" | "rescheduled" | "cancelled" | "deposit_paid";
  fromStartUtc?: number;
  fromStaffId?: string;
}

export interface Appointment {
  id: string;
  /** Four characters the caller can read back ("K7QM"). */
  code: string;
  callId: string;
  staffId: string;
  serviceId: string;
  startUtc: number;
  endUtc: number;
  customerName: string;
  /** E.164 */
  phone: string;
  email?: string | undefined;
  address?: string | undefined;
  notes?: string | undefined;
  status: "booked" | "cancelled";
  createdAtMs: number;
  updatedAtMs: number;
  lateCancellation?: boolean | undefined;
  calendarEventId?: string | undefined;
  calendarStatus: "none" | "synced" | "failed";
  depositUsd: number;
  depositStatus: "none" | "due" | "paid";
  depositPaidAtMs?: number | undefined;
  stripeSessionId?: string | undefined;
  stripeSessionUrl?: string | undefined;
  stripeSessionExpiresMs?: number | undefined;
  stripePaymentIntent?: string | undefined;
  history: HistoryEntry[];
}

export interface ToolLogEntry {
  callId: string;
  atMs: number;
  tool: string;
  ok: boolean;
  outcome: string;
  /** One line a person can read. Never the full request. */
  note: string;
  appointmentId?: string | undefined;
  urgentLabel?: "emergency" | "ambiguous" | undefined;
  transfer?: { destination: string; urgency: string } | undefined;
}

export interface CallRecord {
  callId: string;
  endedPayload?: unknown;
  analyzedPayload?: unknown;
  summarySent?: boolean;
}

export type ClaimResult = "claimed" | "in_flight" | "done";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  staff_id TEXT NOT NULL,
  start_utc INTEGER NOT NULL,
  end_utc INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('booked','cancelled')),
  phone TEXT NOT NULL,
  stripe_session_id TEXT,
  doc TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_booking_per_start ON appointments(staff_id, start_utc) WHERE status = 'booked';
CREATE INDEX IF NOT EXISTS appointments_phone ON appointments(phone);
CREATE TABLE IF NOT EXISTS tool_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tool_log_call ON tool_log(call_id);
CREATE TABLE IF NOT EXISTS calls (call_id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, state TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries (key TEXT PRIMARY KEY, at INTEGER NOT NULL, ref TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679"; // no 0/O, 1/I/L, 2/Z, 5/S, 8/B: easy to read aloud

export class Db {
  readonly sql: DatabaseSync;

  constructor(file = ":memory:") {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;");
    this.sql.exec(SCHEMA);
  }

  close(): void {
    if (this.sql.isOpen) this.sql.close();
  }

  /** Runs fn inside BEGIN IMMEDIATE ... COMMIT; rolls back when it throws. */
  tx<T>(fn: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.sql.exec("COMMIT");
      return out;
    } catch (err) {
      this.sql.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- appointments

  newAppointmentId(): string {
    const row = this.sql.prepare("SELECT value FROM meta WHERE key = 'next_id'").get() as { value: string } | undefined;
    const next = row ? Number(row.value) : 1;
    this.sql.prepare("INSERT INTO meta(key, value) VALUES ('next_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(next + 1));
    return `apt_${String(next).padStart(5, "0")}`;
  }

  newCode(random: () => number = Math.random): string {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let code = "";
      for (let i = 0; i < 4; i += 1) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
      if (!this.sql.prepare("SELECT 1 FROM appointments WHERE code = ?").get(code)) return code;
    }
    throw new Error("could not find a free appointment code");
  }

  /** Insert or replace. Throws (SQLITE_CONSTRAINT) when another booked row holds the same staff and start. */
  saveAppointment(a: Appointment): void {
    this.sql
      .prepare(
        `INSERT INTO appointments (id, code, staff_id, start_utc, end_utc, status, phone, stripe_session_id, doc) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET staff_id=excluded.staff_id, start_utc=excluded.start_utc, end_utc=excluded.end_utc,
           status=excluded.status, phone=excluded.phone, stripe_session_id=excluded.stripe_session_id, doc=excluded.doc`,
      )
      .run(a.id, a.code, a.staffId, a.startUtc, a.endUtc, a.status, a.phone, a.stripeSessionId ?? null, JSON.stringify(a));
  }

  getAppointment(id: string): Appointment | undefined {
    const row = this.sql.prepare("SELECT doc FROM appointments WHERE id = ?").get(id) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Appointment) : undefined;
  }

  byCode(code: string): Appointment | undefined {
    const row = this.sql.prepare("SELECT doc FROM appointments WHERE code = ?").get(code.toUpperCase()) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Appointment) : undefined;
  }

  byStripeSession(sessionId: string): Appointment | undefined {
    const row = this.sql.prepare("SELECT doc FROM appointments WHERE stripe_session_id = ?").get(sessionId) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Appointment) : undefined;
  }

  upcomingForPhone(phone: string, nowMs: number): Appointment[] {
    return (this.sql.prepare("SELECT doc FROM appointments WHERE phone = ? AND status = 'booked' AND end_utc > ? ORDER BY start_utc").all(phone, nowMs) as { doc: string }[]).map(
      (r) => JSON.parse(r.doc) as Appointment,
    );
  }

  /** Booked appointments for one staff member overlapping [startUtc, endUtc). */
  conflictsFor(staffId: string, startUtc: number, endUtc: number, ignoreId?: string): Appointment[] {
    return (
      this.sql
        .prepare("SELECT doc FROM appointments WHERE status = 'booked' AND staff_id = ? AND start_utc < ? AND end_utc > ? AND id != ?")
        .all(staffId, endUtc, startUtc, ignoreId ?? "") as { doc: string }[]
    ).map((r) => JSON.parse(r.doc) as Appointment);
  }

  appointmentsForCall(callId: string): Appointment[] {
    return this.allAppointments().filter((a) => a.callId === callId || a.history.some((h) => h.callId === callId));
  }

  allAppointments(): Appointment[] {
    return (this.sql.prepare("SELECT doc FROM appointments ORDER BY start_utc").all() as { doc: string }[]).map((r) => JSON.parse(r.doc) as Appointment);
  }

  // ---- tool log

  logTool(entry: ToolLogEntry): void {
    this.sql.prepare("INSERT INTO tool_log (call_id, doc) VALUES (?, ?)").run(entry.callId, JSON.stringify(entry));
  }

  toolLogFor(callId: string): ToolLogEntry[] {
    return (this.sql.prepare("SELECT doc FROM tool_log WHERE call_id = ? ORDER BY seq").all(callId) as { doc: string }[]).map((r) => JSON.parse(r.doc) as ToolLogEntry);
  }

  // ---- calls

  getCall(callId: string): CallRecord | undefined {
    const row = this.sql.prepare("SELECT doc FROM calls WHERE call_id = ?").get(callId) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as CallRecord) : undefined;
  }

  updateCall(callId: string, patch: Partial<CallRecord>): CallRecord {
    const next: CallRecord = { ...(this.getCall(callId) ?? { callId }), ...patch, callId };
    this.sql.prepare("INSERT INTO calls (call_id, doc) VALUES (?, ?) ON CONFLICT(call_id) DO UPDATE SET doc = excluded.doc").run(callId, JSON.stringify(next));
    return next;
  }

  countCallsSince(sinceMs: number): number {
    const row = this.sql.prepare("SELECT COUNT(*) AS n FROM events WHERE key LIKE 'inbound:%' AND at >= ?").get(sinceMs) as { n: number };
    return Number(row.n);
  }

  // ---- event claims (webhook de-duplication)

  claimEvent(key: string, nowMs = Date.now()): ClaimResult {
    return this.tx(() => {
      const row = this.sql.prepare("SELECT state FROM events WHERE key = ?").get(key) as { state: string } | undefined;
      if (row?.state === "done") return "done";
      if (row?.state === "in_flight") return "in_flight";
      this.sql.prepare("INSERT INTO events (key, state, at) VALUES (?, 'in_flight', ?)").run(key, nowMs);
      return "claimed";
    });
  }

  completeEvent(key: string): void {
    this.sql.prepare("UPDATE events SET state = 'done' WHERE key = ?").run(key);
  }

  releaseEvent(key: string): void {
    this.sql.prepare("DELETE FROM events WHERE key = ? AND state = 'in_flight'").run(key);
  }

  /** An event key recorded as done right away (used to count inbound calls). */
  recordEvent(key: string, nowMs: number): boolean {
    const r = this.sql.prepare("INSERT OR IGNORE INTO events (key, state, at) VALUES (?, 'done', ?)").run(key, nowMs);
    return Number(r.changes) === 1;
  }

  /** In-flight claims older than maxAgeMs belong to a crashed request; give them back. */
  releaseStaleClaims(nowMs: number, maxAgeMs = 120_000): number {
    const r = this.sql.prepare("DELETE FROM events WHERE state = 'in_flight' AND at < ?").run(nowMs - maxAgeMs);
    return Number(r.changes);
  }

  // ---- delivery ledger

  hasDelivery(key: string): boolean {
    return this.sql.prepare("SELECT 1 FROM deliveries WHERE key = ?").get(key) !== undefined;
  }

  markDelivery(key: string, nowMs: number, ref?: string): void {
    this.sql.prepare("INSERT OR IGNORE INTO deliveries (key, at, ref) VALUES (?, ?, ?)").run(key, nowMs, ref ?? null);
  }
}
