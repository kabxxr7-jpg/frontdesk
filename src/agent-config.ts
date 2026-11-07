// The agent's prompt and the Retell LLM / agent JSON, generated from business.json so a price or an hour lives in
// one place. Field names follow the Retell API reference read on 2026-11-07 (create-retell-llm, create-agent).
import type { Business } from "./business.ts";
import { formatPhone, joinList, renderHours, renderServiceLine, renderTokens, usd } from "./text.ts";

export const TOOL_DEFS: { name: string; description: string; parameters: Record<string, unknown>; required: string[]; speak?: string }[] = [
  {
    name: "lookup_faq",
    description: "Answer a question about the business (hours, location, prices, insurance, payment, policies) from the business's own fact sheet. Read the returned message to the caller.",
    parameters: { question: { type: "string", description: "The caller's question in their own words." } },
    required: ["question"],
  },
  {
    name: "get_availability",
    description: "Find open times for a service. Call before offering any time. Dates are YYYY-MM-DD in the business's local time.",
    parameters: {
      service: { type: "string", description: "The service name or id." },
      date_from: { type: "string", description: "First day to search, YYYY-MM-DD. Omit for today." },
      date_to: { type: "string", description: "Last day to search, YYYY-MM-DD. Omit to search a week." },
      part_of_day: { type: "string", enum: ["morning", "afternoon", "any"] },
      staff: { type: "string", description: "Only when the caller asks for a specific person." },
    },
    required: ["service"],
    speak: "Let me check the schedule.",
  },
  {
    name: "book_appointment",
    description: "Book one time the caller has chosen. Only after get_availability and after reading back the details. Never invent a time.",
    parameters: {
      service: { type: "string" },
      start: { type: "string", description: "Local start time YYYY-MM-DDTHH:MM, exactly as returned in slots[].start (offset allowed)." },
      customer_name: { type: "string", description: "First and last name." },
      phone: { type: "string", description: "Callback number. Omit to use the number they are calling from." },
      email: { type: "string", description: "For the confirmation email; spelled back and confirmed." },
      address: { type: "string", description: "Job address, when the business needs one." },
      notes: { type: "string", description: "The reason for the visit, in the caller's words." },
      staff: { type: "string", description: "Only when the caller asked for a specific person." },
    },
    required: ["service", "start", "customer_name"],
    speak: "One moment while I book that.",
  },
  {
    name: "reschedule_appointment",
    description: "Move an existing booking to a new time. Find it by confirmation code, or by the phone number it was booked under.",
    parameters: {
      code: { type: "string", description: "Four-character confirmation code, if the caller has it." },
      phone: { type: "string", description: "Number the booking is under; omit to use the caller's number." },
      current_start: { type: "string", description: "Only when the tool asked which booking: its start, YYYY-MM-DDTHH:MM." },
      new_start: { type: "string", description: "The new local start time, YYYY-MM-DDTHH:MM, checked with get_availability first." },
    },
    required: ["new_start"],
    speak: "Let me move that for you.",
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing booking after the caller confirms. Find it by confirmation code, or by the phone number it was booked under.",
    parameters: {
      code: { type: "string" },
      phone: { type: "string" },
      current_start: { type: "string", description: "Only when the tool asked which booking." },
    },
    required: [],
  },
  {
    name: "request_transfer",
    description: "Decide whether and where to transfer: when the caller asks for a person, has an urgent problem, or you cannot help. Follow the returned instruction exactly.",
    parameters: { reason: { type: "string", description: "Why, in the caller's own words (include any symptoms or damage they described)." } },
    required: ["reason"],
  },
];

/** How the voice platform fills in the time and the caller's number (Retell by default). */
export interface PromptVars {
  now: string;
  calendar: string;
  caller: string;
}

export function retellVars(tz: string): PromptVars {
  return { now: `{{current_time_${tz}}}`, calendar: `Next two weeks: {{current_calendar_${tz}}}`, caller: "{{user_number}}" };
}

