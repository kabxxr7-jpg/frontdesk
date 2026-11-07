# What a client would pay on the voice platform

**Read on 2026-11-01** from the two public pricing pages:

- Retell AI: https://www.retellai.com/pricing
- Vapi: https://vapi.ai/pricing

Neither page shows an effective date or a "last updated" date (only a 2026 copyright line), so treat every number as "what the page said on the day it was read". Prices are in US dollars as displayed. No account was opened and nothing was bought. This document gives the platform side only; it says nothing about what to charge for building or running the kit.

Language-model names that appear in the vendors' price lists are left out here on purpose: the model is the client's choice and changes often, so only the range is shown.

## Retell AI (pay as you go)

| Item | What the page says |
|---|---|
| Headline | "$0.07-$0.31 / min for AI Voice Agents"; "Go live in minutes with $10 in free credits"; "No minimums, no contracts" |
| Platform ("Retell Voice Infra") | $0.055 per minute |
| Speech (text-to-speech) | $0.015 per minute for the platform's own voices and several third-party voice providers; some premium voices $0.04 to $0.10 per minute |
| Language model | Per-minute price depends on the model chosen: from $0.0016 up to $0.64 on the page's list, where the higher figure is a "fast tier" price; many common choices sit between $0.008 and $0.16 |
| Telephony | "$0.015/min" for the listed countries (Twilio and Telnyx); the page does not separate inbound from outbound. "No Charge for Sip Trunking/Custom Telephony" |
| Phone number | "$2.00/month" per Retell number |
| Concurrent calls | 20 included; additional "$8.00/Concurrency/month" |
| Page's own example | LLM $0.04 + platform $0.055 + speech $0.015 + telephony $0.00 + add-ons $0.00 = **$0.11 per minute** |
| Billing | "Each call is tracked to the nearest second"; the page says billing covers the whole call including silence and hold; only connected calls are charged |
| After a transfer | "Once the call is transferred, the AI voice agent fee stops. Only the telephony fee continues." |
| Add-ons that matter here | SMS $0.01 per message (this kit does not use the platform's SMS); PII removal +$0.01 per minute; safety guardrails +$0.005 per minute; knowledge base +$0.005 per minute (this kit does not use one) |

## Vapi

| Item | What the page says |
|---|---|
| Platform ("hosting") fee | $0.05 per minute on the entry package ("No Success Package", pre-paid) |
| Packages | Core $29/month (pre-paid, auto-renew); Pro "10% of Vapi hosting fee" with a "$999/mo minimum"; Premier is custom and sold directly |
| Transcriber | about $0.0095 to $0.0099 per minute (as shown in the calculator) |
| Language model | $0.0077 to $0.0452 per minute (calculator range); "Provider costs with no markup" |
| Voice | $0.0146 to $0.0238 per minute (calculator range) |
| Telephony | Vapi's own telephony/SIP and web transports are free. Twilio inbound $0.008 per minute, outbound $0.014; Vonage $0.00814; Telnyx $0.0055 (charged by those providers) |
| Phone numbers | Included: 1 (entry), 5 (Core), 10 (Pro). **No per-number price is stated.** |
| Free credits | "$5 free credits to get you started" (entry package) |
| Concurrent calls | 4 (entry), 10 (Core), 30 (Pro); extra "$10 / line / month" |
| Page's own example | 1,000 minutes a month: hosting $50 + transcriber $10 + model $8 to $45 + voice $15 to $24 + transport $0 = "$82-$129/mo" |
| Add-ons | HIPAA compliance "$2,000 / month" (a veterinary clinic is not a HIPAA covered entity, but the client's lawyer decides that, not this document) |
| Billing increments | **Not stated.** |

## What the clinic in this kit might pay: an illustration, not a quote

Assumption, invented for the arithmetic: 600 calls a month averaging 3 minutes, so 1,800 minutes. The sums below combine the page numbers above; they are **not** a quote from either vendor and nothing here was measured on a platform.

| Platform | Per-minute figure used | 1,800 minutes | Notes |
|---|---|---|---|
| Retell, the page's own example | $0.11 | $198.00 | Telephony shown as $0.00 in the page's calculator |
| Retell, with the listed telephony rate added | $0.11 + $0.015 = $0.125 | $225.00 | Plus $2.00 a month for one number |
| Vapi, low end of the page's ranges | $0.05 + 0.0095 + 0.0077 + 0.0146 + 0.008 (Twilio inbound) = $0.0898 | about $161.64 | Number cost not stated |
| Vapi, high end of the page's ranges | $0.05 + 0.0099 + 0.0452 + 0.0238 + 0.008 = $0.1369 | about $246.42 | Number cost not stated |

Not included in any figure: the server that runs this kit (any small host), a real email or SMS provider (this kit sends nothing; it writes files), taxes, call recording storage, and the cost of calls that are transferred to the front desk (telephony continues after a transfer on Retell; Vapi's page does not say).

## Where the pages disagree with themselves, or say nothing

- Retell's headline range tops out at $0.31 per minute, but its own list includes fast-tier model prices above that ($0.32, $0.384 and $0.64).
- Retell's calculator shows telephony at $0.00 per minute while the rate table lists $0.015 per minute. The page does not say which option the calculator default assumes.
- Retell lists a phone number at "$2.00/month" in the same row that says "No Charge for custom phone numbers".
- Retell states the verified phone number as "$10.00/Phone number/month" in the voice section and as a "One-time $10 fee" in the chat section.
- Retell's enterprise concurrency is "No Cap" in one place and "High Cap" in another.
- Vapi's estimator total ($82) does not equal its rounded line items ($83); with unrounded inputs it is about $81.80.
- Vapi does not state a billing increment or a per-number price.
- Neither page gives an effective date.

Check both pages again before quoting anything to a client.
