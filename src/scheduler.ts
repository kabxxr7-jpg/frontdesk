// Slot generation and slot validation, from wall-clock windows in the business's zone (DST-safe: each slot is
// converted to an instant on its own). Two sources of "busy": our own bookings (the database, per staff member) and
// blocks someone typed into the real calendar (lunch, a day off), which block everyone.
import type { Business, Service, StaffMember, WeeklyWindows } from "./business.ts";
import { staffFor } from "./business.ts";
import type { Db } from "./db.ts";
import { addDays, compareYmd, dayKeyOf, formatYmd, localParts, localYmd, parseHm, zonedToUtc, type Ymd } from "./time.ts";

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

export type Busy = readonly (readonly [number, number])[];

export interface Slot {
  startUtc: number;
  endUtc: number;
  staffId: string;
}

export function instantOf(b: Business, date: Ymd, minutesOfDay: number): number {
  const r = zonedToUtc(date, minutesOfDay, b.timezone);
  if (r.kind === "ok" || r.kind === "ambiguous") return r.utcMs;
  const shifted = zonedToUtc(date, minutesOfDay + 60, b.timezone);
  if (shifted.kind === "ok" || shifted.kind === "ambiguous") return shifted.utcMs;
  throw new Error("unreachable: no instant within two hours of a skipped time");
}

export function closedDateInfo(b: Business, date: Ymd): { date: string; reason: string } | undefined {
  const key = formatYmd(date);
  return b.closedDates.find((c) => c.date === key);
}

function windowsFor(windows: WeeklyWindows, date: Ymd): [number, number][] {
  const out: [number, number][] = [];
  for (const w of windows[dayKeyOf(date)] ?? []) {
    const a = parseHm(w[0]);
    const z = parseHm(w[1]);
    if (a !== null && z !== null) out.push([a, z]);
  }
  return out;
}

export function openWindows(b: Business, date: Ymd): [number, number][] {
  if (closedDateInfo(b, date)) return [];
  return windowsFor(b.hours, date);
}

export function staffWindows(b: Business, st: StaffMember, date: Ymd): [number, number][] {
  const open = openWindows(b, date);
  const out: [number, number][] = [];
  for (const [a, z] of windowsFor(st.schedule, date)) {
    for (const [c, d] of open) {
      const lo = Math.max(a, c);
      const hi = Math.min(z, d);
      if (lo < hi) out.push([lo, hi]);
    }
  }
  return out;
}

export function isOpenAt(b: Business, utcMs: number): boolean {
  const lp = localParts(utcMs, b.timezone);
  const minutes = lp.hh * 60 + lp.mm;
  return openWindows(b, { y: lp.y, m: lp.m, d: lp.d }).some(([a, z]) => minutes >= a && minutes < z);
}

const overlapsBusy = (busy: Busy, s: number, e: number): boolean => busy.some(([bs, be]) => bs < e && s < be);

export interface FindSlotsOptions {
  from: Ymd;
  to: Ymd;
  service: Service;
  staffId?: string | undefined;
  partOfDay?: "morning" | "afternoon" | "any" | undefined;
  nowMs: number;
  busy?: Busy;
  ignoreAppointmentId?: string | undefined;
}

/** Free slots, earliest first. With no staff member given, each start time appears once. */
export function findSlots(b: Business, db: Db, opts: FindSlotsOptions): Slot[] {
  const { slotMinutes, minLeadMinutes, maxBookAheadDays } = b.scheduling;
  const earliest = opts.nowMs + minLeadMinutes * MS_MIN;
  const latest = opts.nowMs + maxBookAheadDays * MS_DAY;
  const people = staffFor(b, opts.service, opts.staffId);
  const order = new Map(b.staff.map((st, i) => [st.id, i]));
  const durationMs = opts.service.durationMinutes * MS_MIN;
  const busy = opts.busy ?? [];
  const out: Slot[] = [];
  for (let date = opts.from; compareYmd(date, opts.to) <= 0; date = addDays(date, 1)) {
    const seen = new Set<number>();
    const day: Slot[] = [];
    for (const st of people) {
      for (const [ws, we] of staffWindows(b, st, date)) {
        const weUtc = instantOf(b, date, we);
        for (let m = ws; m < we; m += slotMinutes) {
          const startUtc = instantOf(b, date, m);
          const endUtc = startUtc + durationMs;
          if (endUtc > weUtc) break;
          if (startUtc < earliest || startUtc > latest) continue;
          if (opts.partOfDay === "morning" && m >= 12 * 60) continue;
          if (opts.partOfDay === "afternoon" && m < 12 * 60) continue;
          if (overlapsBusy(busy, startUtc, endUtc)) continue;
          if (db.conflictsFor(st.id, startUtc, endUtc, opts.ignoreAppointmentId).length > 0) continue;
          if (opts.staffId === undefined) {
            if (seen.has(startUtc)) continue;
            seen.add(startUtc);
          }
          day.push({ startUtc, endUtc, staffId: st.id });
        }
      }
    }
    day.sort((x, y) => x.startUtc - y.startUtc || (order.get(x.staffId) ?? 0) - (order.get(y.staffId) ?? 0));
    out.push(...day);
  }
  return out;
}

