// Small input-validation helpers. Every failure is a spoken-style message the voice agent can read to the caller
// as is ("I did not catch a valid date"), plus a short `hint` for the model about how to fix its next call.
import { offsetMinutesAt, parseYmd, zonedToUtc, type Ymd } from "./time.ts";

export interface SpokenError {
  ok: false;
  error: string;
  /** What the agent can say to the caller. */
  message: string;
  /** What the model should change in its next tool call. */
  hint?: string;
  field?: string;
  [extra: string]: unknown;
}

export function fail(error: string, message: string, extra: { hint?: string; field?: string; [k: string]: unknown } = {}): SpokenError {
  return { ok: false, error, message, ...extra };
}

export type Parsed<T> = { ok: true; value: T } | SpokenError;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Control characters, zero-width characters and bidi overrides have no place in a name or a note.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g;

export function cleanText(input: string): string {
  return input.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
}

export interface TextRule {
  label: string;
  /** Spoken label used in "I still need ...". */
  needs?: string;
  min?: number;
  max: number;
  pattern?: RegExp;
  patternMessage?: string;
}

/** Reads an optional-or-required string argument. `undefined` means absent (and not an error). */
export function readText(args: Record<string, unknown>, key: string, rule: TextRule): Parsed<string | undefined> {
  const raw = args[key];
  if (raw === undefined || raw === null || (typeof raw === "string" && cleanText(raw) === "")) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return fail(`invalid_${key}`, `I did not catch ${rule.label}. Could you say that again?`, { field: key, hint: `${key} must be a string` });
  }
  const value = cleanText(raw);
  if (value.length < (rule.min ?? 1)) {
    return fail(`invalid_${key}`, `That ${rule.label} seems too short. Could you say it again?`, { field: key });
  }
  if (value.length > rule.max) {
    return fail(`invalid_${key}`, `That ${rule.label} is too long for me to take down. Could you shorten it?`, { field: key, hint: `${key} is at most ${rule.max} characters` });
  }
  if (rule.pattern && !rule.pattern.test(value)) {
    return fail(`invalid_${key}`, rule.patternMessage ?? `I could not use that ${rule.label}. Could you spell it for me?`, { field: key });
  }
  return { ok: true, value };
}

/** Collects every missing required field into one spoken sentence. */
export function missingFields(values: [label: string, v: unknown][]): SpokenError | null {
  const missing = values.filter(([, v]) => v === undefined).map(([label]) => label);
  if (missing.length === 0) return null;
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return fail("missing_fields", `I still need ${list}.`, { hint: `required: ${missing.join("; ")}`, missing });
}

export const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '’.\-]*$/u;

/** US/Canada numbers (10 digits, or 11 starting with 1) or an international number with a leading +. Returns E.164 or null. */
export function normalizePhone(input: string): string | null {
  const trimmed = cleanText(input);
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
    return `+${digits}`;
  }
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && /^[2-9]/.test(digits.slice(1))) return `+${digits}`;
  return null;
}

export function readPhone(args: Record<string, unknown>, key: string): Parsed<string | undefined> {
  const raw = args[key];
  if (raw === undefined || raw === null || (typeof raw === "string" && cleanText(raw) === "")) return { ok: true, value: undefined };
  if (typeof raw !== "string" && typeof raw !== "number") {
    return fail(`invalid_${key}`, "I did not catch the phone number. Could you read it to me again, with the area code?", { field: key });
  }
  const e164 = normalizePhone(String(raw));
  if (!e164) {
    return fail(
      `invalid_${key}`,
      "I did not catch a full phone number. Could you read it to me again, including the area code?",
      { field: key, hint: "send 10 digits (US) or a +country-code number" },
    );
  }
  return { ok: true, value: e164 };
}

export function readDate(args: Record<string, unknown>, key: string, label: string): Parsed<Ymd | undefined> {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return fail(`invalid_${key}`, `I did not catch ${label}. Which day did you have in mind?`, { field: key, hint: `${key} must be a string like 2026-11-03` });
  }
  const ymd = parseYmd(raw.trim());
  if (!ymd) {
    return fail(`invalid_${key}`, `I did not catch a valid date for ${label}. Which day did you have in mind?`, {
      field: key,
      hint: `${key} must be a real calendar date formatted YYYY-MM-DD`,
    });
  }
  return { ok: true, value: ymd };
}

const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Reads a start time. `2026-11-03T09:00` is wall-clock time in the clinic's zone. With an offset (`-08:00`, `Z`)
 * the offset must be the one the clinic's zone has at that moment; otherwise the model hard-coded the wrong
 * offset across a DST change and the appointment would silently land an hour off.
 */
export function readStart(args: Record<string, unknown>, key: string, timeZone: string, label: string): Parsed<number | undefined> {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  const bad = (hint: string) =>
    fail(`invalid_${key}`, `I did not catch a valid day and time for ${label}. Which day and time would you like?`, { field: key, hint });
  if (typeof raw !== "string") return bad(`${key} must be a string like 2026-11-03T09:00`);
  const m = LOCAL_DATETIME.exec(raw.trim());
  if (!m) return bad(`${key} must look like 2026-11-03T09:00 (clinic local time) or include an offset`);
  const ymd = parseYmd(m[1] as string);
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  const ss = Number(m[4] ?? "0");
  if (!ymd || hh > 23 || mm > 59 || ss > 59) return bad(`${key} is not a real date and time`);
  const offsetText = m[5];

  if (offsetText === undefined) {
    const z = zonedToUtc(ymd, hh * 60 + mm, timeZone);
    if (z.kind === "gap") {
      return fail(
        `nonexistent_${key}`,
        "That clock time does not exist on that date because the clocks change. Could we pick a different time?",
        { field: key, hint: "that wall-clock time is skipped by the daylight saving change" },
      );
    }
    return { ok: true, value: z.utcMs + ss * 1000 };
  }

  const isUtc = offsetText.toUpperCase() === "Z";
  let offsetMinutes = 0;
  if (!isUtc) {
    const sign = offsetText.startsWith("-") ? -1 : 1;
    const digits = offsetText.slice(1).replace(":", "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  const utcMs = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hh, mm, ss) - offsetMinutes * 60_000;
  // "Z" is an exact instant and always fine. Any other offset must be the one the clinic's zone really has at
  // that instant; a hard-coded -08:00 in July (or in the week after "spring forward") would otherwise book an hour off.
  if (!isUtc) {
    const actual = offsetMinutesAt(utcMs, timeZone);
    if (offsetMinutes !== actual) {
      return fail(
        `wrong_offset_${key}`,
        "I think the time zone got mixed up on that time. Let me ask again: which day and time would you like?",
        { field: key, hint: `the clinic's offset at that instant is ${actual / 60} hours; send the local time without an offset instead` },
      );
    }
  }
  return { ok: true, value: utcMs };
}
