import { describe, expect, it } from "vitest";
import { loadBusiness } from "../src/business.ts";
import { classifyUrgent } from "../src/urgent.ts";

const dental = loadBusiness("businesses/brightside-family-dental");
const label = (t: string) => classifyUrgent(dental, t).label;

describe("dental urgent classifier", () => {
  it.each([
    "my son's tooth got knocked out",
    "her face is swollen and hot",
    "the bleeding won't stop after my extraction",
    "I can't breathe properly since the swelling started",
    "he was hit in the face with a bat",
  ])("emergency: %s", (t) => expect(label(t)).toBe("emergency"));
  it.each(["I have a toothache", "my crown fell off", "a bit of swelling on the gum", "chipped a tooth on popcorn"])("ambiguous: %s", (t) => expect(label(t)).toBe("ambiguous"));
  it.each(["I want a cleaning next week", "do you take Cigna", ""])("non emergency: %s", (t) => expect(label(t)).toBe("non_emergency"));
  it("negation weakens a strong phrase to ambiguous", () => {
    expect(label("there is no heavy bleeding")).toBe("ambiguous");
    expect(label("not having trouble breathing")).toBe("ambiguous");
  });
  it("negation does not leak across a clause break", () => {
    expect(label("no pain, but my face is swollen")).toBe("emergency");
  });
  it("past events are weakened", () => {
    expect(label("I had a tooth knocked out years ago")).toBe("ambiguous");
  });
});
