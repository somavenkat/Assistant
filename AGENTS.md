# AGENTS.md — AI Personal Assistant

Rules for anyone (human or AI) changing this codebase.

## Location is non-negotiable for business search

When the user asks to call / order from a **named restaurant or business**, lookups MUST use their **Settings profile location** (`profile.area` + `profile.latitude` / `profile.longitude`).

### Required behavior

1. **Always bias search to the user.** Pass `locationHint`, `latitude`, and `longitude` into `lookupBusiness`, `discoverBusinesses`, and `findBusinessWithOpenAI`.
2. **Nearest branch wins.** Chains (e.g. Chowrastha) often have many cities. Never pick a flagship/first Google hit hours away when a closer location exists.
3. **Reject far matches.** If a result is clearly in another metro (e.g. Prosper/Dallas when the user is in Liberty Hill / Cedar Park / Austin area), do **not** dial it. Retry with a stricter nearby query or fail with a clear error asking the user to clarify.
4. **Put location in the query string** — e.g. `"Chowrastha near Liberty Hill, Texas"` or include coordinates — not just the brand name alone.
5. **Google Places:** when a key exists, use `locationBias` circle (~40km) around the user coordinates.
6. **OpenAI web search prompts** must include the CRITICAL LOCATION RULES from `backend/src/services/location.js`.

### Bad example (real bug)

- User in Liberty Hill, TX: *"Call Chowrastha restaurant and make pickup order"*
- App returned Chowrastha in **Prosper, TX** (~4 hours away) via `openai_discovery` / web search.
- That is a product failure. Local / nearest only.

### Good example

- Same request → search `"Chowrastha near Liberty Hill, Texas"` (with lat/lng) → return the closest Central Texas location, or say none found nearby.

## Clarification vs call script

- Do **not** ask the user for facts the **callee** should answer on the phone ("what did Sai eat?").
- Ask the user only for details that **block dialing** (who to call if unknown, order items for a pickup we are placing, etc.).

### Pickup / restaurant orders — ask before dialing

When the user wants a **pickup, takeout, or food order** and has **not** named items:

1. **Do not dial yet.** Ask what to order (items + quantities). Optional: special requests.
2. Example that must ask first: *"call Hastag India near me and make a pickup order"*
3. Example that can dial immediately: *"pickup 2 idly and 1 masala dosa from Hastag India"*
4. Hard rule lives in `needsOrderItemsBeforeCall` / `clarifyRequest` in `backend/src/services/openai.js`.
5. Direct-call shortcuts (`canPlaceDirectCall`) must **not** apply to restaurant order placement.

Contact-message calls ("call Mom and say I'll be late") stay ready without a form.

## Voice / telephony

- Outbound voice uses Vapi + Twilio. Default Vapi voice: **Sagar** (`VAPI_VOICE_ID=Sagar`).
- Twilio Trial can only call verified numbers — surface that clearly; do not 502.

### Stay on the line — never hang up mid-confusion

On live calls, the voice agent must **not disconnect** just because it did not understand the other person (noise, accent, interruption, unclear answer).

1. **Ask again politely** — e.g. "Sorry, I didn't catch that — could you say that one more time?"
2. **Clarify specifically** — ask a short yes/no or repeat-back question instead of ending the call.
3. **Stay on the call** until the goal is done, they clearly decline, or they say goodbye.
4. **Do not** cut the call early due to silence blips, half-heard words, or confusion.
5. Encode this in `buildMissionCallPrompt` (`backend/src/services/vapi.js`) whenever call scripts change.

## Deploy

- Production: Vercel at `assistant-six-omega.vercel.app`
- Push to `main` auto-deploys. Never commit `.env`.
