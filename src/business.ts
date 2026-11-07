// The business a front desk answers for: one JSON file (businesses/<slug>/business.json), made by `npm run reskin`
// from a short brief. Loading validates every cross-reference, so a typo in a schedule fails at startup and not on a
// caller's second sentence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DAY_KEYS, parseHm, parseYmd, type DayKey } from "./time.ts";

export type Window = readonly [string, string];
export type WeeklyWindows = Partial<Record<DayKey, readonly Window[]>>;

export interface Service {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
  priceUsd: number;
  /** "starting price", "per hour", ... */
  priceNote?: string;
  /** A deposit taken by card (Stripe) after booking. 0 or absent: no deposit. */
  depositUsd?: number;
  keywords: string[];
}

export interface StaffMember {
  id: string;
  name: string;
  /** How the agent says it: "Dr. Chen", "Marco". */
  short: string;
  title: string;
  serviceIds: string[];
  schedule: WeeklyWindows;
}

export interface FaqEntry {
  id: string;
  topic: string;
  keywords: string[];
  /** May contain {{tokens}}: {{hours}}, {{address}}, {{phone}}, {{services}}, {{price:<service id>}}, {{deposit:<service id>}}, {{cancel_hours}}, {{late_fee}}. */
  answer: string;
}

export interface UrgentRule {
  id: string;
  /** Lower-case phrases; a phrase matches on word boundaries. */
  phrases: string[];
}

export interface Business {
  slug: string;
  name: string;
  /** "dental clinic", "plumbing company": used in sentences. */
  vertical: string;
  /** True for every demo. The demo page and every email say so. */
  fictional: boolean;
  fictionNote: string;
  timezone: string;
  address: string;
  serviceArea?: string;
  phones: {
    /** Where a "talk to a person" transfer goes (E.164). Fictional 555 numbers cannot be dialled; see transfer.ts. */
    frontDesk: string;
    emergency?: { name: string; phone: string };
  };
  agent: {
    /** The receptionist's first name ("Ava"). */
    name: string;
    /** patient / customer / client */
    customerWord: string;
    /** appointment / visit / job */
    visitWord: string;
    /** Home-service businesses need the job address. */
    collectAddress: boolean;
    /** Optional Retell voice id; the setup script falls back to a default. */
    voiceId?: string;
  };
  scheduling: { slotMinutes: number; minLeadMinutes: number; maxRangeDays: number; maxBookAheadDays: number };
  hours: WeeklyWindows;
  closedDates: { date: string; reason: string }[];
  staff: StaffMember[];
  services: Service[];
  faq: FaqEntry[];
  policies: { cancellationNoticeHours: number; lateCancelFeeUsd: number };
  urgent: {
    /** Where an emergency goes while open; after hours it always goes to phones.emergency when there is one. */
    routeWhenOpen: "front_desk" | "emergency_line";
    /** Strong patterns: transfer at once, nothing is booked. */
    rules: UrgentRule[];
    /** Weaker words: the agent offers a person. */
    ambiguous: string[];
    /** Questions the agent must not answer (medical, legal, safety advice). */
    adviceWords: string[];
    /** Told to a caller with an emergency, before the transfer. */
    emergencyMessage: string;
  };
  brand: { color: string; tagline: string };
}

const E164 = /^\+[1-9]\d{7,14}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function loadBusiness(dir: string): Business {
  const b = JSON.parse(readFileSync(join(dir, "business.json"), "utf8")) as Business;
  const problems = validateBusiness(b);
  if (problems.length > 0) throw new Error(`invalid business data in ${dir}:\n - ${problems.join("\n - ")}`);
  return b;
}

function checkWindows(label: string, windows: readonly Window[] | undefined, slotMinutes: number, problems: string[]): void {
  if (windows === undefined) return;
  if (!Array.isArray(windows)) {
    problems.push(`${label}: must be a list of [start, end] pairs`);
    return;
  }
  let previousEnd = -1;
  for (const w of windows) {
    if (!Array.isArray(w) || w.length !== 2) {
      problems.push(`${label}: ${JSON.stringify(w)} is not a [start, end] pair`);
      continue;
    }
    const a = parseHm(w[0]);
    const b = parseHm(w[1]);
    if (a === null || b === null) {
      problems.push(`${label}: bad time in ${JSON.stringify(w)}`);
      continue;
    }
    if (a % slotMinutes !== 0 || b % slotMinutes !== 0) problems.push(`${label}: ${w[0]}-${w[1]} is not on the ${slotMinutes}-minute grid`);
    if (a >= b) problems.push(`${label}: window ${w[0]}-${w[1]} ends before it starts`);
    if (a < previousEnd) problems.push(`${label}: windows overlap or are out of order`);
    previousEnd = b;
  }
}

