// The calendar the business's staff look at. Google Calendar through a service account (JWT signed with node:crypto,
// no SDK), or an in-memory calendar for tests and for running without Google.
//
// Events this server creates carry extendedProperties.private.fd_id = <appointment id>, so the availability check can
// tell our own bookings (already in the database) from blocks a person typed in (which block everyone).
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseYmd, zonedToUtc } from "./time.ts";

export interface CalendarEventInput {
  appointmentId: string;
  summary: string;
  description: string;
  startUtc: number;
  endUtc: number;
  timeZone: string;
}

export interface Calendar {
  readonly kind: "google" | "memory";
  /** Busy intervals in [fromUtc, toUtc) that were NOT created by this server. */
  externalBusy(fromUtc: number, toUtc: number): Promise<[number, number][]>;
  createEvent(e: CalendarEventInput): Promise<string>;
  updateEvent(eventId: string, e: CalendarEventInput): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
}

// ---------------------------------------------------------------- in memory

export class MemoryCalendar implements Calendar {
  readonly kind = "memory" as const;
  readonly events = new Map<string, CalendarEventInput & { id: string }>();
  readonly blocks: [number, number][] = [];
  failNext: "create" | "update" | "delete" | "busy" | null = null;
  private seq = 0;
  /** Simulated network latency for every call (tests). */
  delayMs = 0;
  private async lag(): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  private maybeFail(op: "create" | "update" | "delete" | "busy"): void {
    if (this.failNext === op) {
      this.failNext = null;
      throw new Error(`calendar ${op} failed (simulated)`);
    }
  }

  async externalBusy(fromUtc: number, toUtc: number): Promise<[number, number][]> {
    await this.lag();
    this.maybeFail("busy");
    return this.blocks.filter(([s, e]) => s < toUtc && fromUtc < e);
  }

  async createEvent(e: CalendarEventInput): Promise<string> {
    await this.lag();
    this.maybeFail("create");
    this.seq += 1;
    const id = `mem_evt_${this.seq}`;
    this.events.set(id, { ...e, id });
    return id;
  }

  async updateEvent(eventId: string, e: CalendarEventInput): Promise<void> {
    await this.lag();
    this.maybeFail("update");
    if (!this.events.has(eventId)) throw new Error("event not found");
    this.events.set(eventId, { ...e, id: eventId });
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.lag();
    this.maybeFail("delete");
    this.events.delete(eventId);
  }
}

// ---------------------------------------------------------------- Google

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

export function signServiceAccountJwt(key: ServiceAccountKey, nowSec: number, scope: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: key.client_email, scope, aud: key.token_uri ?? "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GoogleCalendarOptions {
  key: ServiceAccountKey;
  calendarId: string;
  fetch?: FetchLike;
  clock?: () => number;
  timeoutMs?: number;
  /** The business's zone: an all-day event blocks that local day. */
  timeZone?: string;
}

/** Local midnight of an all-day event's date, as an instant. */
function allDayStart(date: string, timeZone: string): number {
  const ymd = parseYmd(date);
  if (!ymd) return NaN;
  const z = zonedToUtc(ymd, 0, timeZone);
  return z.kind === "gap" ? NaN : z.utcMs;
}

export class GoogleCalendarError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "GoogleCalendarError";
  }
}

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendar implements Calendar {
  readonly kind = "google" as const;
  private token: { value: string; expiresMs: number } | null = null;
  private readonly fetch: FetchLike;
  private readonly clock: () => number;
  private readonly timeoutMs: number;

  private readonly o: GoogleCalendarOptions;
  constructor(o: GoogleCalendarOptions) {
    this.o = o;
    this.fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.clock = o.clock ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? 6000;
  }

  static fromFile(path: string, calendarId: string, timeZone: string): GoogleCalendar {
    const key = JSON.parse(readFileSync(path, "utf8")) as ServiceAccountKey;
    if (!key.client_email || !key.private_key) throw new Error("the service account file has no client_email or private_key");
    return new GoogleCalendar({ key, calendarId, timeZone });
  }

  get serviceAccountEmail(): string {
    return this.o.key.client_email;
  }

  private async accessToken(): Promise<string> {
    const now = this.clock();
    if (this.token && this.token.expiresMs - 60_000 > now) return this.token.value;
    const assertion = signServiceAccountJwt(this.o.key, Math.floor(now / 1000), SCOPE);
    const res = await this.fetch(this.o.key.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new GoogleCalendarError(`token request failed: ${res.status} ${body.error ?? ""}`.trim(), res.status);
    this.token = { value: body.access_token, expiresMs: now + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<unknown> {
    const url = `${API}/calendars/${encodeURIComponent(this.o.calendarId)}${path}${query ? `?${new URLSearchParams(query).toString()}` : ""}`;
    const res = await this.fetch(url, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 204) return null;
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new GoogleCalendarError(`Google Calendar ${method} ${path.split("?")[0]} failed: ${res.status} ${json.error?.message ?? ""}`.trim(), res.status);
    return json;
  }

  async externalBusy(fromUtc: number, toUtc: number): Promise<[number, number][]> {
    const out: [number, number][] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = (await this.call("GET", "/events", undefined, {
        timeMin: new Date(fromUtc).toISOString(),
        timeMax: new Date(toUtc).toISOString(),
        singleEvents: "true",
        maxResults: "250",
        ...(pageToken ? { pageToken } : {}),
      })) as { items?: GoogleEvent[]; nextPageToken?: string };
      for (const ev of res.items ?? []) {
        if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
        if (ev.extendedProperties?.private?.["fd_id"]) continue; // ours: already in the database
        const tz = this.o.timeZone ?? "UTC";
        const s = ev.start?.dateTime ? Date.parse(ev.start.dateTime) : ev.start?.date ? allDayStart(ev.start.date, tz) : NaN;
        const e = ev.end?.dateTime ? Date.parse(ev.end.dateTime) : ev.end?.date ? allDayStart(ev.end.date, tz) : NaN;
        if (Number.isFinite(s) && Number.isFinite(e)) out.push([s, e]);
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  private body(e: CalendarEventInput) {
    return {
      summary: e.summary,
      description: e.description,
      start: { dateTime: new Date(e.startUtc).toISOString(), timeZone: e.timeZone },
      end: { dateTime: new Date(e.endUtc).toISOString(), timeZone: e.timeZone },
      extendedProperties: { private: { fd_id: e.appointmentId } },
      reminders: { useDefault: false, overrides: [] },
    };
  }

  async createEvent(e: CalendarEventInput): Promise<string> {
    const res = (await this.call("POST", "/events", this.body(e))) as { id?: string };
    if (!res.id) throw new GoogleCalendarError("Google Calendar returned no event id", 502);
    return res.id;
  }

  async updateEvent(eventId: string, e: CalendarEventInput): Promise<void> {
    await this.call("PATCH", `/events/${encodeURIComponent(eventId)}`, this.body(e));
  }

  async deleteEvent(eventId: string): Promise<void> {
    try {
      await this.call("DELETE", `/events/${encodeURIComponent(eventId)}`);
    } catch (err) {
      // Already gone (someone deleted it by hand): the goal is reached.
      if (err instanceof GoogleCalendarError && (err.status === 404 || err.status === 410)) return;
      throw err;
    }
  }
}

interface GoogleEvent {
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}
