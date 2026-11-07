// The public demo page for one business: "call this number and book a visit", a short case study and an honest table
// of what is real and what is fictional. No call recordings: the demo is calling the line yourself. Static HTML, no scripts from elsewhere, works on a phone.
import type { Business } from "./business.ts";
import { escapeHtml as e } from "./email.ts";
import { formatPhone, renderHours, usd } from "./text.ts";

export interface SiteOptions {
  /** The real number (E.164). Without it the page says the line is being set up. */
  phone?: string | undefined;
  /** The voice platform the number runs on, as shown in the table ("Vapi" or "Retell"). */
  platform?: string | undefined;
  /** "8 Nov 2026": when the line went live. Only set once it really did. */
  liveSince?: string | undefined;
  depositsOn: boolean;
  crmOn: boolean;
}

function telHref(p: string): string {
  return `tel:${p.replace(/[^+\d]/g, "")}`;
}

export function buildSite(b: Business, o: SiteOptions): string {
  const color = /^#[0-9a-fA-F]{6}$/.test(b.brand.color) ? b.brand.color : "#0f766e";
  const vw = b.agent.visitWord;
  const deposits = b.services.filter((s) => s.depositUsd);
  const tryList = [
    `Book a ${vw}: "I'd like ${b.services[0] ? `a ${b.services[0].name.toLowerCase()}` : "to book"} next week, in the morning."`,
    `Ask a question: ${(b.demo?.tryQuestions ?? ["What are your hours on Saturday?"]).map((q) => `"${q}"`).join(" or ")}`,
    `Move or cancel it: give the four-character code from your confirmation email.`,
    `Say something urgent${b.urgent.rules[0] ? ` (for example "${b.urgent.rules[0].phrases[0]}")` : ""}: it stops booking and routes you to a person.`,
    `Ask for a time outside the hours, or one that is already taken.`,
  ];
  const rows: [string, string, string][] = [
    ["Phone line, voice agent, speech", "Real", `A real US number on ${o.platform ?? "Vapi"}${o.liveSince ? `, live since ${o.liveSince}` : ""}. Calls are not recorded`],
    ["Calendar", "Real", "Bookings land in a real Google Calendar, checked for clashes and for blocks typed in by hand"],
    ["Confirmation email", "Real", "Sent to the address you give on the call, with your code"],
    ["Deposit", o.depositsOn ? "Real, test mode" : "Not switched on", o.depositsOn ? `Stripe test mode: the page is real Stripe Checkout, no money moves (test card 4242 4242 4242 4242). ${deposits.length ? `${deposits.map((s) => `${s.name} ${usd(s.depositUsd as number)}`).join(", ")}.` : ""}` : "Code exists; not connected on this demo"],
    ["Call summary to CRM and team", o.crmOn ? "Real" : "Being connected", o.crmOn ? "Every call is summarised and sent to a CRM and a team inbox through n8n" : "Summary is built; the CRM step is being connected"],
    ["Transfer to a person", "Simulated", "The business's numbers are fictional, so the agent says where it would connect you and flags the call instead"],
    [b.name, "Fictional", "Name, address, staff, prices, phone numbers and policies are invented for this demo"],
  ];
  const services = b.services.map((s) => `<li><strong>${e(s.name)}</strong> ${s.priceUsd === 0 ? "free" : e(usd(s.priceUsd))}${s.priceNote ? ` <span class="muted">(${e(s.priceNote)})</span>` : ""}${s.depositUsd ? ` <span class="pill">${e(usd(s.depositUsd))} deposit</span>` : ""}</li>`).join("");
  const phoneBlock = o.phone
    ? `<a class="call" href="${e(telHref(o.phone))}">Call ${e(formatPhone(o.phone))}</a><p class="muted small">US number. Calls end after 5 minutes; a few dozen calls a day are accepted. No audio is recorded; your number, the transcript and the summary are seen by the operator of this demo, so use a test name and email if you prefer.</p>`
    : `<p class="call off">The phone line is being set up.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(b.name)} front desk demo</title>
<meta name="description" content="Call a live AI front desk for a fictional ${e(b.vertical)}: it answers, books into a real calendar, emails a confirmation and takes a test-mode deposit.">
<style>
:root{--brand:${color};--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#f8fafc;--card:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#e5e7eb;--muted:#9ca3af;--line:#374151;--bg:#0b1220;--card:#111827}}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.55}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
header{padding:28px 0 8px}h1{font-size:30px;line-height:1.2;margin:0 0 8px}h2{font-size:20px;margin:36px 0 12px}
.tag{display:inline-block;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--brand);margin-bottom:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:16px 0}
.call{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;font-size:22px;font-weight:700;padding:14px 22px;border-radius:12px;margin:8px 0}
.call.off{background:var(--line);color:var(--muted);font-size:16px}
.muted{color:var(--muted)}.small{font-size:13px}
.pill{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted);white-space:nowrap}
ol,ul{padding-left:20px}li{margin:6px 0}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:13px;color:var(--muted);font-weight:600}
td.k{white-space:nowrap;font-weight:600}
.real{color:#047857;font-weight:600}.fict{color:#b45309;font-weight:600}.sim{color:#6d28d9;font-weight:600}
@media (prefers-color-scheme:dark){.real{color:#34d399}.fict{color:#fbbf24}.sim{color:#c4b5fd}}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:640px){.grid{grid-template-columns:1fr}td.k{white-space:normal}}
footer{margin-top:48px;font-size:13px;color:var(--muted)}
</style>
</head>
<body>
<main>
<header>
<span class="tag">Live demo, fictional ${e(b.vertical)}</span>
<h1>Call ${e(b.name)} and book a ${e(vw)}</h1>
<p>${e(b.agent.name)} is an AI receptionist. It answers questions, books into a real Google Calendar, emails you a confirmation${o.depositsOn ? ", takes a deposit by card (Stripe test mode)" : ""} and sends the team a summary of every call.</p>
${phoneBlock}
</header>

<section class="card">
<h2 style="margin-top:0">Things to try</h2>
<ol>${tryList.map((t) => `<li>${e(t)}</li>`).join("")}</ol>
</section>

<h2>What is real and what is not</h2>
<div class="card" style="padding:8px 12px">
<table>
<thead><tr><th>Part</th><th>Status</th><th>Detail</th></tr></thead>
<tbody>${rows.map(([k, s, d]) => `<tr><td class="k">${e(k)}</td><td class="${s.startsWith("Real") ? "real" : s === "Fictional" ? "fict" : "sim"}">${e(s)}</td><td>${e(d)}</td></tr>`).join("")}</tbody>
</table>
</div>

<h2>Case study: the front desk that never puts a caller on hold</h2>
<div class="card">
<p><strong>The problem.</strong> A small ${e(b.vertical)} misses calls during busy hours and after closing. Each missed call is a booking that goes to a competitor, and staff spend the day on "are you open Saturday?" questions.</p>
<p><strong>What was built.</strong> A phone agent that runs on the business's own data: one file with hours, team, services, prices and FAQ. It checks the real calendar before offering a time, refuses double bookings, books, moves and cancels, sends a confirmation with a code, ${o.depositsOn ? "takes a deposit through Stripe Checkout, " : ""}and routes anything urgent to a person. The emergency check runs in code, not only in the prompt, so it does not depend on the model remembering a rule.</p>
<p><strong>After the call.</strong> The team gets a summary: who called, what was booked, anything urgent, and anything that failed (for example an email that bounced), so nothing is lost.</p>
<p><strong>Re-use.</strong> The same engine is re-skinned for another business from a short brief (name, services, hours, prices, FAQ) in minutes; a plumber gets job addresses and "burst pipe" routing, a dental clinic gets "knocked-out tooth" routing.</p>
</div>

<div class="grid">
<section class="card"><h2 style="margin-top:0">Services (fictional prices)</h2><ul>${services}</ul></section>
<section class="card"><h2 style="margin-top:0">Hours</h2><p>${e(renderHours(b))}</p><p class="muted small">Times are ${e(b.timezone.replace("_", " "))} time.</p></section>
</div>

<footer>
<p>${e(b.fictionNote)} Do not use this line for a real ${b.agent.customerWord === "patient" ? "medical or dental" : ""} emergency; call 911.</p>
</footer>
</main>
</body>
</html>
`;
}