/** Every cross-reference and range the code relies on. Empty means fine. */
export function validateBusiness(b: Business): string[] {
  const problems: string[] = [];
  if (typeof b !== "object" || b === null) return ["business.json must be an object"];
  if (!SLUG.test(String(b.slug))) problems.push("slug must be lower-case letters, digits and dashes");
  if (!b.name || typeof b.name !== "string") problems.push("name is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: b.timezone });
  } catch {
    problems.push(`unknown time zone ${b.timezone}`);
  }
  if (!b.phones || !E164.test(b.phones.frontDesk)) problems.push("phones.frontDesk must be E.164 (+15551234567)");
  if (b.phones?.emergency && !E164.test(b.phones.emergency.phone)) problems.push("phones.emergency.phone must be E.164");
  const s = b.scheduling;
  if (!s || !(s.slotMinutes > 0) || 60 % s.slotMinutes !== 0) problems.push("scheduling.slotMinutes must divide 60");
  if (s && !(s.minLeadMinutes >= 0)) problems.push("scheduling.minLeadMinutes must be 0 or more");
  if (s && !(s.maxRangeDays >= 1 && s.maxRangeDays <= 31)) problems.push("scheduling.maxRangeDays must be 1-31");
  if (s && !(s.maxBookAheadDays >= 1 && s.maxBookAheadDays <= 365)) problems.push("scheduling.maxBookAheadDays must be 1-365");
  if (problems.length > 0) return problems;

  for (const day of Object.keys(b.hours ?? {})) {
    if (!(DAY_KEYS as readonly string[]).includes(day)) problems.push(`hours: unknown day ${day} (use sun, mon, ...)`);
  }
  for (const day of DAY_KEYS) checkWindows(`hours.${day}`, b.hours[day], s.slotMinutes, problems);
  if (!DAY_KEYS.some((d) => (b.hours[d]?.length ?? 0) > 0)) problems.push("hours: the business is never open");
  const seenDates = new Set<string>();
  for (const c of b.closedDates ?? []) {
    if (!parseYmd(c.date)) problems.push(`closedDates: ${c.date} is not a real date`);
    if (seenDates.has(c.date)) problems.push(`closedDates: ${c.date} listed twice`);
    seenDates.add(c.date);
  }

  const serviceIds = new Set<string>();
  if (!Array.isArray(b.services) || b.services.length === 0) problems.push("at least one service is required");
  for (const sv of b.services ?? []) {
    if (!/^[a-z0-9_]{1,40}$/.test(sv.id)) problems.push(`service id ${sv.id}: use lower-case letters, digits and _`);
    if (serviceIds.has(sv.id)) problems.push(`duplicate service id ${sv.id}`);
    serviceIds.add(sv.id);
    if (!(sv.durationMinutes > 0) || sv.durationMinutes % s.slotMinutes !== 0) problems.push(`service ${sv.id}: duration must be a positive multiple of ${s.slotMinutes}`);
    if (!(sv.priceUsd >= 0)) problems.push(`service ${sv.id}: price must be 0 or more`);
    if (sv.depositUsd !== undefined && !(sv.depositUsd >= 0 && sv.depositUsd <= 1000)) problems.push(`service ${sv.id}: deposit must be 0-1000`);
    if (sv.depositUsd !== undefined && sv.depositUsd > 0 && sv.depositUsd < 1) problems.push(`service ${sv.id}: a deposit below $1 cannot be charged`);
    if (!Array.isArray(sv.keywords)) problems.push(`service ${sv.id}: keywords must be a list`);
  }

  const covered = new Set<string>();
  const staffIds = new Set<string>();
  if (!Array.isArray(b.staff) || b.staff.length === 0) problems.push("at least one staff member is required");
  for (const st of b.staff ?? []) {
    if (staffIds.has(st.id)) problems.push(`duplicate staff id ${st.id}`);
    staffIds.add(st.id);
    for (const sid of st.serviceIds) {
      if (!serviceIds.has(sid)) problems.push(`staff ${st.id}: unknown service ${sid}`);
      covered.add(sid);
    }
    for (const day of DAY_KEYS) {
      const windows = st.schedule[day];
      checkWindows(`staff ${st.id} ${day}`, windows, s.slotMinutes, problems);
      if (!windows || windows.length === 0) continue;
      const open = b.hours[day];
      if (!open || open.length === 0) {
        problems.push(`staff ${st.id} works on ${day}, when the business is closed`);
        continue;
      }
      for (const w of windows) {
        const a = parseHm(w[0]);
        const z = parseHm(w[1]);
        const inside = open.some((o) => {
          const oa = parseHm(o[0]);
          const ob = parseHm(o[1]);
          return a !== null && z !== null && oa !== null && ob !== null && a >= oa && z <= ob;
        });
        if (!inside) problems.push(`staff ${st.id} ${day}: ${w[0]}-${w[1]} is outside business hours`);
      }
    }
  }
  for (const sid of serviceIds) if (!covered.has(sid)) problems.push(`no staff member performs service ${sid}`);

  const faqIds = new Set<string>();
  for (const f of b.faq ?? []) {
    if (faqIds.has(f.id)) problems.push(`duplicate faq id ${f.id}`);
    faqIds.add(f.id);
    if (/\$\s?\d/.test(f.answer)) problems.push(`faq ${f.id}: write prices with {{price:<service id>}}, not literal dollar amounts`);
    for (const m of f.answer.matchAll(/\{\{(price|deposit):([a-z0-9_]+)\}\}/g)) {
      if (!serviceIds.has(m[2] as string)) problems.push(`faq ${f.id}: {{${m[1]}:${m[2]}}} names an unknown service`);
    }
  }
  if (!b.urgent || !Array.isArray(b.urgent.rules)) problems.push("urgent.rules is required (it may be an empty list)");
  else {
    for (const r of b.urgent.rules) {
      for (const p of r.phrases) if (p !== p.toLowerCase() || p.trim() !== p || p === "") problems.push(`urgent rule ${r.id}: phrase "${p}" must be lower-case and trimmed`);
    }
    if (b.urgent.routeWhenOpen !== "front_desk" && b.urgent.routeWhenOpen !== "emergency_line") problems.push("urgent.routeWhenOpen must be front_desk or emergency_line");
    if (b.urgent.routeWhenOpen === "emergency_line" && !b.phones.emergency) problems.push("urgent.routeWhenOpen is emergency_line but phones.emergency is missing");
  }
  if (!b.agent || !b.agent.name) problems.push("agent.name is required");
  if (b.fictional !== true && b.fictional !== false) problems.push("fictional must be true or false");
  return problems;
}

