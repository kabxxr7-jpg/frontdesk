// Spoken-style text from the business data: hours, prices, lists, the FAQ answers. Deterministic: the same question
// always gets the same answer, and a price can only come from business.json.
import type { Business, Service } from "./business.ts";
import { parseHm, spokenTime } from "./time.ts";

export function usd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export function joinList(items: string[], conjunction = "and"): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items[items.length - 1]}`;
}

/** +12065550100 to (206) 555-0100 for North American numbers; anything else as is. */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAME: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

function clockWord(hm: string): string {
  const minutes = parseHm(hm) ?? 0;
  return spokenTime(Math.floor(minutes / 60), minutes % 60);
}

/** "We are open Monday through Friday from 8:00 AM to 5:00 PM, and Saturday from 9:00 AM to 1:00 PM. We are closed on Sunday." */
export function renderHours(b: Business): string {
  const groups: { days: string[]; windows: string }[] = [];
  for (const day of DAY_ORDER) {
    const windows = b.hours[day];
    if (!windows || windows.length === 0) continue;
    const text = joinList(windows.map((w) => `${clockWord(w[0])} to ${clockWord(w[1])}`));
    const last = groups[groups.length - 1];
    const prev = last?.days[last.days.length - 1];
    const adjacent = prev !== undefined && DAY_ORDER.indexOf(prev as (typeof DAY_ORDER)[number]) === DAY_ORDER.indexOf(day) - 1;
    if (last && last.windows === text && adjacent) last.days.push(day);
    else groups.push({ days: [day], windows: text });
  }
  const parts = groups.map((g) => {
    const first = DAY_NAME[g.days[0] as string] as string;
    const lastDay = DAY_NAME[g.days[g.days.length - 1] as string] as string;
    const days = g.days.length === 1 ? first : g.days.length === 2 ? `${first} and ${lastDay}` : `${first} through ${lastDay}`;
    return `${days} from ${g.windows}`;
  });
  const closedDays = DAY_ORDER.filter((d) => !(b.hours[d]?.length)).map((d) => DAY_NAME[d] as string);
  return `We are open ${joinList(parts)}.${closedDays.length > 0 ? ` We are closed on ${joinList(closedDays)}.` : ""}`;
}

export function priceText(s: Service): string {
  if (s.priceUsd === 0) return "free";
  return `${usd(s.priceUsd)}${s.priceNote ? ` (${s.priceNote})` : ""}`;
}

export function renderServiceLine(s: Service): string {
  const deposit = s.depositUsd && s.depositUsd > 0 ? `, ${usd(s.depositUsd)} deposit to hold the time` : "";
  return `${s.name}: ${priceText(s)}, about ${s.durationMinutes} minutes${deposit}`;
}

export function renderServices(b: Business): string {
  return joinList(b.services.map((s) => `${s.name.toLowerCase()} (${priceText(s)})`));
}

export function renderTokens(text: string, b: Business): string {
  return text
    .replace(/\{\{hours\}\}/g, renderHours(b))
    .replace(/\{\{address\}\}/g, b.address)
    .replace(/\{\{phone\}\}/g, formatPhone(b.phones.frontDesk))
    .replace(/\{\{services\}\}/g, renderServices(b))
    .replace(/\{\{cancel_hours\}\}/g, String(b.policies.cancellationNoticeHours))
    .replace(/\{\{late_fee\}\}/g, usd(b.policies.lateCancelFeeUsd))
    .replace(/\{\{service_area\}\}/g, b.serviceArea ?? b.address)
    .replace(/\{\{price:([a-z0-9_]+)\}\}/g, (_, id: string) => {
      const s = b.services.find((x) => x.id === id);
      return s ? priceText(s) : "";
    })
    .replace(/\{\{deposit:([a-z0-9_]+)\}\}/g, (_, id: string) => {
      const s = b.services.find((x) => x.id === id);
      return s?.depositUsd ? usd(s.depositUsd) : "no deposit";
    });
}

// ---------------------------------------------------------------- FAQ matching

const STOP = new Set(
  "a an the is are am do does did you your yours we our i me my to of for in on at and or can could would will what whats how much many when where which who it its this that there be have has with about any please tell know like get".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

export interface FaqHit {
  kind: "faq" | "service";
  id: string;
  topic: string;
  answer: string;
  score: number;
}

/** Scores every FAQ entry and service by keyword phrases (strong) and shared words (weak). Null when nothing fits. */
export function matchFaq(b: Business, question: string): FaqHit | null {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const qTokens = new Set(tokenize(question));
  const candidates: FaqHit[] = [];
  const score = (keywords: string[], topic: string): number => {
    let sc = 0;
    for (const k of keywords) {
      const kn = k.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
      if (kn && q.includes(` ${kn} `)) sc += 3 + kn.split(" ").length;
    }
    for (const t of tokenize(`${topic} ${keywords.join(" ")}`)) if (qTokens.has(t)) sc += 1;
    return sc;
  };
  for (const f of b.faq) candidates.push({ kind: "faq", id: f.id, topic: f.topic, answer: renderTokens(f.answer, b), score: score(f.keywords, f.topic) });
  for (const s of b.services) {
    const answer = `${s.name}: ${s.description} It is ${priceText(s)} and takes about ${s.durationMinutes} minutes.${s.depositUsd ? ` We take a ${usd(s.depositUsd)} deposit by card to hold the time; the link comes in the confirmation email.` : ""}`;
    candidates.push({ kind: "service", id: s.id, topic: s.name, answer, score: score([...s.keywords, s.name], s.name) });
  }
  candidates.sort((x, y) => y.score - x.score);
  const best = candidates[0];
  if (!best || best.score < 2) return null;
  return best;
}

export function looksLikeAdvice(b: Business, question: string): boolean {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ")} `;
  return b.urgent.adviceWords.some((w) => q.includes(` ${w} `));
}
