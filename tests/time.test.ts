import { describe, expect, it } from "vitest";
import {
  addDays, compareYmd, dayKeyOf, daysBetween, formatOffset, formatYmd, localParts, localYmd, minutesOfDayLocal,
  offsetMinutesAt, ordinal, parseHm, parseYmd, spokenDate, spokenDateTime, spokenTime, toIsoWithOffset, weekdayIndex,
  zonedToUtc,
} from "../src/time.ts";

const TZ = "America/Los_Angeles";
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe("parseYmd", () => {
  it("accepts real dates", () => {
    expect(parseYmd("2026-11-01")).toEqual({ y: 2026, m: 11, d: 1 });
    expect(parseYmd("2028-02-29")).toEqual({ y: 2028, m: 2, d: 29 });
  });
  it.each(["2027-02-29", "2026-13-01", "2026-00-10", "2026-11-00", "2026-11-31", "2026-1-5", " 2026-11-01", "2026-11-01 ", "tomorrow", "", "11/01/2026", "2026-11-01T09:00"])(
    "rejects %j",
    (text) => {
      expect(parseYmd(text)).toBeNull();
    },
  );
});

describe("calendar arithmetic", () => {
  it("adds days across month, year and leap day", () => {
    expect(formatYmd(addDays({ y: 2026, m: 12, d: 31 }, 1))).toBe("2027-01-01");
    expect(formatYmd(addDays({ y: 2028, m: 2, d: 28 }, 1))).toBe("2028-02-29");
    expect(formatYmd(addDays({ y: 2027, m: 3, d: 1 }, -1))).toBe("2027-02-28");
    expect(formatYmd(addDays({ y: 2027, m: 3, d: 13 }, 2))).toBe("2027-03-15");
  });
  it("counts calendar days, ignoring DST", () => {
    expect(daysBetween({ y: 2027, m: 3, d: 13 }, { y: 2027, m: 3, d: 15 })).toBe(2);
    expect(daysBetween({ y: 2026, m: 10, d: 31 }, { y: 2026, m: 11, d: 2 })).toBe(2);
    expect(compareYmd({ y: 2027, m: 1, d: 2 }, { y: 2027, m: 1, d: 1 })).toBeGreaterThan(0);
  });
  it("knows weekdays", () => {
    expect(dayKeyOf({ y: 2026, m: 11, d: 1 })).toBe("sun");
    expect(dayKeyOf({ y: 2027, m: 3, d: 14 })).toBe("sun");
    expect(dayKeyOf({ y: 2026, m: 11, d: 26 })).toBe("thu");
    expect(weekdayIndex({ y: 2026, m: 11, d: 2 })).toBe(1);
  });
  it("parses clock text", () => {
    expect(parseHm("08:30")).toBe(510);
    expect(parseHm("24:00")).toBe(1440);
    expect(parseHm("24:01")).toBeNull();
    expect(parseHm("12:60")).toBeNull();
    expect(parseHm("8:30")).toBeNull();
  });
});

