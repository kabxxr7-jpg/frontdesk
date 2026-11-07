// A short brief (name, services, hours, prices, FAQ) to a full business.json. The vertical picks the defaults a
// business owner would not think to write down: what counts as an emergency, which questions are advice, whether
// the job address is needed, what customers and visits are called.
import type { Business, FaqEntry, Service, StaffMember, UrgentRule, WeeklyWindows } from "./business.ts";
import { validateBusiness } from "./business.ts";

export interface Brief {
  name: string;
  vertical: string;
  fictional?: boolean;
  timezone: string;
  address: string;
  serviceArea?: string;
  frontDeskPhone: string;
  emergencyLine?: { name: string; phone: string };
  receptionistName?: string;
  brandColor?: string;
  tagline?: string;
  hours: WeeklyWindows;
  closedDates?: { date: string; reason: string }[];
  /** Optional. Without staff, one "team" member does every service during business hours. */
  staff?: { name: string; short?: string; title?: string; services?: string[]; schedule?: WeeklyWindows }[];
  services: { id?: string; name: string; description?: string; minutes: number; price: number; priceNote?: string; deposit?: number; keywords?: string[] }[];
  faq?: { topic: string; keywords?: string[]; answer: string }[];
  cancellationNoticeHours?: number;
  lateCancelFeeUsd?: number;
  slotMinutes?: number;
  minLeadMinutes?: number;
}

interface Preset {
  customerWord: string;
  visitWord: string;
  collectAddress: boolean;
  routeWhenOpen: "front_desk" | "emergency_line";
  rules: UrgentRule[];
  ambiguous: string[];
  adviceWords: string[];
  emergencyMessage: string;
  verticalWord: string;
}

