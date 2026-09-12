# AGENTS.md — AI Personal Assistant

Rules for anyone (human or AI) changing this codebase.

## Location is non-negotiable for business search

When the user asks to call / order from a **named restaurant or business**, lookups MUST use their **Settings profile location** (`profile.area` + `profile.latitude` / `profile.longitude`).

### Required behavior

0. **A location named in the request beats the Settings area.** If the user says a city, landmark, or cross-street, search *there* — the profile area is only the fallback for when they did not say where. When the two differ, also drop the profile `latitude`/`longitude`, or the old coordinates drag the search back to the saved city. Lives in `extractRequestedLocation` (`location.js`), `plan.requestedArea` (`planMission`), and `searchArea` in `resolveTargets` (`routes/missions.js`).
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

### Bad example (real bug — stated location ignored)

- Settings area **Round Rock**, request *"Call Chowrasta, ronald reagon, Leander …"*
- The planner built `"Chowrastha near Round Rock, Texas"`, threw away the Leander landmark the user typed, and dialed the Round Rock branch on S I-35.
- Never overwrite a location the user explicitly stated.

### Good example

- Same request → search `"Chowrastha near Liberty Hill, Texas"` (with lat/lng) → return the closest Central Texas location, or say none found nearby.

## Clarification vs call script

- Do **not** ask the user for facts the **callee** should answer on the phone ("what did Sai eat?").
- Ask the user only for details that **block dialing** (who to call if unknown, order items for a pickup we are placing, etc.).

### Menu / availability inquiry — dial immediately

When the user wants to **ask if a place has / serves / offers** something (not place an order):

1. **Dial now.** Do not ask "what would you like to order?"
2. The named dish/item is what we ask ABOUT on the call.
3. Example that must dial: *"Call Chowrasta, Ronald Reagan Road, Leander, and enquiry if they have mutton biryani."*
4. Example that must dial: *"Call Spot Fusion and ask if they have tea."*
5. Hard rule: `isMenuAvailabilityInquiry` in `openai.js` — `isOrderPlacementRequest` returns false for these, and `clarifyRequest` returns `ready: true` before the LLM clarifier can invent order questions.

**Bad (real bug):** *"enquiry if they have mutton biryani"* → 422 asking *"What specific items would you like to order?"* (suggesting "mutton biryani").

### Pickup / restaurant orders — ask before dialing

When the user wants a **pickup, takeout, or food order** and has **not** named items:

1. **Do not dial yet.** Ask what to order (items + quantities). Optional: special requests.
2. Example that must ask first: *"call Hastag India near me and make a pickup order"*
3. Example that can dial immediately: *"pickup 2 idly and 1 masala dosa from Hastag India"*
4. Hard rule lives in `needsOrderItemsBeforeCall` / `clarifyRequest` in `backend/src/services/openai.js`.
5. Direct-call shortcuts (`canPlaceDirectCall`) must **not** apply to restaurant order placement.
6. **Never re-ask for what they already said.** Items are the *only* blocker. Once they are named, `clarifyRequest` returns `ready: true` before the LLM clarifier runs — the venue is resolved downstream, and ready time / price / substitutions are the restaurant's answers to give **on the call**, not a form for the user.

**Bad (real bug):** *"Call Chowrasta in Leander and order one plate of idly, to go. That's all."* → 422 asking *"What specific food items would you like to order?"* (suggesting "idly").

Contact-message calls ("call Mom and say I'll be late") stay ready without a form.

## Voice / telephony

- Outbound voice uses **Vapi Sagar v2** (`VAPI_VOICE_PROVIDER=vapi`, `VAPI_VOICE_ID=Sagar`) — Indian American accent, low latency, no third-party TTS glitches. Optional ElevenLabs only if you set `VAPI_VOICE_PROVIDER=11labs`.
- Live call LLM is **gpt-4.1** (`VAPI_LLM_MODEL`). Mission `spokenBrief` is planned with **gpt-4.1** (`OPENAI_PLAN_MODEL`). Cheap lookups stay on `gpt-4o-mini`.
- Twilio Trial can only call verified numbers — surface that clearly; do not 502.

### Straight talk — no "I was wondering"

On the phone, talk like a customer or friend. Not a concierge script.

1. Ask the thing. Ban hedging: *"I was wondering…"*, *"I was just calling to see if…"*, *"quick question…"*.
2. Talking TO a restaurant: never say their name in the question.
   - **Bad (real bug):** *"Hey, I was wondering, does Spot Fusion Kitchen serve tea?"*
   - **Good:** *"Just checking — do you guys have mutton biryani?"* → *"Yeah, we have it."* → *"Cool, thanks for the info — I'll come buy some later."*
   - **Bad (real bug):** same yes → *"Goodbye."*
3. Wrap-up is one short closer. Do not stack *"Got it. Thanks for letting me know. Have a great day."*
4. After goodbye: stay silent. Never *"Can you hear me?"* after the chat started. Idle nudge is 15s and pickup-only.
5. Encode in `HUMAN_CONVERSATION_RULES` / `buildMissionCallPrompt` (`vapi.js`) and `spokenBrief` rules in `planMission` (`openai.js`).

