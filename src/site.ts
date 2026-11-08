// The public demo page for one business, written for a business owner rather than an engineer: what the receptionist
// does, a way to try it (phone, and a browser call when a Vapi public key is set), the real email and team summary it
// sends (rendered by the same code the server uses, with sample data), how to get one, and a plain "about this demo".
// No call recordings: the demo is talking to it yourself. No secrets: only the Vapi PUBLIC key can appear here.
import type { Appointment } from "./db.ts";
import type { Business } from "./business.ts";
import { escapeHtml as e } from "./email.ts";
import { buildSummary } from "./postcall.ts";
import { formatPhone, matchFaq, renderHours, usd } from "./text.ts";
import { addDays, localYmd, spokenDateTime, weekdayIndex, weekdayName, ymdToUtcMidnightMs, zonedToUtc, type Ymd } from "./time.ts";
import { appointmentEmail, eventForAppointment, type Deps } from "./tools.ts";
import { beginMessage } from "./agent-config.ts";

export interface SiteOptions {
  /** The real number (E.164). */
  phone?: string | undefined;
  /** The voice platform the number runs on ("Vapi" or "Retell"). */
  platform?: string | undefined;
  /** Kept for the command line; not shown (a launch date only tells a buyer how new the demo is). */
  liveSince?: string | undefined;
  depositsOn: boolean;
  crmOn: boolean;
  /** Browser call through Vapi's web SDK: the PUBLIC key (made for web pages) and the assistant id. */
  webCall?: { publicKey: string; assistantId: string } | undefined;
  /** On a page whose business is not on the live line: where the live demo is. */
  liveDemo?: { url: string; name: string } | undefined;
  /** Other businesses built from the same engine. */
  otherDemos?: { url: string; name: string; vertical: string }[] | undefined;
  /** Shown in the footer and the "get one" section. */
  builder?: string | undefined;
  /** Where "message me" goes (an Upwork profile, so contact stays on the platform). */
  builderUrl?: string | undefined;
  /** Fixed clock for tests. */
  nowMs?: number | undefined;
  /** Absolute address of this page (for link previews), e.g. https://kabiirlabs.com/ */
  pageUrl?: string | undefined;
  /** Absolute address of the 1200x630 preview image made by `npm run og`. */
  ogImage?: string | undefined;
  /** One line under the builder's name in the top strip. */
  builderLine?: string | undefined;
}