const PRESETS: Record<string, Preset> = {
  dental: {
    customerWord: "patient",
    visitWord: "appointment",
    collectAddress: false,
    routeWhenOpen: "front_desk",
    verticalWord: "dental clinic",
    rules: [
      { id: "knocked_out_tooth", phrases: ["knocked out", "tooth fell out", "tooth came out", "lost a tooth", "knocked my tooth out"] },
      { id: "facial_swelling", phrases: ["face is swollen", "face is swelling", "swollen face", "swelling in my face", "jaw is swollen", "swollen jaw", "eye is swollen", "cheek is swollen", "swelling and fever", "fever and swelling"] },
      { id: "bleeding", phrases: ["will not stop bleeding", "bleeding will not stop", "cannot stop the bleeding", "bleeding a lot", "heavy bleeding", "bleeding heavily"] },
      { id: "airway", phrases: ["trouble breathing", "cannot breathe", "hard to breathe", "difficulty breathing", "trouble swallowing", "cannot swallow", "difficulty swallowing"] },
      { id: "trauma", phrases: ["broken jaw", "hit in the face", "car accident", "jaw is broken"] },
    ],
    ambiguous: ["toothache", "tooth pain", "pain", "swelling", "swollen", "bleeding", "broken tooth", "cracked tooth", "chipped", "abscess", "infection", "fever", "throbbing", "lost a filling", "crown fell off"],
    adviceWords: ["should i take", "antibiotic", "antibiotics", "ibuprofen", "tylenol", "painkiller", "painkillers", "dose", "dosage", "is it infected", "diagnose", "what medicine"],
    emergencyMessage: "That sounds like it needs urgent care. If you have trouble breathing or swallowing, or bleeding that will not stop, please hang up and call 911.",
  },
  plumbing: {
    customerWord: "customer",
    visitWord: "job",
    collectAddress: true,
    routeWhenOpen: "front_desk",
    verticalWord: "plumbing company",
    rules: [
      { id: "gas", phrases: ["smell gas", "gas smell", "gas leak", "smells like gas", "smell of gas", "rotten eggs"] },
      { id: "flooding", phrases: ["burst pipe", "pipe burst", "pipe has burst", "flooding", "water everywhere", "house is flooding", "basement is flooding", "water pouring", "ceiling is leaking"] },
      { id: "sewage", phrases: ["sewage backup", "sewage coming up", "sewer backup", "raw sewage"] },
      { id: "no_water_heat", phrases: ["water heater is leaking", "water heater leaking", "carbon monoxide"] },
      { id: "electrical_water", phrases: ["water near the electrical", "water in the panel", "sparking"] },
    ],
    ambiguous: ["leak", "leaking", "drip", "dripping", "clog", "clogged", "no hot water", "backed up", "overflow", "overflowing", "water heater", "low pressure"],
    adviceWords: ["is it safe", "can i fix", "how do i fix", "diy", "should i turn off", "is it legal", "permit"],
    emergencyMessage: "That sounds like an emergency. If you smell gas, leave the building now and call 911 or your gas company from outside. If water is pouring, turn off the main water valve if you can do it safely.",
  },
  hvac: {
    customerWord: "customer",
    visitWord: "job",
    collectAddress: true,
    routeWhenOpen: "front_desk",
    verticalWord: "heating and cooling company",
    rules: [
      { id: "gas", phrases: ["smell gas", "gas smell", "gas leak", "smells like gas", "rotten eggs"] },
      { id: "co", phrases: ["carbon monoxide", "co alarm", "co detector"] },
      { id: "fire", phrases: ["smoke coming", "burning smell", "sparks", "on fire"] },
      { id: "no_heat_freezing", phrases: ["no heat and freezing", "no heat with a baby", "pipes freezing"] },
    ],
    ambiguous: ["no heat", "no ac", "not cooling", "not heating", "strange noise", "leaking", "furnace", "thermostat"],
    adviceWords: ["is it safe", "can i fix", "how do i fix", "diy", "reset"],
    emergencyMessage: "That sounds like an emergency. If you smell gas or a carbon monoxide alarm is sounding, leave the building now and call 911 from outside.",
  },
  generic: {
    customerWord: "client",
    visitWord: "appointment",
    collectAddress: false,
    routeWhenOpen: "front_desk",
    verticalWord: "business",
    rules: [{ id: "danger", phrases: ["emergency", "call 911", "someone is hurt", "fire"] }],
    ambiguous: ["urgent", "complaint", "problem", "refund"],
    adviceWords: ["legal advice", "medical advice", "diagnose"],
    emergencyMessage: "If anyone is in danger, please hang up and call 911.",
  },
};

export const VERTICALS = Object.keys(PRESETS);

export function slugify(name: string): string {
  return name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

function serviceId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (/^dr\.?$/i.test(parts[0] ?? "")) return `Dr. ${parts[parts.length - 1]}`;
  return parts[0] ?? name;
}