### Human greeting protocol — all outbound calls

Sound like a real person on a live line. Goal: they never think it is spam or a bot because we dump a script or sit in dead silence.

1. **We speak first:** first words are only **"Hi"** (or "Hello"). Then pause.
2. **If no reply after a short pause:** say **"Can you hear me?"** (once). Then continue as a normal conversation — do not sit silent again. Vapi's idle timeout cannot be under **5 seconds** (`idleTimeoutSeconds` ≥ 5).
3. **The moment they say anything** (hello, yes, who is this, hmm, background talk): answer **immediately**. Do not wait for another turn. That silence after they pick up is what makes it feel like spam/AI.
4. **Do not volunteer a name.** Never open with "This is Venkat" / "Hi this is {{name}}". Say who you are **only if they ask**.
5. After the greeting is acknowledged, get into the reason for calling **one beat at a time** — not a canned dump of every question in the first breath, but also not a freeze.
6. Encode in `backend/src/services/vapi.js`: `firstMessage` stays `"Hi."`; idle nudge is `"Can you hear me?"` with `idleTimeoutSeconds: 15` (only true dead air at pickup — 5s was firing after goodbye).

**Wrong:** Hi → they say hello → we wait.  
**Wrong:** Hi this is Venkat, I need 2 idly pickup…  
**Wrong (script dump):** "How are you? What are you doing? I'm Venkat's assistant. What's your plan? How's everything going?"  
**Right:** Hi → (~5s silence) Can you hear me? → they talk → we talk back right away, like a person.  
**Right (turn-by-turn):** "How are you?" → they answer → "What are you up to?" → … → intro only if requested → … → "What's the plan?"

### One beat at a time — never monologue the brief

`spokenBrief` / "What we'll say on the call" is a **conversation guide**, not a paragraph to read aloud.

1. Plan it as a **numbered turn list** (ask A → wait → react → ask B).
2. On the live call, say **one** short question or statement, then wait for their reply before the next topic.
3. Never stack how-are-you + what-are-you-doing + intro + plans into a single turn.
4. If the user asked you to introduce yourself / say you're their assistant, do that as **its own turn** after the greeting — not glued to every other question.
5. Encode in mission planning (`openai.js` `spokenBrief` rules + `ensureTurnByTurnBrief`) and `HUMAN_CONVERSATION_RULES` in `vapi.js`.

### Name + pronoun fidelity (never guess gender from a name)

The user's words win. Relationship and pronouns in the request are **locks**, not hints.

1. **"ANNA (my brother)" + he/him** → callee is **male**. Always **he/him/his**. Never **she/her**, even if the name often reads feminine.
2. Spell the name **exactly** as given (Anna ≠ Ana). Do not "correct" or shorten it.
3. If gender is not stated, use **they/them** — do **not** invent she/he from the first name.
4. Gatekeeper / IVR: still use locked pronouns (*"Is Anna available?"* / *"Could you let him know…"*).
5. Encode via `extractCalleeIdentity` / `applyCalleeIdentity` in `openai.js` and the **CALLEE IDENTITY** block in `buildMissionCallPrompt` (`vapi.js`).

**Bad (real bug):** User: *call ANNA (my brother) … ask him…* → agent: *"catch up with Ana… when she's available?"*  
**Good:** *"calling for Anna… when he's available?"*

### Stay on the line — never hang up mid-confusion

On live calls, the voice agent must **not disconnect** just because it did not understand the other person (noise, accent, interruption, unclear answer).

1. **Ask again politely** — e.g. "Sorry, I didn't catch that — could you say that one more time?"
2. **Clarify specifically** — ask a short yes/no or repeat-back question instead of ending the call.
3. **Stay on the call** until the goal is done, they clearly decline *after a natural beat*, or they say goodbye.
4. **Do not** cut the call early due to silence blips, half-heard words, or confusion.
5. Encode this in `buildMissionCallPrompt` (`backend/src/services/vapi.js`) whenever call scripts change.

### Real conversation — when to accept instantly vs ask why

Talk like a real human on a live line. The model must **reason** whether the last answer is enough, or whether one natural follow-up is needed. Do **not** treat the call as a form: ask → hear first answer → hang up.

#### Take it at face value (instant OK)

- They already included a reason: *"Can't, I'm sick"* / *"We're closed for renovation"*.
- A clear yes + the detail you needed: *"Yes, 6pm works"*, *"Ready in 20, $42"*.
- They sound rushed or say they have to go.
- Nothing important for the mission is still missing.

#### Ask one short follow-up first (do not wrap up yet)

- Bare decline with no reason: *"no"*, *"not today"*, *"I'm not joining"*, *"can't make it"*.
  - Ask casually: *"Oh, how come?"* / *"Aw, any reason?"* / *"All good — something come up?"*
