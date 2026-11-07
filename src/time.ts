// Calendar and time-zone helpers with no dependencies.
//
// The clinic works in one IANA zone (America/Los_Angeles). Everything stored is a UTC instant; everything a
// caller hears is wall-clock time in that zone. The only safe way to go between the two is to ask the zone
// database for the offset that applies AT THAT INSTANT, never to add a fixed number of hours. On the two
// DST days of the year a fixed "UTC-8" or "midnight plus N minutes" is wrong for half the day.

export type Ymd = { y: number; m: number; d: number };

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

/** Strict `YYYY-MM-DD` that must also be a real calendar date (2027-02-29 is rejected). */
export function parseYmd(text: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export function formatYmd(v: Ymd): string {
  return `${String(v.y).padStart(4, "0")}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;
}

export function ymdToUtcMidnightMs(v: Ymd): number {
  return Date.UTC(v.y, v.m - 1, v.d);
}

/** Pure calendar arithmetic (no zone involved): add whole days to a date. */
export function addDays(v: Ymd, days: number): Ymd {
  const t = new Date(ymdToUtcMidnightMs(v) + days * MS_DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function compareYmd(a: Ymd, b: Ymd): number {
  return ymdToUtcMidnightMs(a) - ymdToUtcMidnightMs(b);
}

/** Whole calendar days from a to b (b - a). */
export function daysBetween(a: Ymd, b: Ymd): number {
  return Math.round((ymdToUtcMidnightMs(b) - ymdToUtcMidnightMs(a)) / MS_DAY);
}

export function weekdayIndex(v: Ymd): number {
  return new Date(ymdToUtcMidnightMs(v)).getUTCDay();
}

export function dayKeyOf(v: Ymd): DayKey {
  return DAY_KEYS[weekdayIndex(v)] as DayKey;
}

/** "HH:MM" to minutes after midnight; "24:00" is allowed as an end-of-day marker. */
export function parseHm(text: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

// ---------------------------------------------------------------- zone arithmetic

export type LocalParts = { y: number; m: number; d: number; hh: number; mm: number; ss: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of a UTC instant in the given zone. */
export function localParts(utcMs: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(Math.floor(utcMs / 1000) * 1000));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const hhRaw = get("hour");
  return {
    y,
    m,
    d,
    hh: hhRaw === 24 ? 0 : hhRaw,
    mm: get("minute"),
    ss: get("second"),
    weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
  };
}

/** Offset from UTC, in minutes, that the zone has AT this instant (Pacific: -480 in winter, -420 in summer). */
export function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const p = localParts(utcMs, timeZone);
  const asIfUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asIfUtc - Math.floor(utcMs / 1000) * 1000) / MS_MIN);
}

export type ZonedResult =
  | { kind: "ok"; utcMs: number }
  /** The wall-clock time does not exist (clocks jumped forward over it). */
  | { kind: "gap" }
  /** The wall-clock time happens twice (clocks fell back). `utcMs` is the first occurrence. */
  | { kind: "ambiguous"; utcMs: number; secondUtcMs: number };

/**
 * Converts a wall-clock time in a zone to a UTC instant, noticing the two cases a naive conversion gets wrong:
 * a local time skipped by "spring forward" (no such instant) and a local time repeated by "fall back" (two instants).
 */
export function zonedToUtc(date: Ymd, minutesOfDay: number, timeZone: string): ZonedResult {
  const wall = ymdToUtcMidnightMs(date) + minutesOfDay * MS_MIN;
  const offsets = new Set<number>([
    offsetMinutesAt(wall - MS_DAY, timeZone),
    offsetMinutesAt(wall + MS_DAY, timeZone),
  ]);
  const valid: number[] = [];
  for (const offset of offsets) {
    const candidate = wall - offset * MS_MIN;
    if (offsetMinutesAt(candidate, timeZone) === offset) valid.push(candidate);
  }
  valid.sort((a, b) => a - b);
  const first = valid[0];
  const second = valid[1];
  if (first === undefined) return { kind: "gap" };
  if (second !== undefined) return { kind: "ambiguous", utcMs: first, secondUtcMs: second };
  return { kind: "ok", utcMs: first };
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** `2027-03-14T09:00:00-07:00`: local wall-clock time plus the offset that applies at that instant. */
export function toIsoWithOffset(utcMs: number, timeZone: string): string {
  const p = localParts(utcMs, timeZone);
  const off = formatOffset(offsetMinutesAt(utcMs, timeZone));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(p.y).padStart(4, "0")}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}${off}`;
}

export function localYmd(utcMs: number, timeZone: string): Ymd {
  const p = localParts(utcMs, timeZone);
  return { y: p.y, m: p.m, d: p.d };
}

export function minutesOfDayLocal(utcMs: number, timeZone: string): number {
  const p = localParts(utcMs, timeZone);
  return p.hh * 60 + p.mm;
}

// ---------------------------------------------------------------- speech-friendly formatting

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export function spokenTime(hh: number, mm: number): string {
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const suffix = hh < 12 ? "AM" : "PM";
  return `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

export function spokenDate(v: Ymd): string {
  return `${WEEKDAY_NAMES[weekdayIndex(v)]}, ${MONTH_NAMES[v.m - 1]} ${ordinal(v.d)}`;
}

/** "Tuesday, November 3rd at 9:00 AM" for a UTC instant, in the zone. */
export function spokenDateTime(utcMs: number, timeZone: string): string {
  const p = localParts(utcMs, timeZone);
  return `${spokenDate(p)} at ${spokenTime(p.hh, p.mm)}`;
}

export function weekdayName(v: Ymd): string {
  return WEEKDAY_NAMES[weekdayIndex(v)] as string;
}