export function buildBusiness(brief: Brief): { business: Business; problems: string[] } {
  const preset = PRESETS[brief.vertical] ?? (PRESETS["generic"] as Preset);
  const services: Service[] = brief.services.map((s) => ({
    id: s.id ?? serviceId(s.name),
    name: s.name,
    description: s.description ?? `${s.name}.`,
    durationMinutes: s.minutes,
    priceUsd: s.price,
    ...(s.priceNote ? { priceNote: s.priceNote } : {}),
    ...(s.deposit ? { depositUsd: s.deposit } : {}),
    keywords: [...new Set([s.name.toLowerCase(), ...(s.keywords ?? []).map((k) => k.toLowerCase())])],
  }));
  const allIds = services.map((s) => s.id);
  const staff: StaffMember[] = (brief.staff && brief.staff.length > 0 ? brief.staff : [{ name: "Our team", short: "our team", title: "team", services: allIds, schedule: brief.hours }]).map((st, i) => ({
    id: slugify(st.name.replace(/^dr\.?\s+/i, "")) || `staff-${i + 1}`,
    name: st.name,
    short: st.short ?? shortName(st.name),
    title: st.title ?? "team member",
    serviceIds: st.services ?? allIds,
    schedule: st.schedule ?? brief.hours,
  }));
  const faq: FaqEntry[] = [
    { id: "hours", topic: "Hours", keywords: ["hours", "open", "close", "closing", "opening", "what time", "when are you open", "weekend", "saturday", "sunday"], answer: "{{hours}}" },
    { id: "services_prices", topic: "Services and prices", keywords: ["services", "prices", "price list", "how much", "cost", "what do you offer", "what do you do"], answer: "We offer {{services}}." },
    ...(brief.faq ?? []).map((f, i) => ({ id: serviceId(f.topic) || `faq_${i + 1}`, topic: f.topic, keywords: (f.keywords ?? [f.topic]).map((k) => k.toLowerCase()), answer: f.answer })),
  ];
  if (preset.collectAddress && brief.serviceArea && !faq.some((f) => f.id === "service_area")) {
    faq.push({ id: "service_area", topic: "Service area", keywords: ["service area", "do you come to", "do you cover", "areas", "near me", "travel"], answer: "We cover {{service_area}}." });
  }
  const business: Business = {
    slug: slugify(brief.name),
    name: brief.name,
    vertical: preset.verticalWord,
    fictional: brief.fictional ?? true,
    fictionNote: (brief.fictional ?? true)
      ? `${brief.name} is a fictional business made for a demonstration. Its name, address, phone numbers, staff and prices are invented.`
      : "",
    timezone: brief.timezone,
    address: brief.address,
    ...(brief.serviceArea ? { serviceArea: brief.serviceArea } : {}),
    phones: { frontDesk: brief.frontDeskPhone, ...(brief.emergencyLine ? { emergency: brief.emergencyLine } : {}) },
    agent: { name: brief.receptionistName ?? "Ava", customerWord: preset.customerWord, visitWord: preset.visitWord, collectAddress: preset.collectAddress },
    scheduling: { slotMinutes: brief.slotMinutes ?? 30, minLeadMinutes: brief.minLeadMinutes ?? 60, maxRangeDays: 14, maxBookAheadDays: 90 },
    hours: brief.hours,
    closedDates: brief.closedDates ?? [],
    staff,
    services,
    faq,
    policies: { cancellationNoticeHours: brief.cancellationNoticeHours ?? 24, lateCancelFeeUsd: brief.lateCancelFeeUsd ?? 0 },
    urgent: { routeWhenOpen: preset.routeWhenOpen, rules: preset.rules, ambiguous: preset.ambiguous, adviceWords: preset.adviceWords, emergencyMessage: preset.emergencyMessage },
    brand: { color: brief.brandColor ?? "#0f766e", tagline: brief.tagline ?? `${brief.name}` },
  };
  if (!brief.emergencyLine && business.urgent.routeWhenOpen === "emergency_line") business.urgent.routeWhenOpen = "front_desk";
  return { business, problems: validateBusiness(business) };
}

/** Problems with the brief itself, in words a person can fix. */
export function checkBrief(raw: unknown): string[] {
  const p: string[] = [];
  if (typeof raw !== "object" || raw === null) return ["the brief must be a JSON object"];
  const b = raw as Partial<Brief>;
  if (!b.name) p.push("name is missing");
  if (!b.timezone) p.push("timezone is missing (for example America/New_York)");
  if (!b.address) p.push("address is missing");
  if (!b.frontDeskPhone) p.push("frontDeskPhone is missing (E.164, for example +12015550100)");
  if (!b.hours) p.push("hours is missing");
  if (!Array.isArray(b.services) || b.services.length === 0) p.push("services is missing or empty");
  for (const [i, s] of (b.services ?? []).entries()) {
    if (!s.name) p.push(`services[${i}]: name is missing`);
    if (typeof s.minutes !== "number") p.push(`services[${i}] (${s.name ?? "?"}): minutes must be a number`);
    if (typeof s.price !== "number") p.push(`services[${i}] (${s.name ?? "?"}): price must be a number (0 for free)`);
  }
  if (b.vertical && !VERTICALS.includes(b.vertical)) p.push(`vertical "${b.vertical}" is unknown; use one of ${VERTICALS.join(", ")} (generic works for anything)`);
  return p;
}