export type SlotProblem =
  | "in_the_past" | "too_soon" | "too_far" | "closed_date" | "closed_day" | "off_grid" | "outside_hours"
  | "staff_not_working" | "nobody_for_time" | "slot_taken";

export type SlotCheck = { ok: true; staff: StaffMember; endUtc: number } | { ok: false; code: SlotProblem; closedReason?: string };

export interface CheckSlotOptions {
  startUtc: number;
  service: Service;
  staffId?: string | undefined;
  preferStaffId?: string | undefined;
  nowMs: number;
  busy?: Busy;
  ignoreAppointmentId?: string | undefined;
}

export function checkSlot(b: Business, db: Db, opts: CheckSlotOptions): SlotCheck {
  const { slotMinutes, minLeadMinutes, maxBookAheadDays } = b.scheduling;
  const lp = localParts(opts.startUtc, b.timezone);
  const date: Ymd = { y: lp.y, m: lp.m, d: lp.d };
  const endUtc = opts.startUtc + opts.service.durationMinutes * MS_MIN;
  if (opts.startUtc < opts.nowMs) return { ok: false, code: "in_the_past" };
  if (opts.startUtc < opts.nowMs + minLeadMinutes * MS_MIN) return { ok: false, code: "too_soon" };
  if (opts.startUtc > opts.nowMs + maxBookAheadDays * MS_DAY) return { ok: false, code: "too_far" };
  const closed = closedDateInfo(b, date);
  if (closed) return { ok: false, code: "closed_date", closedReason: closed.reason };
  if (windowsFor(b.hours, date).length === 0) return { ok: false, code: "closed_day" };
  if (lp.mm % slotMinutes !== 0 || lp.ss !== 0 || opts.startUtc % MS_MIN !== 0) return { ok: false, code: "off_grid" };
  const inside = (ws: [number, number][]) => ws.some(([a, z]) => instantOf(b, date, a) <= opts.startUtc && endUtc <= instantOf(b, date, z));
  if (!inside(openWindows(b, date))) return { ok: false, code: "outside_hours" };
  const working = staffFor(b, opts.service, opts.staffId).filter((st) => inside(staffWindows(b, st, date)));
  if (working.length === 0) return { ok: false, code: opts.staffId !== undefined ? "staff_not_working" : "nobody_for_time" };
  if (overlapsBusy(opts.busy ?? [], opts.startUtc, endUtc)) return { ok: false, code: "slot_taken" };
  const free = working.filter((st) => db.conflictsFor(st.id, opts.startUtc, endUtc, opts.ignoreAppointmentId).length === 0);
  if (free.length === 0) return { ok: false, code: "slot_taken" };
  const preferred = opts.preferStaffId !== undefined ? free.find((st) => st.id === opts.preferStaffId) : undefined;
  return { ok: true, staff: preferred ?? (free[0] as StaffMember), endUtc };
}

export function nearestSlots(
  b: Business,
  db: Db,
  opts: { service: Service; staffId?: string | undefined; aroundUtc: number; nowMs: number; count: number; busy?: Busy; ignoreAppointmentId?: string | undefined },
): Slot[] {
  const today = localYmd(opts.nowMs, b.timezone);
  let from = localYmd(opts.aroundUtc, b.timezone);
  if (compareYmd(from, today) < 0) from = today;
  const slots = findSlots(b, db, {
    from, to: addDays(from, 6), service: opts.service, staffId: opts.staffId, nowMs: opts.nowMs,
    ignoreAppointmentId: opts.ignoreAppointmentId, ...(opts.busy ? { busy: opts.busy } : {}),
  });
  return slots
    .sort((x, y) => Math.abs(x.startUtc - opts.aroundUtc) - Math.abs(y.startUtc - opts.aroundUtc))
    .slice(0, opts.count)
    .sort((x, y) => x.startUtc - y.startUtc);
}