export function buildPrompt(b: Business, vars: PromptVars = retellVars(b.timezone)): string {
  const services = b.services.map((s) => `- ${renderServiceLine(s)}`).join("\n");
  const staff = b.staff.map((s) => `- ${s.name}, ${s.title}`).join("\n");
  const cw = b.agent.customerWord;
  return `You are ${b.agent.name}, the phone receptionist for ${b.name}, a ${b.vertical}${b.fictional ? " (a fictional business used as a live demonstration; if asked, say so honestly)" : ""}.

## Facts
- Now: ${vars.now}. ${vars.calendar}
- Address: ${b.address}${b.serviceArea ? `. Service area: ${b.serviceArea}` : ""}
- ${renderHours(b)}
- Caller's number: ${vars.caller} (empty on a web call; then ask for one).
- Services:
${services}
- Team:
${staff}
- Cancellation: ${b.policies.cancellationNoticeHours} hours notice${b.policies.lateCancelFeeUsd > 0 ? `, otherwise a ${usd(b.policies.lateCancelFeeUsd)} late fee may apply` : ""}.

## How to talk
- Warm, brief, natural. One question at a time. Short sentences; this is a phone call.
- Say times like "Tuesday the 10th at 9:30 AM". Never read out ISO dates, ids or JSON.
- You are an AI assistant. If someone asks whether you are a person, say you are an AI receptionist.
- Never give ${cw === "patient" ? "medical or dental" : "technical, safety or legal"} advice. Never invent prices, times or policies: use the tools.

## Booking
1. Ask what they need and pick the service. If unclear, ask.
2. Call get_availability (use date_from/date_to for days they mention, worked out from the calendar above). Offer two or three of the returned times.
3. When they choose: get first and last name; confirm the callback number (offer the number they are calling from); ${b.agent.collectAddress ? "get the address for the job; " : ""}ask for an email for the confirmation and have them spell it, then spell it back.
4. Read back service, day, time and name, then call book_appointment with the slot's exact start.
5. Read the tool's message, including the confirmation code letter by letter.
- If a tool says a time is taken or not possible, offer the alternatives it returns.
- To move or cancel: ask for the confirmation code, or use the number they booked with; then reschedule_appointment or cancel_appointment. Confirm before cancelling.

## Questions
- Use lookup_faq for any question about the business and read its answer. If it has no answer, offer a message or a person.

## Urgent problems and people
- If the caller describes ${joinList(b.urgent.rules.slice(0, 3).map((r) => r.id.replace(/_/g, " ")))} or anything that sounds urgent, call request_transfer right away with their words. ${renderTokens(b.urgent.emergencyMessage, b)}
- If any tool returns error "emergency_detected", stop booking and follow its instruction and message at once.
- If they ask for a person, call request_transfer and follow its instruction exactly. Only call a transfer tool when the instruction says so.
- Out of hours, take a message: name, number, what it is about. The team receives it.

## Ending
- Ask if there is anything else. Then say goodbye and call end_call.
- Keep calls short; this line ends calls after a few minutes.
- If the caller is abusive or the call is clearly a test of limits, politely end the call.
`;
}

export function beginMessage(b: Business): string {
  return `Thanks for calling ${b.name}, this is ${b.agent.name}. How can I help you today?`;
}

export interface RetellUrls {
  toolBase: string;
  model?: string;
}

export function buildRetellLlm(b: Business, urls: RetellUrls) {
  return {
    start_speaker: "agent",
    begin_message: beginMessage(b),
    general_prompt: buildPrompt(b),
    model_config: { type: "cascading", primary: { model: urls.model ?? "gpt-4.1" }, temperature: 0.2 },
    general_tools: [
      ...TOOL_DEFS.map((t) => ({
        type: "custom",
        name: t.name,
        description: t.description,
        url: `${urls.toolBase}/tools/${t.name}`,
        method: "POST",
        parameters: { type: "object", properties: t.parameters, required: t.required },
        speak_during_execution: Boolean(t.speak),
        ...(t.speak ? { execution_message_description: t.speak, execution_message_type: "static_text" } : {}),
        speak_after_execution: true,
        timeout_ms: 12000,
        max_retry: 0,
      })),
      {
        type: "transfer_call",
        name: "transfer_to_front_desk",
        description: "Only when request_transfer says tool_to_call is transfer_to_front_desk.",
        transfer_destination: { type: "predefined", number: b.phones.frontDesk },
        transfer_option: { type: "cold_transfer" },
      },
      ...(b.phones.emergency
        ? [{
            type: "transfer_call",
            name: "transfer_to_emergency_line",
            description: "Only when request_transfer says tool_to_call is transfer_to_emergency_line.",
            transfer_destination: { type: "predefined", number: b.phones.emergency.phone },
            transfer_option: { type: "cold_transfer" },
          }]
        : []),
      { type: "end_call", name: "end_call", description: "End the call after saying goodbye." },
    ],
  };
}

export function buildRetellAgent(b: Business, o: { llmId: string; webhookUrl: string; voiceId: string; maxCallSeconds: number }) {
  return {
    agent_name: `frontdesk-${b.slug}`,
    response_engine: { type: "retell-llm", llm_id: o.llmId },
    voice_id: o.voiceId,
    language: "en-US",
    webhook_url: o.webhookUrl,
    webhook_events: ["call_started", "call_ended", "call_analyzed"],
    max_call_duration_ms: Math.max(60, Math.min(o.maxCallSeconds, 900)) * 1000,
    end_call_after_silence_ms: 20000,
    data_storage_setting: "everything",
  };
}

export function demoFacts(b: Business): { label: string; value: string }[] {
  return [
    { label: "Front desk (fictional)", value: formatPhone(b.phones.frontDesk) },
    { label: "Hours", value: renderHours(b) },
  ];
}