const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function findService(b: Business, input: string): Service | undefined {
  const needle = norm(input);
  if (!needle) return undefined;
  const raw = input.trim().toLowerCase();
  return (
    b.services.find((s) => s.id === raw) ??
    b.services.find((s) => norm(s.name) === needle) ??
    b.services.find((s) => s.keywords.some((k) => norm(k) === needle)) ??
    // "a cleaning appointment" / "teeth cleaning please": a keyword or the name contained in what was said
    b.services
      .map((s) => ({ s, len: Math.max(0, ...[s.name, ...s.keywords].map(norm).filter((k) => k.length >= 4 && ` ${needle} `.includes(` ${k} `)).map((k) => k.length)) }))
      .filter((x) => x.len > 0)
      .sort((x, y) => y.len - x.len)[0]?.s
  );
}

export function findStaff(b: Business, input: string): StaffMember | undefined {
  const needle = norm(input.replace(/^\s*(dr|doctor|mr|mrs|ms)\.?\s+/i, ""));
  if (!needle) return undefined;
  return b.staff.find((st) => {
    const parts = norm(st.name.replace(/^\s*(dr|doctor)\.?\s+/i, "")).split(" ");
    return st.id === needle || parts.includes(needle) || parts.join(" ") === needle || norm(st.short) === needle;
  });
}

export function staffFor(b: Business, service: Service, staffId?: string): StaffMember[] {
  return b.staff.filter((st) => st.serviceIds.includes(service.id) && (staffId === undefined || st.id === staffId));
}
