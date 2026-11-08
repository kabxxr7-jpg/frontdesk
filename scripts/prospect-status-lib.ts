// Pure helpers for `npm run prospect:status` (kept apart from the script so tests can use them).

export interface PageOpens {
  /** Opens by people: GET of the page through the tunnel, answered 200, not a link-preview bot or script. */
  count: number;
  first?: string;
  last?: string;
  /** Requests left out: checks from this machine and link-preview bots. */
  skipped: number;
}

/**
 * Reads server log lines like "2026-11-08T13:15:10.921Z GET /demos/<slug>/ 200 [local] [bot]" (tags written by
 * requestTags in src/server.ts). Lines from before the tags existed carry none and count as opens.
 */
export function pageOpens(log: string, slug: string): PageOpens {
  const esc = slug.replace(/[^a-z0-9-]/g, "");
  const re = new RegExp(`^(\\d{4}-\\d\\d-\\d\\dT\\S+Z) (?:\\[[^\\]]+\\] )?GET /demos/${esc}/?(?:\\?\\S*)? (\\d{3})((?: \\w+)*)\\s*$`);
  const out: PageOpens = { count: 0, skipped: 0 };
  for (const line of log.split("\n")) {
    const m = re.exec(line);
    if (!m || m[2] !== "200") continue;
    const tags = (m[3] ?? "").trim().split(/\s+/);
    if (tags.includes("local") || tags.includes("bot")) {
      out.skipped += 1;
      continue;
    }
    const at = m[1] as string;
    out.count += 1;
    if (!out.first || at < out.first) out.first = at;
    if (!out.last || at > out.last) out.last = at;
  }
  return out;
}

export interface VapiCall {
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface CallStats {
  count: number;
  minutes: number;
  last?: string;
}

/** Calls from GET /call?assistantId=...: how many, total minutes talked, when the last one started. */
export function callStats(calls: VapiCall[]): CallStats {
  let ms = 0;
  let last: string | undefined;
  for (const c of calls) {
    if (c.startedAt && c.endedAt) ms += Math.max(0, Date.parse(c.endedAt) - Date.parse(c.startedAt));
    const at = c.startedAt ?? c.createdAt;
    if (at && (!last || at > last)) last = at;
  }
  return { count: calls.length, minutes: Math.round(ms / 6000) / 10, ...(last ? { last } : {}) };
}

/** "Nov 8, 6:45 PM IST" (12-hour, India time). */
export function ist(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "Asia/Kolkata" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
  return `${date}, ${time} IST`;
}
