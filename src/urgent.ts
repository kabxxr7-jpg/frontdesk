// A deterministic emergency backstop that runs in our code, so an emergency never depends on a language model
// remembering a rule in its prompt. The phrases come from business.json (a dental clinic and a plumber have
// different emergencies). It is a routing aid, not triage, and it will miss wordings its phrases do not cover.
//
//   emergency      a strong phrase matched and nothing weakened it: transfer at once, book nothing
//   ambiguous      a weaker word, or a strong phrase that was negated ("no swelling") or in the past: offer a person
//   non_emergency  nothing matched
import type { Business } from "./business.ts";

export type UrgentLabel = "emergency" | "ambiguous" | "non_emergency";

export interface UrgentHit {
  rule: string;
  phrase: string;
  weakenedBy?: "negated" | "historical";
}

export interface UrgentResult {
  label: UrgentLabel;
  hits: UrgentHit[];
}

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan'?t\b/g, "cannot"],
  [/\bwon'?t\b/g, "will not"],
  [/\b(do|does|did|is|are|was|were|has|have|had|could|would|should)n'?t\b/g, "$1 not"],
  [/'s\b/g, " is"],
  [/'re\b/g, " are"],
  [/'m\b/g, " am"],
];

/** Lower case, contractions expanded, punctuation and "but" turned into clause breaks ("|"). */
export function normalize(input: string): string {
  let t = input.normalize("NFKC").toLowerCase().replace(/[‘’ʼ`´]/g, "'");
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  t = t.replace(/'/g, "").replace(/[.;!?,:()]+/g, " | ").replace(/\b(but|however|although|though)\b/g, " | ");
  return t.replace(/[^a-z0-9| ]+/g, " ").replace(/\s+/g, " ").trim();
}

const NEGATIONS = new Set(["no", "not", "never", "without", "cannot", "nothing", "none", "isnt", "nobody"]);
const PAST = /\b(last (year|month|week)|years ago|months ago|weeks ago|used to|in the past|previously|history of|had (a|an) .{0,20}(once|before))\b/;

function findPhrase(text: string, phrase: string): number {
  const re = new RegExp(`(^|[ |])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[ |])`);
  const m = re.exec(text);
  return m ? m.index + (m[1] as string).length : -1;
}

/** Up to four words before the match, inside the same clause. */
function negatedBefore(text: string, at: number): boolean {
  const before = text.slice(0, at);
  const clause = before.slice(before.lastIndexOf("|") + 1).trim();
  const words = clause.split(" ").filter(Boolean).slice(-4);
  return words.some((w) => NEGATIONS.has(w));
}

export function classifyUrgent(b: Business, input: string): UrgentResult {
  const text = normalize(input);
  if (text === "") return { label: "non_emergency", hits: [] };
  const hits: UrgentHit[] = [];
  for (const rule of b.urgent.rules) {
    for (const phrase of rule.phrases) {
      const at = findPhrase(text, normalize(phrase));
      if (at < 0) continue;
      const clauseStart = text.lastIndexOf("|", at) + 1;
      const clauseEnd = text.indexOf("|", at);
      const clause = text.slice(clauseStart, clauseEnd < 0 ? undefined : clauseEnd);
      const weakenedBy = negatedBefore(text, at) ? "negated" : PAST.test(clause) ? "historical" : undefined;
      hits.push({ rule: rule.id, phrase, ...(weakenedBy ? { weakenedBy } : {}) });
    }
  }
  for (const phrase of b.urgent.ambiguous) {
    if (findPhrase(text, normalize(phrase)) >= 0) hits.push({ rule: "ambiguous", phrase });
  }
  if (hits.some((h) => h.rule !== "ambiguous" && !h.weakenedBy)) return { label: "emergency", hits };
  if (hits.length > 0) return { label: "ambiguous", hits };
  return { label: "non_emergency", hits };
}