- Vague: *"maybe"*, *"not sure"*, *"we'll see"* → clarify once.
- Friend / family / invite / plan / hangout / sports (pickleball, dinner, movie, etc.): a bare *"not joining"* **must** get a light why (or *"maybe another day?"*) before goodbye — unless they already explained.
- Business *"we can't"* / *"don't have that"* → ask alternative, who can help, or when — once — then wrap up.

#### After they give a reason

React like a person (*"Got it, rest up"* / *"No worries, next time"*), **then** say goodbye. Never jump from their first bare *"no"* straight to *"All right, talk later."*

#### Bad vs good (real bug)

- **Bad:** Sai: *"I'm not joining today."* → us: *"All right, no problem. Talk to you later."* → *"Goodbye."*
- **Good:** Sai: *"I'm not joining today."* → us: *"Oh, how come?"* → they explain → *"Got it, no worries — maybe next time. Talk later."*

Also: never say **"Can you hear me?"** after the conversation has already started, and never after you already wrapped up.

Encode in `HUMAN_CONVERSATION_RULES` / `buildMissionCallPrompt` in `backend/src/services/vapi.js`.

## Chat vs phone missions

- Everyday questions (time, weather, facts, follow-ups) are **chat**, not a phone mission.
- Never invent the current time. Use the server clock (`Asia/Kolkata` for Hyderabad/India).
- Remember the ongoing Home chat thread (history sent with each ask).
- Encode in `backend/src/services/chat.js` and `POST /api/chat`.

### Chat first, then "make a call"

The Home thread is the brief. A later **"make a call" / "call them" / "call now"** is not a new blank errand — it means dial using **the whole conversation**.

1. **Remember the thread.** `clarifyRequest` and `planMission` receive `history`. Location, items, contacts, and what to say are read from the corpus (`conversation.js`), not from the last line alone.
2. **Ask only if something still blocks dialing.** No place/person in the chat → "Who should I call?" Pickup discussed with no items → ask items. Do **not** re-ask facts already in the thread.
3. **If the thread is enough, dial.** Plan the call from that chat: who, where, and the spoken lines (natural speech — "Do you guys have tea?" → "Cool, thanks — I'll come have some.").
4. Thin triggers live in `isThinCallTrigger` (`make a call`, `call them`, `call now`, `go ahead and call`). They are not informational queries.

**Good:** Chat "Does Spot Fusion in Leander have tea?" → later "make a call" → call Spot Fusion, ask if they have tea, if yes say you'll come have some.  
**Bad:** "make a call" after that chat → 422 / empty mission / "who should I call?"

Encode in `backend/src/services/conversation.js`, `clarifyRequest` / `planMission` (`openai.js`), `POST /api/clarify` + `POST /api/missions`, and Home passing `history`.

## Mission status must settle without a watcher

A mission may never be polled — the user closes the page, or the call ends after they navigate away. Status must still land on a terminal value.

- The Vapi `end-of-call-report` webhook **finalizes the mission itself** (`needsFinalize` → `finalizeIfReady`). Do not rely on a poll to wrap up a call.
- `isMissionPending` returns **false** once every target is terminal, so a plain `GET` will not refresh a mission whose calls already ended. That gap is what left cards stuck on "In progress" forever — `needsFinalize` exists to close it.
- `GET /api/missions` reconciles up to 3 stale missions per load via `reconcileMission`, so old stuck cards self-heal. Keep it bounded or History gets slow.
- Stale target rows (`queued` / `in-progress` saved long ago) need a real Vapi refresh, not just a finalize — the stored status lies.
- A mission with no `callId` after 15 minutes never dialed: mark it `failed` rather than leaving it spinning.

## Live call transcript

- Mid-call speech is pushed via Vapi `serverUrl` webhook (`POST /api/vapi/webhook`) and also polled from `GET /call`.
- Mission page shows a live conversation grid while the call is ringing / in progress.

## Storage — never trust the filesystem in production

Vercel runs **many function instances**, each with its own `/tmp`. Anything written to disk is invisible to the next request.

- Missions and chat history live in shared storage. `backend/src/services/store.js` picks a backend at boot and logs it: **Redis** (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) if set, else **Vercel Blob** (`BLOB_READ_WRITE_TOKEN`, what production uses today), else local `backend/data/*.json` for dev only.
- Blob paths: `mission/<id>.json`, `call/<callId>.json` → `{ missionId }`, `chat/<phone digits>.json`. Blob `get()` returns `null` when missing and streams the body — check `statusCode`, do not assume it throws.
- Never reintroduce a module-level in-memory cache (`const missions = new Map()`), and never read a mission from anywhere but the store. That is exactly what caused **"Mission not found"** seconds after a call was created — instance A held it, instance B served the poll.
- Every store call is **async**. Await it, including inside `.catch()` callbacks on background dial promises.
- Keys: `mission:<id>`, `missions:index` (sorted set, newest first), `call:<callId>` → mission id (so the Vapi webhook resolves without scanning), `chat:<phone digits>`.

## Deploy

- Production: Vercel at `assistant-six-omega.vercel.app`
- Push to `main` auto-deploys. Never commit `.env`.
