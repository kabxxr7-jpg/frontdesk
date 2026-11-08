// The "Chat with <agent>" widget for the demo page: a floating button and a chat panel, plain JS and CSS inlined in
// the page (no build step, no third-party script). It talks to POST <endpoint> on the same server; no key or secret
// is ever in the page. Text from the server is shown with textContent only. Light and dark follow the page; on a
// phone the panel fills the screen. Keyboard: Escape closes, focus returns to the button that opened it.
import type { Business } from "./business.ts";
import { escapeHtml as e } from "./email.ts";

export interface ChatWidgetOptions {
  /** Where the page posts messages: "/chat" for the main demo, "/t/<slug>/chat" for a prospect sample. */
  endpoint: string;
}

export function chatSuggestions(b: Business): string[] {
  const vw = b.agent.visitWord;
  const first = b.services[0]?.name.toLowerCase();
  return [...(b.demo?.tryQuestions ?? ["What are your hours?"]).slice(0, 2), first ? `Book ${/^[aeiou]/i.test(first) ? "an" : "a"} ${first} next week` : `Book ${/^[aeiou]/i.test(vw) ? "an" : "a"} ${vw}`, `Cancel my ${vw}`];
}

export function chatWidget(b: Business, o: ChatWidgetOptions): string {
  const agent = b.agent.name;
  const color = /^#[0-9a-fA-F]{6}$/.test(b.brand.color) ? b.brand.color : "#0f766e";
  const greeting = `Hi, I'm ${agent}, the AI receptionist for ${b.name}. I can answer questions and book, move or cancel ${b.agent.visitWord}s. How can I help?`;
  const note = b.prospect ? "Sample built from a job post. Bookings here are test bookings." : b.fictional ? `Demo: ${b.name} is fictional. Bookings and emails are real.` : "";
  const cfg = { endpoint: o.endpoint, agent, greeting, suggestions: chatSuggestions(b), key: `fdchat:${b.slug}` };
  return `<style>
.fdc{--fdc-brand:${color};--fdc-bg:#fff;--fdc-ink:#0f172a;--fdc-muted:#64748b;--fdc-line:#e2e8f0;--fdc-bubble:#f1f5f9;--fdc-soft:#f8fafc;font-family:Inter,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme:dark){.fdc{--fdc-bg:#111a2e;--fdc-ink:#e2e8f0;--fdc-muted:#94a3b8;--fdc-line:#1e293b;--fdc-bubble:#1e293b;--fdc-soft:#0b1120}}
.fdc *{box-sizing:border-box}
.fdc-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:inline-flex;align-items:center;gap:10px;border:0;border-radius:999px;padding:14px 20px 14px 16px;background:var(--fdc-brand);color:#fff;font:inherit;font-weight:600;font-size:16px;cursor:pointer;box-shadow:0 12px 30px -6px color-mix(in srgb,var(--fdc-brand) 55%,transparent),0 4px 12px rgba(15,23,42,.18);transition:transform .15s ease}
.fdc-launch:hover{transform:translateY(-2px)}.fdc-launch:focus-visible,.fdc button:focus-visible,.fdc textarea:focus-visible{outline:3px solid color-mix(in srgb,var(--fdc-brand) 55%,#fff);outline-offset:2px}
.fdc-launch svg{width:22px;height:22px;flex:none}
.fdc-launch[hidden]{display:none}
.fdc-panel{position:fixed;right:20px;bottom:20px;z-index:2147483001;width:384px;height:min(620px,calc(100vh - 40px));display:flex;flex-direction:column;background:var(--fdc-bg);color:var(--fdc-ink);border:1px solid var(--fdc-line);border-radius:22px;overflow:hidden;box-shadow:0 30px 70px -20px rgba(15,23,42,.45);transform-origin:bottom right;animation:fdc-in .18s ease-out}
.fdc-panel[hidden]{display:none}
@keyframes fdc-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.fdc-panel,.fdc-dots i{animation:none!important}.fdc-launch{transition:none}}
.fdc-head{display:flex;align-items:center;gap:11px;padding:14px 14px 14px 16px;background:var(--fdc-brand);color:#fff}
.fdc-av{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.2);display:grid;place-items:center;font-weight:700;flex:none;position:relative}
.fdc-av:after{content:"";position:absolute;right:0;bottom:0;width:10px;height:10px;border-radius:50%;background:#4ade80;border:2px solid var(--fdc-brand)}
.fdc-title{flex:1;min-width:0}.fdc-title b{display:block;font-size:15px;line-height:1.2}.fdc-title span{font-size:12px;opacity:.9}
.fdc-x{border:0;background:rgba(255,255,255,.16);color:#fff;width:34px;height:34px;border-radius:10px;cursor:pointer;display:grid;place-items:center;flex:none}
.fdc-x:hover{background:rgba(255,255,255,.28)}.fdc-x svg{width:18px;height:18px}
.fdc-log{flex:1;overflow-y:auto;padding:16px 14px 6px;display:flex;flex-direction:column;gap:8px;background:var(--fdc-soft);overscroll-behavior:contain}
.fdc-m{max-width:85%;padding:9px 13px;border-radius:16px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.fdc-m.a{background:var(--fdc-bg);border:1px solid var(--fdc-line);border-bottom-left-radius:5px;align-self:flex-start}
.fdc-m.u{background:var(--fdc-brand);color:#fff;border-bottom-right-radius:5px;align-self:flex-end}
.fdc-m.err{border-color:color-mix(in srgb,#dc2626 40%,var(--fdc-line))}
.fdc-booked{align-self:flex-start;font-size:12.5px;font-weight:600;color:#15803d;background:color-mix(in srgb,#16a34a 13%,var(--fdc-bg));border-radius:999px;padding:4px 10px}
.fdc-dots{align-self:flex-start;background:var(--fdc-bg);border:1px solid var(--fdc-line);border-radius:16px;border-bottom-left-radius:5px;padding:12px 14px;display:flex;gap:4px}
.fdc-dots i{width:7px;height:7px;border-radius:50%;background:var(--fdc-muted);animation:fdc-b 1s infinite ease-in-out}.fdc-dots i:nth-child(2){animation-delay:.15s}.fdc-dots i:nth-child(3){animation-delay:.3s}
@keyframes fdc-b{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.fdc-sugg{display:flex;flex-wrap:wrap;gap:6px;padding:4px 14px 10px;background:var(--fdc-soft)}
.fdc-sugg[hidden]{display:none}
.fdc-sugg button{font:inherit;font-size:13px;border:1px solid color-mix(in srgb,var(--fdc-brand) 35%,var(--fdc-line));color:var(--fdc-brand);background:var(--fdc-bg);border-radius:999px;padding:6px 11px;cursor:pointer;text-align:left}
@media (prefers-color-scheme:dark){.fdc-sugg button{color:color-mix(in srgb,var(--fdc-brand) 55%,#fff)}}
.fdc-sugg button:hover{background:color-mix(in srgb,var(--fdc-brand) 8%,var(--fdc-bg))}
.fdc-form{display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--fdc-line);background:var(--fdc-bg)}
.fdc-form textarea{flex:1;resize:none;border:1px solid var(--fdc-line);border-radius:14px;padding:10px 12px;font:inherit;font-size:15px;line-height:1.4;max-height:120px;min-height:44px;background:var(--fdc-bg);color:var(--fdc-ink)}
.fdc-form textarea::placeholder{color:var(--fdc-muted)}
.fdc-send{flex:none;width:44px;height:44px;border-radius:12px;border:0;background:var(--fdc-brand);color:#fff;cursor:pointer;display:grid;place-items:center}
.fdc-send:disabled{opacity:.45;cursor:default}.fdc-send svg{width:20px;height:20px}
.fdc-foot{font-size:11.5px;color:var(--fdc-muted);text-align:center;padding:0 12px 10px;background:var(--fdc-bg)}
.fdc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:520px){.fdc-panel{inset:0;width:auto;height:100%;height:100dvh;border-radius:0;border:0}.fdc-launch{right:16px;bottom:16px}}
</style>
<div class="fdc" id="fdc">
<button class="fdc-launch" id="fdc-open" type="button" aria-haspopup="dialog" aria-controls="fdc-panel" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.4A8 8 0 1 1 21 12z"/></svg>Chat with ${e(agent)}</button>
<div class="fdc-panel" id="fdc-panel" role="dialog" aria-modal="false" aria-labelledby="fdc-name" hidden>
<div class="fdc-head"><div class="fdc-av" aria-hidden="true">${e(agent.charAt(0))}</div><div class="fdc-title"><b id="fdc-name">${e(agent)} &middot; ${e(b.name)}</b><span>AI receptionist &middot; replies in seconds</span></div><button class="fdc-x" id="fdc-close" type="button" aria-label="Close chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
<div class="fdc-log" id="fdc-log" role="log" aria-live="polite" aria-relevant="additions"></div>
<div class="fdc-sugg" id="fdc-sugg" aria-label="Suggested messages"></div>
<form class="fdc-form" id="fdc-form"><label class="fdc-sr" for="fdc-in">Message ${e(agent)}</label><textarea id="fdc-in" rows="1" maxlength="500" placeholder="Type a message..." autocomplete="off"></textarea><button class="fdc-send" id="fdc-send" type="submit" aria-label="Send" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></form>
${note ? `<div class="fdc-foot">${e(note)}</div>` : ""}
</div>
</div>
<script>
(() => {
const C = ${JSON.stringify(cfg).replace(/</g, "\\u003c")};
const $ = (id) => document.getElementById(id);
const panel = $("fdc-panel"), launch = $("fdc-open"), log = $("fdc-log"), form = $("fdc-form"), input = $("fdc-in"), send = $("fdc-send"), sugg = $("fdc-sugg");
let state = { session: null, items: [] }, busy = false, opener = launch;
try { const saved = JSON.parse(sessionStorage.getItem(C.key) || "null"); if (saved && Array.isArray(saved.items)) state = saved; } catch {}
const save = () => { try { sessionStorage.setItem(C.key, JSON.stringify(state)); } catch {} };
function bubble(kind, text, extra) {
  if (kind === "booked") { const t = document.createElement("div"); t.className = "fdc-booked"; t.textContent = text; log.appendChild(t); return; }
  const m = document.createElement("div");
  m.className = "fdc-m " + kind + (extra ? " " + extra : "");
  m.textContent = text;
  log.appendChild(m);
}
function render() {
  log.textContent = "";
  bubble("a", C.greeting);
  for (const it of state.items) bubble(it.k, it.t, it.x);
  sugg.hidden = state.items.length > 0;
  log.scrollTop = log.scrollHeight;
}
for (const s of C.suggestions) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = s;
  b.addEventListener("click", () => ask(s));
  sugg.appendChild(b);
}
function open(from) {
  opener = from || launch;
  panel.hidden = false; launch.hidden = true; launch.setAttribute("aria-expanded", "true");
  render(); input.focus();
}
function close() {
  panel.hidden = true; launch.hidden = false; launch.setAttribute("aria-expanded", "false");
  (opener && document.body.contains(opener) && opener.offsetParent !== null ? opener : launch).focus();
}
launch.addEventListener("click", () => open(launch));
$("fdc-close").addEventListener("click", close);
panel.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
document.querySelectorAll("[data-chat-open]").forEach((el) => el.addEventListener("click", (ev) => { ev.preventDefault(); open(el); }));
function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; send.disabled = busy || input.value.trim() === ""; }
input.addEventListener("input", grow);
input.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); form.requestSubmit(); } });
form.addEventListener("submit", (ev) => { ev.preventDefault(); ask(input.value); });
function push(k, t, x) { state.items.push(x ? { k, t, x } : { k, t }); save(); bubble(k, t, x); sugg.hidden = true; log.scrollTop = log.scrollHeight; }
async function ask(text) {
  text = String(text || "").trim();
  if (!text || busy) return;
  busy = true; input.value = ""; grow();
  push("u", text);
  const dots = document.createElement("div"); dots.className = "fdc-dots"; dots.setAttribute("role", "status"); dots.setAttribute("aria-label", C.agent + " is typing"); dots.innerHTML = "<i></i><i></i><i></i>";
  log.appendChild(dots); log.scrollTop = log.scrollHeight;
  try {
    const res = await fetch(C.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.session ? { session_id: state.session, message: text } : { message: text }) });
    let data = {}; try { data = await res.json(); } catch {}
    if (data.session_id) state.session = data.session_id;
    if (data.ended) state.session = null;
    dots.remove();
    push("a", data.reply || "Sorry, something went wrong. Please try again.", res.ok ? "" : "err");
    if (data.booked && data.booked.code) push("booked", "\\u2713 Booked \\u00b7 code " + data.booked.code);
  } catch {
    dots.remove();
    push("a", "I couldn't reach the server. Check your connection and try again.", "err");
  } finally {
    busy = false; grow(); input.focus();
  }
}
if (new URLSearchParams(location.search).has("chat")) open(launch);
})();
</script>`;
}
