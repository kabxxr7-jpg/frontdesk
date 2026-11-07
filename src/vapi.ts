// Vapi as the voice platform, beside Retell. The same tools, prompt and post-call summary; only the wire formats differ.
// Formats from Vapi's docs, read on 2026-11-07 (docs.vapi.ai: custom tools, server events, server authentication):
//   tool calls:  POST { message: { type: "tool-calls", toolCallList: [{ id, function: { name, arguments } }], call } }
//                answer HTTP 200 { results: [{ toolCallId, result: "<string>" }] }
//   after call:  POST { message: { type: "end-of-call-report", call, endedReason, artifact, analysis, ... } }
// Vapi signs nothing by default, so every request must carry our shared secret (a header set on the tool and assistant
// server objects, or ?token= on the URL); requests without it are refused.
import { timingSafeEqual } from "node:crypto";
import { buildPrompt, beginMessage, TOOL_DEFS, type PromptVars } from "./agent-config.ts";
import type { Business } from "./business.ts";
import { isRecord } from "./validate.ts";

export const VAPI_TOKEN_HEADER = "x-frontdesk-token";

export function vapiVars(tz: string): PromptVars {
  return {
    now: `{{"now" | date: "%A, %B %d, %Y, %I:%M %p", "${tz}"}} (${tz.replace("_", " ")} time)`,
    calendar: "Work out dates the caller mentions (\"next Tuesday\") from today's date.",
    caller: "{{customer.number}}",
  };
}

export function sameSecret(given: string | undefined, secret: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface VapiOptions {
  serverUrl: string;
  secret: string;
  model?: string;
  voiceId?: string;
  maxCallSeconds: number;
}

/** The assistant: prompt, tools (each pointing at /vapi with the shared secret), voice, limits, end-of-call report. */
export function buildVapiAssistant(b: Business, o: VapiOptions) {
  const server = { url: o.serverUrl, timeoutSeconds: 20, headers: { [VAPI_TOKEN_HEADER]: o.secret } };
  return {
    name: `frontdesk-${b.slug}`.slice(0, 40),
    firstMessage: beginMessage(b),
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "openai",
      model: o.model ?? "gpt-4.1",
      temperature: 0.2,
      messages: [{ role: "system", content: buildPrompt(b, vapiVars(b.timezone)) }],
      tools: [
        ...TOOL_DEFS.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: { type: "object", properties: t.parameters, required: t.required } },
          server,
          ...(t.speak ? { messages: [{ type: "request-start", content: t.speak }] } : {}),
        })),
        { type: "endCall" },
      ],
    },
    voice: { provider: "vapi", voiceId: o.voiceId ?? "Elliot" },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    maxDurationSeconds: Math.max(60, Math.min(o.maxCallSeconds, 900)),
    silenceTimeoutSeconds: 20,
    server,
    serverMessages: ["end-of-call-report"],
    // No call audio is kept anywhere: the demo is the live line, and callers' voices are not stored.
    artifactPlan: { recordingEnabled: false },
  };
}

export interface VapiToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** The tool calls in a Vapi "tool-calls" message; arguments may come as an object or a JSON string. */
export function readToolCalls(message: Record<string, unknown>): VapiToolCall[] {
  const list = Array.isArray(message["toolCallList"]) ? message["toolCallList"] : [];
  const out: VapiToolCall[] = [];
  for (const tc of list) {
    if (!isRecord(tc) || typeof tc["id"] !== "string") continue;
    const fn = isRecord(tc["function"]) ? tc["function"] : tc;
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    let args: unknown = fn["arguments"] ?? fn["parameters"] ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    out.push({ id: tc["id"], name, args });
  }
  return out;
}

/** Caller id and call id from a Vapi call object. */
export function vapiCallInfo(message: Record<string, unknown>): { callId?: string; fromNumber?: string; type?: string } {
  const call = isRecord(message["call"]) ? message["call"] : {};
  const customer = isRecord(call["customer"]) ? call["customer"] : isRecord(message["customer"]) ? message["customer"] : {};
  return {
    ...(typeof call["id"] === "string" ? { callId: call["id"] } : {}),
    ...(typeof customer["number"] === "string" ? { fromNumber: customer["number"] } : {}),
    ...(typeof call["type"] === "string" ? { type: call["type"] } : {}),
  };
}

const ms = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
};

/** An end-of-call-report in the shape the post-call summary already understands (Retell's call_analyzed). */
export function endOfCallAsRetell(message: Record<string, unknown>): Record<string, unknown> {
  const call = isRecord(message["call"]) ? message["call"] : {};
  const info = vapiCallInfo(message);
  const artifact = isRecord(message["artifact"]) ? message["artifact"] : {};
  const analysis = isRecord(message["analysis"]) ? message["analysis"] : {};
  const phone = isRecord(call["phoneNumber"]) ? call["phoneNumber"] : isRecord(message["phoneNumber"]) ? message["phoneNumber"] : {};
  const start = ms(message["startedAt"]) ?? ms(call["startedAt"]);
  const end = ms(message["endedAt"]) ?? ms(call["endedAt"]);
  const seconds = typeof message["durationSeconds"] === "number" ? message["durationSeconds"] : undefined;
  const recording = [message["recordingUrl"], artifact["recordingUrl"], isRecord(artifact["recording"]) ? artifact["recording"]["url"] : undefined].find((x) => typeof x === "string");
  return {
    event: "call_analyzed",
    call: {
      call_id: info.callId,
      call_type: info.type === "webCall" ? "web_call" : info.type ? "phone_call" : undefined,
      from_number: info.fromNumber,
      to_number: typeof phone["number"] === "string" ? phone["number"] : undefined,
      start_timestamp: start,
      end_timestamp: end,
      duration_ms: seconds !== undefined ? Math.round(seconds * 1000) : start !== undefined && end !== undefined ? end - start : undefined,
      disconnection_reason: message["endedReason"] ?? call["endedReason"],
      recording_url: recording,
      call_analysis: { call_summary: analysis["summary"] ?? message["summary"], call_successful: analysis["successEvaluation"] },
    },
  };
}
