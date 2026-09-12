# Assistant

Personal phone assistant. Chat in plain English, or have it place natural-sounding outbound calls for restaurant inquiries, pickup orders, messages to contacts, and similar errands.

React frontend + Express backend. Outbound voice runs through **Vapi** + **Twilio**. Planning and lookups use **OpenAI**.

For contributor rules and hard product constraints (location, conversation style, storage), see [`AGENTS.md`](./AGENTS.md).

---

## What it does

| You say | What happens |
| --- | --- |
| *"What time is it in Tokyo right now?"* | Chat answer from the **server clock** — never guessed. |
| *"Call Covert Honda in Austin and ask if they have the CR-V Hybrid in stock."* | Finds the nearby dealer, dials, asks like a shopper — not a script dump. |
| *"Does the Chipotle on South Congress still take walk-in orders?"* then later *"make a call"* | Remembers the **whole chat**, dials that location, and asks for you. |
| *"Pickup a large pepperoni and a side of wings from Joe's Pizza on Main St."* | Places the pickup with those items already named. |
| *"Call Joe's Pizza and make a pickup order"* (no items) | Asks **what to order** before it dials. |
| *"Call Mom and say I'll be 20 minutes late for dinner."* | Dials your saved contact and delivers the message. |
| *"Call the nearest dry cleaner and ask if they can get a suit back by Friday."* | Looks up a place near your Settings area, dials, asks, wraps up politely. |
| *"Call Domino's and ask if they deliver pineapple pizza to my area — don't judge me."* | Yes, it'll ask. No, it won't roast you on the call (much). |

---

## Features

### Home chat + missions
- Everyday Q&A (time, weather, facts) stays in **chat**.
- Call / order / “make a call” creates a **mission** with a preview, then live dial.
- Chat history is remembered (local + server). A thin *"make a call"* / *"call them"* inherits who, where, and what to say from the thread.
- Light / dark theme, contacts, settings (name, phone, area via geolocation + address).
- Browser notifications when a call finishes (permission in Settings).
- History page with mission cards; live transcript while a call is in progress.

### Clarification (only when dialing is blocked)
- **Menu / availability inquiry** → dial immediately. Never ask “what would you like to order?”
- **Pickup with no items** → ask items (and optional notes) first.
- **Items already named** → do not re-ask.
- **Contact / message calls** → ready without a form.
- Never ask the user for facts the **callee** should answer on the phone.

### Location-aware business search
- Settings area + lat/lng bias every lookup.
- A city / landmark **named in the request** beats the Settings area (and drops old coordinates so they don’t drag search back).
- Nearest branch wins; far franchise hits (e.g. Prosper when you’re in Leander) are rejected.
- Google Places when `GOOGLE_PLACES_API_KEY` is set; otherwise OpenAI web search.

### Natural phone conversation
- Opens with **"Hi."** only — no name dump, no full order in the first message.
- Idle nudge **"Can you hear me?"** only on true silence at pickup (~15s), never after the chat starts or after wrap-up.
- Straight talk: no *"I was wondering…"*; don’t say the restaurant’s name **to** the restaurant.
- One short turn at a time; wait for their reply.
- Inquiry yes → *"Cool, thanks for the info — I'll come buy some later."* — **never** bare *"Goodbye."*
- Friend/invite bare *"no"* → ask why once, then wrap up.
- Stay on the line if unclear — ask them to repeat; don’t hang up mid-confusion.
- Name + pronoun fidelity (e.g. *"Anna (my brother)"* → he/him forever).

### Voice & models
- Default voice: **Vapi Sagar v2** (`VAPI_VOICE_PROVIDER=vapi`, `VAPI_VOICE_ID=Sagar`).
- Optional ElevenLabs if you set `VAPI_VOICE_PROVIDER=11labs` (with fallback to Sagar).
- Live call LLM: **gpt-4.1** (`VAPI_LLM_MODEL`).
- Spoken-brief planner: **gpt-4.1** (`OPENAI_PLAN_MODEL`).
- Cheap lookups / clarify: **gpt-4o-mini**.
- Vapi `customer.name` is trimmed to ≤ 40 characters (API limit).

### Mission lifecycle
- Preview → start calls → live status + transcript → outcome summary.
- Vapi webhook (`end-of-call-report`) **finalizes** the mission even if nobody is watching the page.
- History list reconciles a few stale “In progress” cards per load.
- Retry / hangup endpoints for failed or live targets.

### Storage (serverless-safe)
- Production must use **shared** storage. Per-instance `/tmp` or an in-memory `Map` caused **"Mission not found"** across instances.
- Backend preference: **Upstash Redis** (`KV_REST_*`) → else **Vercel Blob** (`BLOB_READ_WRITE_TOKEN`) → else local `backend/data/*.json` (dev only).
- Keys/paths: `mission:<id>`, `missions:index`, `call:<callId>` → mission id, `chat:<phone digits>`.

---

## Project layout