const an = (w: string): string => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);
const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
const telHref = (p: string): string => `tel:${p.replace(/[^+\d]/g, "")}`;
/** A small round mark in the brand colour, as an inline SVG (no extra request). */
function faviconHref(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${color}"/><circle cx="32" cy="32" r="13" fill="none" stroke="#fff" stroke-width="6"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The 1200x630 card shown when the page link is shared (rendered to og.png by `npm run og`). */
export function buildOgCard(b: Business, builder = "Kabiir Labs"): string {
  const color = /^#[0-9a-fA-F]{6}$/.test(b.brand.color) ? b.brand.color : "#0f766e";
  const agent = b.agent.name;
  const long = b.agent.visitWord.length > 5;
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px}
body{font-family:Inter,-apple-system,Helvetica,Arial,sans-serif;background:#0b1120;color:#fff;display:grid;grid-template-columns:1.25fr .75fr;gap:40px;padding:64px 72px;position:relative;overflow:hidden}
body:before{content:"";position:absolute;right:-180px;top:-180px;width:620px;height:620px;border-radius:50%;background:radial-gradient(circle,${color}66,transparent 65%)}
.top{font-size:22px;font-weight:600;color:#94a3b8;display:flex;align-items:center;gap:14px}
.top i{width:40px;height:40px;border-radius:12px;background:${color};position:relative;display:inline-block}
.top i:after{content:"";position:absolute;inset:11px;border-radius:50%;border:4px solid #fff}
h1{font-size:${long ? 58 : 68}px;line-height:1.04;letter-spacing:-.035em;margin:${long ? 34 : 40}px 0 22px;font-weight:800}
h1 span{color:${color};filter:brightness(1.5)}
p{font-size:24px;line-height:1.4;color:#cbd5e1;margin:0;max-width:600px}
.foot{position:absolute;left:72px;bottom:52px;font-size:22px;color:#94a3b8}.foot b{color:#fff}
.chat{position:relative;align-self:center;background:#111a2e;border:1px solid #1e293b;border-radius:28px;padding:24px;display:grid;gap:12px}
.m{font-size:20px;line-height:1.35;padding:13px 17px;border-radius:18px;max-width:92%}
.a{background:#1e293b;border-bottom-left-radius:5px}.c{background:${color};margin-left:auto;border-bottom-right-radius:5px}
.live{font-size:17px;color:#4ade80;font-weight:600}
</style></head><body>
<div><div class="top"><i></i>${e(b.name)}</div>
<h1>Every call answered.<br><span>Every ${e(b.agent.visitWord)} booked.</span></h1>
<p>Talk to ${e(agent)}, a live AI receptionist. It books into a real calendar and emails a confirmation.</p></div>
<div class="chat"><div class="live">&#9679; ${e(agent)} is answering now</div>
<div class="m a">Thanks for calling ${e(b.name)}, this is ${e(agent)}. How can I help?</div>
<div class="m c">Can I come in Tuesday morning?</div>
<div class="m a">Sure. I have 9:00 or 10:30. Which works better?</div></div>
<div class="foot">Live demo by <b>${e(builder)}</b> &middot; fictional ${e(b.vertical)}</div>
</body></html>`;
}

const VAPI_WEB_SDK = "https://cdn.jsdelivr.net/npm/@vapi-ai/web@3.0.1/+esm";

/** A believable booking for the examples: the first service, someone who does it, next Tuesday 9:00 local. */
function sample(b: Business, nowMs: number) {
  const service = b.services.find((s) => s.depositUsd) ?? b.services[0];
  if (!service) throw new Error("a business needs at least one service");
  const staff = b.staff.find((s) => s.serviceIds.includes(service.id)) ?? b.staff[0];
  if (!staff) throw new Error("a business needs at least one staff member");
  let day = addDays(localYmd(nowMs, b.timezone), 1);
  while (weekdayIndex(day) !== 2) day = addDays(day, 1);
  const at = (d: Ymd, minutes: number): number => {
    const r = zonedToUtc(d, minutes, b.timezone);
    return r.kind === "gap" ? ymdToUtcMidnightMs(d) + minutes * 60_000 : r.utcMs;
  };
  const start = at(day, 9 * 60);
  const second = at(day, 10 * 60 + 30);
  const appt: Appointment = {
    id: "apt_sample",
    code: "K7QM",
    callId: "call_sample",
    staffId: staff.id,
    serviceId: service.id,
    startUtc: start,
    endUtc: start + service.durationMinutes * 60_000,
    customerName: "Sam Rivera",
    phone: "+12015550134",
    email: "sam@example.com",
    ...(b.agent.collectAddress ? { address: "12 Example Street" } : {}),
    status: "booked",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    calendarStatus: "synced",
    depositUsd: service.depositUsd ?? 0,
    depositStatus: service.depositUsd ? "due" : "none",
    history: [],
  };
  return { service, staff, day, start, second, appt };
}

function shortTime(utcMs: number, tz: string): string {
  return spokenDateTime(utcMs, tz).replace(/^.*? at /, "");
}

export function buildSite(b: Business, o: SiteOptions): string {
  const nowMs = o.nowMs ?? Date.now();
  const color = /^#[0-9a-fA-F]{6}$/.test(b.brand.color) ? b.brand.color : "#0f766e";
  const vw = b.agent.visitWord;
  const cw = b.agent.customerWord;
  const agent = b.agent.name;
  const builder = o.builder ?? "Kabiir Labs";
  const s = sample(b, nowMs);
  const tz = b.timezone;
  const deps = { b, publicBaseUrl: "https://example.invalid", linkSecret: "sample", depositsEnabled: o.depositsOn, transfersLive: false } as unknown as Deps;

  // The real confirmation email, with the sample booking. The pay button goes nowhere on the page.
  const mail = appointmentEmail(deps, s.appt, "booked");
  const mailHtml = mail.html.replace(/href="https:\/\/example\.invalid[^"]*"/g, 'href="#"');
  const event = eventForAppointment(deps, s.appt);

  // The real team summary, from a sample call log.
  const faqQ = b.demo?.tryQuestions[0] ?? "What are your hours?";
  const faqHit = matchFaq(b, faqQ);
  const day = `${weekdayName(s.day)}`;
  const t1 = shortTime(s.start, tz);
  const t2 = shortTime(s.second, tz);
  const summary = (
    buildSummary(
      b,
      {
        call_id: "sample-call",
        call_type: "phone_call",
        from_number: s.appt.phone,
        start_timestamp: nowMs,
        duration_ms: 118_000,
        call_analysis: { call_summary: `Sam asked "${faqQ}" and booked ${an(s.service.name.toLowerCase())} with ${s.staff.short} on ${day} at ${t1}.${s.appt.depositUsd ? ` The ${usd(s.appt.depositUsd)} deposit link was sent by email.` : ""}` },
      },
      [
        { callId: "sample-call", atMs: nowMs, tool: "lookup_faq", ok: true, outcome: "ok", note: `Answered: ${faqHit?.topic ?? "a question"}` },
        { callId: "sample-call", atMs: nowMs, tool: "get_availability", ok: true, outcome: "ok", note: `Offered ${day} ${t1} and ${t2} with ${s.staff.short}` },
        { callId: "sample-call", atMs: nowMs, tool: "book_appointment", ok: true, outcome: "ok", note: `Booked ${s.appt.code}: ${s.service.name}, ${day} ${t1}; confirmation emailed` },
      ],
      [s.appt],
    )
  );

  const convo: [string, string][] = [
    [agent, beginMessage(b)],
    ["Caller", faqQ],
    [agent, faqHit ? faqHit.answer.split(/(?<=\.)\s/).slice(0, 2).join(" ") : "Let me check that for you."],
    ["Caller", `Great. Can I get ${an(s.service.name.toLowerCase())} on ${day} morning?`],
    [agent, `Sure. I have ${t1} or ${t2} with ${s.staff.short}. Which works better?`],
    ["Caller", `${t1}, please.`],
    [agent, `You're all set for ${day} at ${t1}. I've emailed your confirmation with code ${s.appt.code}.${s.appt.depositUsd ? ` There's a ${usd(s.appt.depositUsd)} deposit to hold the time; the link is in that email.` : ""}`],
  ];

  const tryList = [
    `Book ${an(vw)}: "I'd like ${an(s.service.name.toLowerCase())} next week, in the morning." Give your real email to get the confirmation.`,
    `Ask a question: ${(b.demo?.tryQuestions ?? ["What are your hours on Saturday?"]).map((q) => `"${q}"`).join(" or ")}`,
    `Change your mind: call back, give the code from your email, and move or cancel it.`,
    `Try to trip it up: ask for a time when they're closed, or one that's already taken.`,
    `Say something urgent${b.urgent.rules[0] ? `, like "${b.urgent.rules[0].phrases[0]}"` : ""}: it stops booking and gets you to a person.`,
  ];

  const services = b.services.map((sv) => `<li><span>${e(sv.name)}</span><span class="price">${sv.priceUsd === 0 ? "Free" : e(usd(sv.priceUsd))}${sv.priceNote ? ` <small>${e(sv.priceNote)}</small>` : ""}</span></li>`).join("");

  const canCall = Boolean(o.phone);
  const canWeb = Boolean(o.webCall);
  const tryButtons = [
    canWeb ? `<button class="btn primary" id="webcall" type="button"><span class="dot"></span><span id="webcall-label">Talk to ${e(agent)} in your browser</span></button>` : "",
    canCall ? `<a class="btn ${canWeb ? "ghost" : "primary"}" href="${e(telHref(o.phone as string))}">Call ${e(formatPhone(o.phone as string))}</a>` : "",
  ].join("");
  const tryNote = canWeb || canCall
    ? `<p class="fine" id="webcall-note">${canWeb ? "Browser calls need your microphone. " : ""}${canCall ? "The phone number is a US number. " : ""}Free to try; each call ends after 5 minutes.</p>`
    : o.liveDemo
      ? `<p class="fine">This page shows the same receptionist set up for ${e(an(b.vertical))}. To talk to it live, try <a href="${e(o.liveDemo.url)}">the ${e(o.liveDemo.name)} demo</a>; it runs on the same engine.</p>`
      : `<p class="fine">The live line for this demo is being set up.</p>`;

  const others = (o.otherDemos ?? []).filter((d) => d.name !== b.name);

  const webScript = o.webCall
    ? `<script type="module">
const btn = document.getElementById("webcall"), label = document.getElementById("webcall-label"), note = document.getElementById("webcall-note");
const idle = label.textContent;
let vapi = null, live = false;
function set(state, text) { btn.dataset.state = state; label.textContent = text; }
btn.addEventListener("click", async () => {
  if (live) { vapi && vapi.stop(); return; }
  set("connecting", "Connecting...");
  try {
    if (!vapi) {
      const mod = await import(${JSON.stringify(VAPI_WEB_SDK)});
      const Vapi = typeof mod.default === "function" ? mod.default : mod.default.default;
      vapi = new Vapi(${JSON.stringify(o.webCall.publicKey)});
      vapi.on("call-start", () => { live = true; set("live", "End call"); note.textContent = "You're live. Talk normally, like a phone call."; });
      vapi.on("call-end", () => { live = false; set("idle", idle); note.textContent = "Call ended. Check your email if you booked something."; });
      vapi.on("error", () => { live = false; set("idle", idle); note.textContent = "That didn't connect. Allow the microphone and try again${o.phone ? ", or use the phone number" : ""}."; });
    }
    await vapi.start(${JSON.stringify(o.webCall.assistantId)});
  } catch {
    live = false; set("idle", idle);
    note.textContent = "That didn't connect. Allow the microphone and try again${o.phone ? ", or use the phone number" : ""}.";
  }
});
</script>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(agent)}, the AI receptionist for ${e(b.name)}</title>
<meta name="description" content="Talk to ${e(agent)}, an AI receptionist that answers calls, books into a real calendar and emails a confirmation. A live demo for a fictional ${e(b.vertical)}.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${e(faviconHref(color))}">
<meta name="theme-color" content="${e(color)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${e(`Talk to ${agent}: a live AI receptionist demo`)}">
<meta property="og:description" content="${e(`${agent} answers calls, books into a real calendar and emails a confirmation. Try it in your browser.`)}">
${o.pageUrl ? `<meta property="og:url" content="${e(o.pageUrl)}">` : ""}
${o.ogImage ? `<meta property="og:image" content="${e(o.ogImage)}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${e(o.ogImage)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--brand:${color};--ink:#0f172a;--ink2:#334155;--muted:#64748b;--line:#e2e8f0;--bg:#ffffff;--soft:#f8fafc;--card:#ffffff;--tint:color-mix(in srgb,var(--brand) 9%,#fff);--bubble:#f1f5f9}
@media (prefers-color-scheme:dark){:root{--ink:#e2e8f0;--ink2:#cbd5e1;--muted:#94a3b8;--line:#1e293b;--bg:#0b1120;--soft:#0f172a;--card:#111a2e;--tint:color-mix(in srgb,var(--brand) 18%,#0b1120);--bubble:#1e293b}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:Inter,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6;font-size:16px}
a{color:var(--brand)}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.strip{background:var(--ink);color:var(--bg);font-size:13px}
.strip .wrap{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-top:9px;padding-bottom:9px}
.strip b{font-weight:700}.strip a{color:inherit;font-weight:600;text-decoration:none;white-space:nowrap;opacity:.9}.strip a:hover{opacity:1;text-decoration:underline}
@media (max-width:640px){.strip .sep,.strip .line{display:none}}
nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;padding:18px 0;gap:10px 12px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.01em}
.logo i{width:30px;height:30px;border-radius:9px;background:var(--brand);display:inline-block;position:relative}
.logo i:after{content:"";position:absolute;inset:9px;border-radius:50%;border:2px solid #fff}
.badge{font-size:12px;font-weight:600;color:var(--brand);background:var(--tint);border-radius:999px;padding:5px 11px;white-space:nowrap}
.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:48px;align-items:center;padding:36px 0 56px}
h1{font-size:clamp(34px,5vw,52px);line-height:1.08;letter-spacing:-.03em;margin:0 0 18px;font-weight:800}
h1 em{font-style:normal;color:var(--brand)}
.lead{font-size:19px;color:var(--ink2);margin:0 0 28px;max-width:34em}
.btns{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px}
.btn{display:inline-flex;align-items:center;gap:10px;font:inherit;font-weight:600;font-size:17px;padding:14px 22px;border-radius:12px;text-decoration:none;cursor:pointer;border:1px solid transparent;transition:transform .1s ease,box-shadow .2s ease}
.btn:active{transform:translateY(1px)}
.btn.primary{background:var(--brand);color:#fff;box-shadow:0 8px 24px color-mix(in srgb,var(--brand) 30%,transparent)}
.btn.light{background:#fff;color:var(--brand)}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.btn .dot{width:10px;height:10px;border-radius:50%;background:#fff;opacity:.9}
.btn[data-state=connecting]{opacity:.8;cursor:progress}
.btn[data-state=live]{background:#dc2626;box-shadow:0 8px 24px rgba(220,38,38,.3)}
.btn[data-state=live] .dot{animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.6);opacity:.4}}
.fine{font-size:14px;color:var(--muted);margin:6px 0 0}
.phone{background:var(--card);border:1px solid var(--line);border-radius:28px;padding:18px;box-shadow:0 30px 60px -20px rgba(15,23,42,.25)}
.phone-top{display:flex;align-items:center;gap:10px;padding:4px 6px 14px;border-bottom:1px solid var(--line);margin-bottom:12px}
.avatar{width:36px;height:36px;border-radius:50%;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:700}
.phone-top b{display:block;font-size:15px}.phone-top span{font-size:12px;color:#16a34a}
.msg{max-width:88%;padding:9px 13px;border-radius:16px;margin:7px 0;font-size:14px;line-height:1.45}
.msg.a{background:var(--bubble);border-bottom-left-radius:4px}
.msg.c{background:var(--brand);color:#fff;margin-left:auto;border-bottom-right-radius:4px}
.caption{font-size:12px;color:var(--muted);text-align:center;margin:10px 0 0}
section{padding:64px 0}
section.soft{background:var(--soft)}
h2{font-size:clamp(26px,3.4vw,36px);letter-spacing:-.02em;line-height:1.15;margin:0 0 12px}
.sub{color:var(--ink2);font-size:18px;margin:0 0 36px;max-width:40em}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px}
.num{width:34px;height:34px;border-radius:10px;background:var(--tint);color:var(--brand);display:grid;place-items:center;font-weight:700;margin-bottom:14px}
.card h3{margin:0 0 8px;font-size:18px}.card p{margin:0;color:var(--ink2)}
.proof{display:grid;grid-template-columns:1.15fr .85fr;gap:20px;align-items:start}
.label{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:0 0 10px}
.mail{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#f6f7f9}
.mail-head{background:#fff;color:#111;padding:12px 16px;border-bottom:1px solid #e5e7eb;font-size:13px}
.mail-head b{display:block;font-size:14px}
.mail iframe{display:block;width:100%;height:470px;border:0;pointer-events:none}
.stack{display:grid;gap:20px}
.event{border-left:4px solid var(--brand);background:var(--tint);border-radius:10px;padding:12px 14px;font-size:14px}
.event b{display:block}
.sumhead{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}
.tag{font-size:12px;font-weight:600;border-radius:999px;padding:3px 9px;background:var(--bubble);color:var(--ink2);white-space:nowrap}
.tag.ok{background:color-mix(in srgb,#16a34a 15%,transparent);color:#16a34a}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0 0 12px;font-size:14px}dt{color:var(--muted)}dd{margin:0}
.sumtext{font-size:14px;color:var(--ink2);border-top:1px solid var(--line);padding-top:12px;margin:0}
.try{counter-reset:t;list-style:none;padding:0;margin:0;display:grid;gap:12px}
.try li{counter-increment:t;display:flex;gap:14px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.try li:before{content:counter(t);flex:none;width:26px;height:26px;border-radius:8px;background:var(--tint);color:var(--brand);display:grid;place-items:center;font-weight:700;font-size:14px}
.get{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.ticks{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.ticks li{padding-left:28px;position:relative;color:var(--ink2)}
.ticks li:before{content:"";position:absolute;left:0;top:6px;width:16px;height:9px;border-left:3px solid var(--brand);border-bottom:3px solid var(--brand);transform:rotate(-45deg)}
.cta{background:var(--brand);color:#fff;border-radius:22px;padding:32px}
.cta h3{font-size:24px;margin:0 0 10px}.cta p{margin:0 0 10px;opacity:.95}
.cta .small{font-size:14px;opacity:.85}
.menu{list-style:none;padding:0;margin:0}
.menu li{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)}
.menu .price{font-weight:600;white-space:nowrap}.menu small{color:var(--muted);font-weight:400}
.about{display:grid;grid-template-columns:1fr 1fr;gap:12px 32px;padding:0;margin:0;list-style:none}
.about li{color:var(--ink2);font-size:15px}.about b{color:var(--ink)}
.pills{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.pills a{border:1px solid var(--line);border-radius:999px;padding:8px 14px;text-decoration:none;color:var(--ink);font-weight:500;font-size:15px}
footer{padding:36px 0 48px;color:var(--muted);font-size:14px;border-top:1px solid var(--line)}
@media (max-width:860px){.hero,.proof,.get{grid-template-columns:1fr}.steps{grid-template-columns:1fr}.about{grid-template-columns:1fr}.hero{gap:32px;padding-top:12px}section{padding:48px 0}.mail iframe{height:520px}}
@media (max-width:420px){.wrap{padding:0 16px}.btn{width:100%;justify-content:center}.badge{font-size:11px}}
</style>
</head>
<body>
<div class="strip"><div class="wrap"><span>Live demo by <b>${e(builder)}</b><span class="sep"> &middot; </span><span class="line">${e(o.builderLine ?? "AI receptionists for clinics and home services")}</span></span>${o.builderUrl ? `<a href="${e(o.builderUrl)}" target="_blank" rel="noopener">Work with me &rarr;</a>` : ""}</div></div>
<div class="wrap">
<nav><div class="logo"><i></i>${e(b.name)}</div><span class="badge">Fictional ${e(b.vertical)}</span></nav>

<div class="hero">
<div>
<h1>Every call answered.<br><em>Every ${e(vw)} booked.</em></h1>
<p class="lead">${e(agent)} is an AI receptionist for ${e(b.name)}. ${e(agent)} picks up day and night, answers questions, books straight into the calendar and emails the ${e(cw)} a confirmation, so no caller hears voicemail.</p>
<div class="btns">${tryButtons}</div>
${tryNote}
</div>
<div class="phone" aria-label="Example conversation">
<div class="phone-top"><div class="avatar">${e(agent.charAt(0))}</div><div><b>${e(agent)} &middot; ${e(b.name)}</b><span>&#9679; Answering now</span></div></div>
${convo.map(([who, text]) => `<div class="msg ${who === "Caller" ? "c" : "a"}">${e(text)}</div>`).join("\n")}
<p class="caption">Example conversation. Yours will go wherever you take it.</p>
</div>
</div>
</div>

<section id="how" class="soft">
<div class="wrap">
<h2>What happens when someone calls</h2>
<p class="sub">The same things a great front desk does, without the hold music.</p>
<div class="steps">
<div class="card"><div class="num">1</div><h3>Answers straight away</h3><p>Any hour, any day. Hours, prices, ${b.agent.collectAddress ? "service area" : "insurance"}, parking, policies: ${e(agent)} answers from the business's own information and doesn't make things up.</p></div>
<div class="card"><div class="num">2</div><h3>Books into the real calendar</h3><p>Checks what's actually free, offers times, and books. It never double-books, and it respects anything the team blocks out by hand.${o.depositsOn ? " It can take a deposit by card to cut no-shows." : ""}</p></div>
<div class="card"><div class="num">3</div><h3>Keeps everyone in the loop</h3><p>The ${e(cw)} gets a confirmation email with a code to change or cancel. The team gets a summary of every call. Anything urgent goes to a person.</p></div>
</div>
</div>
</section>

<section id="proof">
<div class="wrap">
<h2>What lands in the inbox and the calendar</h2>
<p class="sub">These are made by the same code that runs the live line, filled in with a sample booking.</p>
<div class="proof">
<div>
<p class="label">The ${e(cw)}'s confirmation email</p>
<div class="mail"><div class="mail-head"><b>${e(mail.subject)}</b>From ${e(b.name)}</div><iframe title="Confirmation email" sandbox="" tabindex="-1" loading="lazy" srcdoc="${e(mailHtml)}"></iframe></div>
</div>
<div class="stack">
<div><p class="label">The calendar entry</p><div class="event"><b>${e(event.summary)}</b>${e(spokenDateTime(s.start, tz))} &middot; ${e(String(s.service.durationMinutes))} min</div></div>
<div><p class="label">The summary the team gets after the call</p><div class="card sumcard">
<div class="sumhead"><b>${e(summary.customer.name ?? "Caller")}</b><span class="tag ok">${e(cap(summary.outcome.replace(/_/g, " ")))}</span></div>
<dl>
<dt>Phone</dt><dd>${e(summary.from_number ? formatPhone(summary.from_number) : "-")}</dd>
<dt>Call</dt><dd>${e(`${Math.floor((summary.duration_seconds ?? 0) / 60)} min ${(summary.duration_seconds ?? 0) % 60} s`)}</dd>
${summary.appointments.map((a) => `<dt>Booked</dt><dd>${e(`${a.service}, ${a.spoken}, ${a.staff}`)}${a.deposit_usd ? ` <span class="tag">${e(`${usd(a.deposit_usd)} deposit ${a.deposit_status}`)}</span>` : ""}</dd>`).join("")}
<dt>Urgent?</dt><dd>${summary.urgency === "routine" ? "No" : e(summary.urgency.replace(/_/g, " "))}</dd>
</dl>
<p class="sumtext">${e(summary.platform_summary ?? "")}</p>
</div></div>
</div>
</div>
</div>
</section>

<section id="try" class="soft">
<div class="wrap">
<h2>Try it yourself</h2>
<p class="sub">Call like a real ${e(cw)} would. A few ideas:</p>
<ol class="try">${tryList.map((t) => `<li>${e(t)}</li>`).join("")}</ol>
<div class="btns" style="margin-top:24px">${tryButtons.replace('id="webcall"', 'id="webcall2"').replace('id="webcall-label"', 'id="webcall2-label"')}</div>
</div>
</section>

<section id="get">
<div class="wrap">
<h2>Want this for your business?</h2>
<p class="sub">${e(b.name)} is made up, but the receptionist is real and is set up from a business's own information. ${others.length ? "Here's the same one set up for other kinds of business:" : ""}</p>
${others.length ? `<div class="pills" style="margin:-20px 0 32px">${others.map((d) => `<a href="${e(d.url)}">${e(cap(d.vertical))}: ${e(d.name)}</a>`).join("")}</div>` : ""}
<div class="get">
<div class="card">
<h3 style="margin-bottom:14px">What you get</h3>
<ul class="ticks">
<li>Set up on your hours, services, prices, team and FAQs</li>
<li>Bookings in your Google Calendar, with no double-booking</li>
<li>Confirmation emails from your own domain</li>
<li>Your rules for urgent calls and when to bring in a person</li>
<li>A summary of every call to your inbox or CRM</li>
<li>Deposits by card through Stripe, if you want them</li>
<li>Tested on real calls before your customers hear it</li>
</ul>
</div>
<div class="cta">
<h3>Let's talk about your front desk</h3>
<p>Send me your business name, roughly how many calls you get a week, and what usually goes wrong. I'll tell you what I'd set up and what it would cost to run.</p>
<p class="small">Running cost is mainly the voice platform: about $0.13 a minute on this demo, paid to the platform directly.</p>
${o.builderUrl ? `<p style="margin-top:18px"><a class="btn light" href="${e(o.builderUrl)}" target="_blank" rel="noopener">Message me on Upwork</a></p>` : `<p class="small">Message me on Upwork.</p>`}
</div>
</div>
</div>
</section>

<section id="services" class="soft">
<div class="wrap">
<div class="get">
<div><h2 style="font-size:24px">Services <small style="font-weight:500;color:var(--muted);font-size:15px">(sample prices)</small></h2><ul class="menu">${services}</ul></div>
<div><h2 style="font-size:24px">Hours</h2><p style="color:var(--ink2)">${e(renderHours(b))}</p><p class="fine">${e(tz.replace("_", " "))} time.</p></div>
</div>
</div>
</section>

<section id="about">
<div class="wrap">
<h2 style="font-size:24px">About this demo</h2>
<ul class="about">
<li><b>Real:</b> the phone line, the AI receptionist, the calendar it books into, and the emails it sends.</li>
<li><b>Made up:</b> ${e(b.name)} itself. The name, address, team and prices are invented.</li>
<li><b>Deposits</b> use Stripe's test mode, so no real money moves. Test card: 4242 4242 4242 4242.</li>
<li><b>Transfers to a person</b> are simulated, because the business's own numbers are fictional.</li>
<li><b>Calls aren't recorded.</b> I can see the transcript and summary, so use a made-up name if you like.</li>
<li><b>Not for real emergencies.</b> ${b.agent.customerWord === "patient" ? "For a medical or dental emergency, call 911." : "For an emergency, call 911."}</li>
</ul>
</div>
</section>

<div class="wrap"><footer>${e(b.fictionNote)} &middot; Built by ${e(builder)}.</footer></div>
${webScript}
${o.webCall ? `<script type="module">const b2=document.getElementById("webcall2");if(b2)b2.addEventListener("click",()=>{document.getElementById("webcall").click();window.scrollTo({top:0,behavior:"smooth"});});</script>` : ""}
</body>
</html>
`;
}