describe("Pacific offsets and DST", () => {
  it("uses -08:00 in winter and -07:00 in summer", () => {
    expect(offsetMinutesAt(utc(2026, 12, 15, 12), TZ)).toBe(-480);
    expect(offsetMinutesAt(utc(2027, 7, 15, 12), TZ)).toBe(-420);
  });

  it("switches offset exactly at 02:00 local on the spring-forward day (2027-03-14 10:00Z)", () => {
    expect(offsetMinutesAt(utc(2027, 3, 14, 9, 59), TZ)).toBe(-480);
    expect(offsetMinutesAt(utc(2027, 3, 14, 10, 0), TZ)).toBe(-420);
  });

  it("switches back at 02:00 PDT = 09:00Z on the fall-back day (2026-11-01)", () => {
    expect(offsetMinutesAt(utc(2026, 11, 1, 8, 59), TZ)).toBe(-420);
    expect(offsetMinutesAt(utc(2026, 11, 1, 9, 0), TZ)).toBe(-480);
  });

  it("converts a 09:00 appointment correctly on both sides of spring-forward", () => {
    expect(zonedToUtc({ y: 2027, m: 3, d: 13 }, 9 * 60, TZ)).toEqual({ kind: "ok", utcMs: utc(2027, 3, 13, 17) });
    expect(zonedToUtc({ y: 2027, m: 3, d: 14 }, 9 * 60, TZ)).toEqual({ kind: "ok", utcMs: utc(2027, 3, 14, 16) });
    expect(zonedToUtc({ y: 2027, m: 3, d: 15 }, 9 * 60, TZ)).toEqual({ kind: "ok", utcMs: utc(2027, 3, 15, 16) });
  });

  it("converts a 09:00 appointment correctly on both sides of fall-back", () => {
    expect(zonedToUtc({ y: 2026, m: 10, d: 31 }, 9 * 60, TZ)).toEqual({ kind: "ok", utcMs: utc(2026, 10, 31, 16) });
    expect(zonedToUtc({ y: 2026, m: 11, d: 1 }, 9 * 60, TZ)).toEqual({ kind: "ok", utcMs: utc(2026, 11, 1, 17) });
    expect(zonedToUtc({ y: 2026, m: 11, d: 2 }, 9 * 60, TZ)).toEqual({ kind: "ok", utcMs: utc(2026, 11, 2, 17) });
  });

  it("reports the skipped hour on spring-forward as a gap", () => {
    expect(zonedToUtc({ y: 2027, m: 3, d: 14 }, 2 * 60, TZ).kind).toBe("gap");
    expect(zonedToUtc({ y: 2027, m: 3, d: 14 }, 2 * 60 + 30, TZ).kind).toBe("gap");
    expect(zonedToUtc({ y: 2027, m: 3, d: 14 }, 1 * 60 + 59, TZ)).toEqual({ kind: "ok", utcMs: utc(2027, 3, 14, 9, 59) });
    expect(zonedToUtc({ y: 2027, m: 3, d: 14 }, 3 * 60, TZ)).toEqual({ kind: "ok", utcMs: utc(2027, 3, 14, 10, 0) });
  });

  it("reports the repeated hour on fall-back as ambiguous and returns the first occurrence", () => {
    const r = zonedToUtc({ y: 2026, m: 11, d: 1 }, 1 * 60 + 30, TZ);
    expect(r).toEqual({ kind: "ambiguous", utcMs: utc(2026, 11, 1, 8, 30), secondUtcMs: utc(2026, 11, 1, 9, 30) });
    expect(zonedToUtc({ y: 2026, m: 11, d: 1 }, 2 * 60, TZ)).toEqual({ kind: "ok", utcMs: utc(2026, 11, 1, 10, 0) });
  });

  it("has 23-hour and 25-hour local days on the DST days", () => {
    const len = (ymd: { y: number; m: number; d: number }) => {
      const a = zonedToUtc(ymd, 0, TZ);
      const b = zonedToUtc(addDays(ymd, 1), 0, TZ);
      if (a.kind !== "ok" || b.kind !== "ok") throw new Error("midnight should exist");
      return (b.utcMs - a.utcMs) / 3_600_000;
    };
    expect(len({ y: 2027, m: 3, d: 14 })).toBe(23);
    expect(len({ y: 2026, m: 11, d: 1 })).toBe(25);
    expect(len({ y: 2027, m: 3, d: 15 })).toBe(24);
  });

  it("round-trips instants through local parts", () => {
    const t = utc(2027, 3, 14, 16, 0);
    expect(localParts(t, TZ)).toMatchObject({ y: 2027, m: 3, d: 14, hh: 9, mm: 0, weekday: 0 });
    expect(localYmd(utc(2026, 11, 2, 7, 59), TZ)).toEqual({ y: 2026, m: 11, d: 1 });
    expect(localYmd(utc(2026, 11, 2, 8, 0), TZ)).toEqual({ y: 2026, m: 11, d: 2 });
    expect(minutesOfDayLocal(utc(2027, 7, 1, 23, 30), TZ)).toBe(16 * 60 + 30);
  });

  it("formats ISO strings with the offset that applies", () => {
    expect(toIsoWithOffset(utc(2027, 3, 14, 16), TZ)).toBe("2027-03-14T09:00:00-07:00");
    expect(toIsoWithOffset(utc(2027, 3, 13, 17), TZ)).toBe("2027-03-13T09:00:00-08:00");
    expect(formatOffset(-480)).toBe("-08:00");
    expect(formatOffset(330)).toBe("+05:30");
  });

  it("works for another zone too (Asia/Kolkata has no DST and a half-hour offset)", () => {
    expect(offsetMinutesAt(utc(2026, 11, 1), "Asia/Kolkata")).toBe(330);
    expect(zonedToUtc({ y: 2026, m: 11, d: 1 }, 9 * 60, "Asia/Kolkata")).toEqual({ kind: "ok", utcMs: utc(2026, 11, 1, 3, 30) });
  });
});

describe("speech formatting", () => {
  it("builds ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30, 31].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "30th", "31st",
    ]);
  });
  it("speaks times and dates without locale surprises", () => {
    expect(spokenTime(0, 5)).toBe("12:05 AM");
    expect(spokenTime(9, 0)).toBe("9:00 AM");
    expect(spokenTime(12, 30)).toBe("12:30 PM");
    expect(spokenTime(17, 45)).toBe("5:45 PM");
    expect(spokenDate({ y: 2026, m: 11, d: 3 })).toBe("Tuesday, November 3rd");
    expect(spokenDateTime(utc(2027, 3, 14, 16), TZ)).toBe("Sunday, March 14th at 9:00 AM");
  });
});