```
frontend/          React + Vite UI (Home, History, Mission, Settings, Contacts)
backend/           Express API
  src/routes/      missions, chat, clarify, Vapi webhook
  src/services/    openai, vapi, places, location, conversation, store, chat
AGENTS.md          Hard rules for humans and coding agents
.env.example       Documented environment variables
```

---

## Setup

### 1. Environment

```bash
cp .env.example .env
```

Fill at least:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Planning, clarify, lookups, chat |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | Outbound caller ID via Vapi |
| `VAPI_API_KEY` / `VAPI_ASSISTANT_ID` | Voice calls |
| `VAPI_PHONE_NUMBER_ID` | Optional; auto-imported from Twilio if empty |
| `VAPI_VOICE_PROVIDER` / `VAPI_VOICE_ID` | Default `vapi` / `Sagar` |
| `VAPI_LLM_MODEL` / `OPENAI_PLAN_MODEL` | Default `gpt-4.1` |
| `PUBLIC_APP_URL` | Public base URL for the Vapi webhook (your deployed API origin) |
| `BLOB_READ_WRITE_TOKEN` or `KV_REST_API_URL` + `KV_REST_API_TOKEN` | **Required in production** shared storage |
| `GOOGLE_PLACES_API_KEY` | Optional; better restaurant lookup |

Never commit `.env`. Rotate any keys that were shared outside secrets storage.

### 2. Install & run locally

```bash
cd backend && npm install
cd ../frontend && npm install

# from repo root
npm run dev:api    # http://localhost:3001
npm run dev:web    # http://localhost:5173 (proxies /api → backend)
```

Local missions/chat persist under `backend/data/` when Redis/Blob env vars are unset.

### 3. First-time app use

1. Open Settings — save **name**, **phone**, and **area** (geolocation recommended).
2. Optionally add Contacts (e.g. Mom).
3. On Home: ask a question, or describe a call / order.
4. Preview the plan → **Start calls** → watch the live transcript.

**Twilio Trial:** can only dial numbers you verified in Twilio. Failures surface a clear message (not a 502).

---

## Main API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/chat` | Q&A with history + profile |
| `GET`/`POST` | `/api/chat/history` | Persist thread by phone |
| `POST` | `/api/clarify` | Ready? or blocking questions (`history` supported) |
| `POST` | `/api/missions` | Create mission (`dryRun`, `history`, profile, contacts, files) |
| `GET` | `/api/missions` | List (reconciles a few stale open missions) |
| `GET` | `/api/missions/:id` | Detail; refreshes/finalizes when needed |
| `POST` | `/api/missions/:id/execute` | Start calls from preview |
| `POST` | `/api/missions/:id/refresh` | Pull latest call state from Vapi |
| `POST` | `/api/missions/:id/retry` | Redial unreachable targets |
| `POST` | `/api/missions/:id/hangup` | End live calls |
| `DELETE` | `/api/missions/:id` | Remove mission |
| `POST` | `/api/vapi/webhook` | Live transcript + end-of-call finalize |

---

## How a call is planned

1. **Clarify** — only ask if something blocks dialing (who / order items). Inquiries and complete orders go straight through.
2. **Plan** — OpenAI builds title, targets, `spokenBrief` (numbered lines of what to *say*), call objective.
3. **Resolve** — Places / web search with location bias; prefer request-named area over Settings when present.
4. **Dial** — Vapi outbound with system prompt from `buildMissionCallPrompt`, voice override, Deepgram transcriber, webhook URL.
5. **Finalize** — Webhook + polling settle status; outcome summary when calls end.

Example inquiry brief:

```text
1. Just checking — do you guys have the CR-V Hybrid in stock?
2. If yes: Cool, thanks for the info — I'll come by later.
3. If no: Ah okay — thanks anyway.
```

---

## Deploy

Typical target is **Vercel** (or any host that can run the Express API + static frontend).

1. Set all required env vars in the host (same names as `.env.example`).
2. Set `PUBLIC_APP_URL` to your public API origin so Vapi can reach `/api/vapi/webhook`.
3. Provision **Blob** or **Redis** and inject the tokens — do not rely on disk or in-memory maps.
4. Deploy; point the Vapi assistant `server.url` at `{PUBLIC_APP_URL}/api/vapi/webhook` if not overridden per call.

Push-to-deploy is fine once the project is linked. Never commit secrets.

Optional CLI:

```bash
npx vercel login
npx vercel --prod
```

---

## Security

- Keep secrets in `.env` / host env only.
- Rotate keys if they ever appeared in chat, screenshots, or commits.
- Twilio Auth Token and OpenAI / Vapi keys are high value — treat them as production credentials.

---

## Related docs

- [`AGENTS.md`](./AGENTS.md) — mandatory behavior for location, clarify, voice, chat→call, storage, and conversation style.
- [`.env.example`](./.env.example) — full variable list with comments.
- [Vapi outbound calling](https://docs.vapi.ai/calls/outbound-calling)
