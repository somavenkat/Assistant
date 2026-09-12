const OpenAI = require('openai');
const config = require('../config');

const client = new OpenAI({ apiKey: config.openaiApiKey });

function extractExplicitPhones(text = '') {
  const matches = String(text).match(
    /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g
  ) || [];
  const unique = [];
  for (const raw of matches) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10) continue;
    const e164 =
      digits.length === 10
        ? `+1${digits}`
        : digits.length === 11 && digits.startsWith('1')
          ? `+${digits}`
          : raw.startsWith('+')
            ? `+${digits}`
            : `+${digits}`;
    if (!unique.includes(e164)) unique.push(e164);
  }
  return unique;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match saved contacts mentioned by name in the request.
 * Longer names win first to avoid "Ann" matching inside "Annie".
 */
function matchContactsInRequest(request = '', contacts = []) {
  const text = String(request || '');
  if (!text.trim() || !contacts.length) return [];

  const sorted = [...contacts]
    .filter((c) => c?.name && c?.phone)
    .sort((a, b) => String(b.name).length - String(a.name).length);

  const matched = [];
  const usedRanges = [];

  for (const contact of sorted) {
    const name = String(contact.name).trim();
    if (name.length < 2) continue;
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`, 'i');
    const m = re.exec(text);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    const overlaps = usedRanges.some((r) => start < r.end && end > r.start);
    if (overlaps) continue;
    usedRanges.push({ start, end });
    matched.push({
      id: contact.id || null,
      name: contact.name.trim(),
      phone: contact.phone,
      notes: contact.notes || '',
    });
  }

  return matched.slice(0, 3);
}

const GENERIC_NAME_PATTERNS = [
  /^local\b/i,
  /^nearby\b/i,
  /^a\s+local\b/i,
  /\bdealership$/i,
  /\bdealerships\b/i,
  /^(any|some|various|several)\b/i,
  /\b(near|around)\s+(me|you)\b/i,
  /^(restaurant|dealer|agency|insurance company|clinic|shop|store|company|business)s?$/i,
];

/**
 * A target name is unusable for lookup when it's a category rather than a real business.
 */
function isGenericTargetName(name = '') {
  const n = String(name).trim();
  if (!n) return true;
  return GENERIC_NAME_PATTERNS.some((re) => re.test(n));
}

/**
 * Web-search for REAL, named businesses (with phone numbers) matching a category query.
 * Used when the user asks to shop around rather than naming a specific business.
 * MUST be near the user's profile location.
 */
async function discoverBusinesses({ query, locationHint, latitude, longitude, count = 3 }) {
  const { buildLocationContext } = require('./location');
  const location = buildLocationContext({
    area: locationHint || '',
    latitude,
    longitude,
  });
  const where = location.nearPhrase || (locationHint ? ` near ${locationHint}` : '');
  try {
    const response = await client.responses.create({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: `Find ${count} real, currently-operating businesses matching: "${query}"${where ? ` ${where}` : ''}.

${location.searchRules}

These must be actual named businesses with working public phone numbers a customer can call.

Return ONLY JSON:
{"businesses":[{"name":"","phone":"E.164 like +15125551234","address":"full street address with city/state","website":"","confidence":"high|medium|low","approxMilesFromUser":0}]}

Rules:
- Real business names only. Never return placeholders like "Local Dealership" or "Nearby Agency".
- Only include entries where you found an actual phone number AND a nearby address.
- Prefer the main sales/customer line.
- Sort nearest-first. Drop anything that looks hours away from the user.`,
    });

    const text = response.output_text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    const list = Array.isArray(parsed.businesses) ? parsed.businesses : [];
    const { looksFarFromUser } = require('./location');
    return list
      .filter((b) => b?.name && b?.phone)
      .filter((b) => !looksFarFromUser(b.address, location))
      .slice(0, count);
  } catch (err) {
    console.warn('[openai] business discovery failed:', err.message);
    return [];
  }
}

function isDirectCallRequest(request = '') {
  return /\b(call|dial|phone|ring|text|tell|ask|say|inform|let\s+\w+\s+know)\b/i.test(
    String(request)
  );
}

/** User wants US to place a food/restaurant order (not just ask someone a question). */
function isOrderPlacementRequest(request = '') {
  const text = String(request);
  // "enquiry if they have X" / "ask whether they serve Y" is NOT an order.
  if (isMenuAvailabilityInquiry(text)) return false;
  return /\b(pickup|pick[\s-]*up|takeout|take[\s-]*out|to[\s-]*go|delivery)\b/i.test(text)
    || /\b(place|make|put)\s+(an?\s+)?(order|pickup)\b/i.test(text)
    || /\border\s+(from|at|food)\b/i.test(text)
    || /\b(food|restaurant|eatery)\b.*\border\b/i.test(text)
    || /\border\b.*\b(food|restaurant|eatery|pickup)\b/i.test(text);
}

/**
 * Call to ASK if a dish/item exists — not to place an order.
 * "enquiry if they have mutton biryani" must dial immediately, never ask "what to order".
 */
function isMenuAvailabilityInquiry(request = '') {
  const text = String(request);
  if (!text.trim()) return false;
  // Explicit order verbs win — "order biryani and ask if they have raita" is still an order.
  if (/\b(pickup|pick[\s-]*up|takeout|take[\s-]*out|to[\s-]*go|delivery)\b/i.test(text)) return false;
  if (/\b(place|make|put)\s+(an?\s+)?(order|pickup)\b/i.test(text)) return false;
  if (/\border\s+(from|at|food|\d|a\s|an\s|one|two|three)/i.test(text)) return false;

  return (
    /\b(enquir(?:y|e)|inquir(?:y|e)|ask|check|see|find\s+out)\b.{0,80}\b(if|whether)\b.{0,80}\b(have|has|serve|serves|carry|carries|offer|offers|do)\b/i.test(text)
    || /\b(if|whether)\s+they\s+(have|serve|offer|carry|do)\b/i.test(text)
    || /\bdo\s+they\s+(have|serve|offer|carry)\b/i.test(text)
    || /\b(have|has|serve|serves|offer|offers)\s+[a-z].{0,40}\?/i.test(text)
    || /\bask\s+(them|if|whether)\b/i.test(text)
  );
}

const FOOD_ITEM_HINT =
  /\b(idli|idly|dosa|biryani|pizza|burger|taco|naan|curry|thali|combo|plate|slice|wings|sandwich|bowl|rice|chicken|paneer|samosa|chai|coke|sprite|lassi|tikka|kebab|noodles|fried\s*rice|manchurian|soup|salad|fries|pasta|wrap|roll|paratha|chutney|raita|appetizer|entree|entrée|dessert)\b/i;

function requestAlreadyListsOrderItems(request = '') {
  const text = String(request);
  if (FOOD_ITEM_HINT.test(text)) return true;
  // e.g. "2 pepperoni" / "3x dosa" (not times/distances)
  if (/\b\d+\s*[x×]\s*[a-z]/i.test(text)) return true;
  if (/\b\d+\s+(plates?|pcs?|pieces?|orders?|slices?)\b/i.test(text)) return true;
  return false;
}

function answersCoverOrderItems(answers = []) {
  return (answers || []).some((a) => {
    const q = String(a.question || '');
    const ans = String(a.answer || '').trim();
    if (!ans) return false;
    if (/item|order|food|dish|menu|want|pickup/i.test(q)) return true;
    if (FOOD_ITEM_HINT.test(ans) || ans.length >= 3) return true;
    return false;
  });
}

/**
 * Pickup/order calls MUST know what to order before dialing.
 * "call Hastag India and make a pickup order" with no items → ask first.
 */
function needsOrderItemsBeforeCall(request = '', answers = []) {
  if (!isOrderPlacementRequest(request)) return false;
  if (requestAlreadyListsOrderItems(request)) return false;
  if (answersCoverOrderItems(answers)) return false;
  return true;
}

function orderItemsQuestions() {
  return [
    {
      id: 'order_items',
      question: 'What items would you like to order for pickup?',
      why: 'We need the food items and quantities before calling the restaurant.',
      suggestions: [],
    },
    {
      id: 'order_notes',
      question: 'Any special requests? (spice level, no onion, utensils, etc.)',
      why: 'Optional details for the restaurant — skip if none.',
      suggestions: ['No special requests'],
    },
  ];
}

/**
 * Calling a known person to ask/tell them something is already complete —
 * those questions belong ON the call, not in a form for the user.
 * Does NOT apply to restaurant pickup/order placement.
 */
function canPlaceDirectCall({ request, contacts = [] }) {
  if (isOrderPlacementRequest(request)) return false;
  const phones = extractExplicitPhones(request);
  const matched = matchContactsInRequest(request, contacts);
  if (!phones.length && !matched.length) return false;
  return isDirectCallRequest(request);
}

/**
 * Decide whether we know enough to place calls, or need to ask the user follow-up questions.
 */
async function clarifyRequest({ request, profile, contacts = [], attachments = [], answers = [], history = [] }) {
  const { formatAttachmentsForPrompt } = require('./attachments');
  const { isInformationalQuery } = require('./chat');
  const {
    conversationCorpus,
    conversationBlock,
    isThinCallTrigger,
    parseChatHistory,
    whoToCallQuestions,
  } = require('./conversation');
  const attachmentBlock = formatAttachmentsForPrompt(attachments);
  const corpus = conversationCorpus(request, history);
  const priorUser = parseChatHistory(history).filter(
    (m) => m.role === 'user' && !isThinCallTrigger(m.content)
  );

  // A bare "make a call" is not a question — it inherits the thread.
  if (
    !isThinCallTrigger(request) &&
    isInformationalQuery(request, contacts) &&
    !canPlaceDirectCall({ request: corpus, contacts })
  ) {
    return {
      ready: false,
      informational: true,
      questions: [],
      finalBrief: '',
      summaryBullets: [],
    };
  }

  if (canPlaceDirectCall({ request: corpus, contacts })) {
    const matched = matchContactsInRequest(corpus, contacts);
    const who = matched.map((c) => c.name).join(', ') || 'the number in the request';
    return {
      ready: true,
      questions: [],
      finalBrief: buildFallbackBrief(conversationBlock(request, history), answers),
      summaryBullets: [`Call ${who} and handle this on the phone.`],
    };
  }

  // Hard rule: never dial a pickup/order without knowing the items.
  if (needsOrderItemsBeforeCall(corpus, answers)) {
    return {
      ready: false,
      questions: orderItemsQuestions(),
      finalBrief: '',
      summaryBullets: [],
    };
  }

  // Mirror of the rule above: items are the ONLY thing that blocks dialing a pickup.
  // Once they are named, go — the venue is resolved downstream, and everything else
  // (ready time, price, substitutions) is the restaurant's answer to give on the call.
  if (isOrderPlacementRequest(corpus)) {
    return {
      ready: true,
      questions: [],
      finalBrief: buildFallbackBrief(conversationBlock(request, history), answers),
      summaryBullets: ['Call the restaurant and place the pickup order as described.'],
    };
  }

  // "Ask if they have X" / "enquiry about mutton biryani" — dial now. Never ask what to order.
  if (isMenuAvailabilityInquiry(corpus)) {
    return {
      ready: true,
      questions: [],
      finalBrief: buildFallbackBrief(conversationBlock(request, history), answers),
      summaryBullets: ['Call and ask if they have the item — this is an inquiry, not an order.'],
    };
  }

  if (
    isThinCallTrigger(request) &&
    !priorUser.length &&
    !(answers || []).some((a) => String(a.answer || '').trim())
  ) {
    return {
      ready: false,
      questions: whoToCallQuestions(),
      finalBrief: '',
      summaryBullets: [],
    };
  }

  // Chat already named the place / ask — "make a call" means do that, don't re-ask.
  if (isThinCallTrigger(request) && priorUser.length) {
    return {
      ready: true,
      questions: [],
      finalBrief: buildFallbackBrief(conversationBlock(request, history), answers),
      summaryBullets: ['Place the call using the conversation so far.'],
    };
  }

  // One round of answers is enough — don't keep the user in a form loop.
  const filledAnswers = (answers || []).filter((a) => String(a.answer || '').trim());
  if (filledAnswers.length > 0) {
    return {
      ready: true,
      questions: [],
      finalBrief: buildFallbackBrief(conversationBlock(request, history), filledAnswers),
      summaryBullets: filledAnswers.map((a) => `${a.question}: ${a.answer}`),
    };
  }

  const answerBlock = answers.length
    ? answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n')
    : '(no follow-up answers yet)';

  const contactsBlock = contacts.length
    ? contacts.map((c) => `- ${c.name}: ${c.phone}`).join('\n')
    : '(none saved)';

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You decide if a personal concierge can PLACE a phone call now. Use the FULL chat thread — a later "make a call" refers to what they already discussed. Ask the user only for details we must know BEFORE dialing. Never ask for facts the callee should answer on the phone. For restaurant pickup/orders, NEVER set ready:true unless specific food items (and quantities) are already known in the request or the chat. For menu/availability inquiries ("ask if they have X"), ALWAYS ready:true — never ask what to order.',
      },
      {
        role: 'user',
        content: `User profile: ${profile.name}, ${profile.phone}, area: ${profile.area || 'unknown'}
Saved contacts:
${contactsBlock}

${conversationBlock(request, history)}

Latest line (may be just "make a call"):
"""
${request}
"""

${attachmentBlock ? `Uploaded file details:\n${attachmentBlock}\n` : ''}
Follow-up Q&A so far:
${answerBlock}

Decide if we have enough to PLACE the call(s).

HARD RULE — pickup / food order:
- If the user wants a pickup, takeout, or restaurant order and has NOT named specific items, ready:false.
- Ask what to order (items + quantities). Optional: special requests.
- Example that is NOT ready: "call Hastag India near me and make a pickup order"
- Example that IS ready: "pickup 2 idly and 1 masala dosa from Hastag India"

HARD RULE — menu / availability inquiry (NOT an order):
- "enquiry / inquire / ask if they have X", "do they have X", "whether they serve X" → ready:true.
- Do NOT ask what to order. The named dish is what we ask ABOUT on the call.
- Example that IS ready: "Call Chowrasta and enquiry if they have mutton biryani"
- Example that IS ready: "Call Spot Fusion and ask if they have tea"

Ask the USER only if WE cannot dial without it:
- "order food from X" / "make a pickup order" and no items → which items (required)
- "book an appointment" and no service/time → service, day/time window
- "shop car lease" with no budget/model → vehicle type, budget
- "make a reservation" with no party/date → party size, date, time
- who to call is unknown and not in contacts

NEVER ask the user:
- Anything they told us to ASK or FIND OUT from the other person (dinner, routine, quotes, availability, prices)
- How the assistant should greet, what name to use, or call-script wording — put that in the brief
- Details already in the request, profile, or contacts

If the job is "call [person] and ask them …" and we know who (contact or phone), and it is NOT a restaurant order, ready:true immediately.

Return ONLY JSON:
{
  "ready": true|false,
  "questions": [
    {"id":"short_key","question":"one short question","why":"why it's needed to DIAL","suggestions":["option A","option B"]}
  ],
  "finalBrief": "if ready:true, a complete single-paragraph brief combining the original request and all answers. Empty string if not ready.",
  "summaryBullets": ["if ready:true, key confirmed details"]
}

Rules:
- Ask at most 3 questions, only if they block dialing.
- Prefer ready:true ONLY when dialing is not blocked.
- suggestions are optional; use [] when free text is needed.`,
      },
    ],
  });

  const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
  let questions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, 4) : [];
  let ready = Boolean(parsed.ready) || questions.length === 0;

  // Safety net if the model tries to skip order details.
  if (ready && needsOrderItemsBeforeCall(corpus, answers)) {
    ready = false;
    questions = orderItemsQuestions();
  }

  // Safety net: never invent "what to order" for a menu inquiry.
  if (!ready && isMenuAvailabilityInquiry(corpus)) {
    ready = true;
    questions = [];
  }

  return {
    ready,
    questions: ready ? [] : questions,
    finalBrief: ready
      ? parsed.finalBrief || buildFallbackBrief(conversationBlock(request, history), answers)
      : '',
    summaryBullets: Array.isArray(parsed.summaryBullets) ? parsed.summaryBullets : [],
  };
}

function buildFallbackBrief(request, answers = []) {
  if (!answers.length) return request;
  const extra = answers.map((a) => `${a.question} ${a.answer}`).join(' ');
  return `${request} Additional details: ${extra}`;
}

/**
 * Turn a free-form user request into a multi-call mission plan.
 */
async function planMission({ request, profile, attachments = [], contacts = [], history = [] }) {
  const { formatAttachmentsForPrompt } = require('./attachments');
  const { toE164US } = require('./places');
  const { extractRequestedLocation } = require('./location');
  const { conversationCorpus, conversationBlock } = require('./conversation');
  const attachmentBlock = formatAttachmentsForPrompt(attachments);
  const corpus = conversationCorpus(request, history);
  const requestedArea = extractRequestedLocation(corpus);
  const explicitPhones = extractExplicitPhones(
    `${corpus}\n${attachmentBlock}\n${(attachments || []).map((a) => a.extractedText || '').join('\n')}`
  );
  const matchedContacts = matchContactsInRequest(corpus, contacts);

  const contactsBlock = contacts.length
    ? contacts
        .map((c) => `- ${c.name}: ${c.phone}${c.notes ? ` (${c.notes})` : ''}`)
        .join('\n')
    : '(none saved)';

  const prompt = `You are planning phone errands for a personal assistant app.
Keep it SIMPLE. Prefer calling a saved contact or an explicit phone number over inventing businesses.

User profile:
- Name: ${profile.name}
- Phone: ${profile.phone}
- Area: ${profile.area || 'unknown'}
- Coordinates: ${profile.latitude != null && profile.longitude != null ? `${profile.latitude}, ${profile.longitude}` : 'unknown'}

Location named in THIS request (beats the profile area when present): ${requestedArea || '(none — use the profile area)'}

IMPORTANT: Any business/restaurant you plan to call MUST be near the SEARCH AREA, which is the location named in the request if there is one, otherwise the profile area. Put that search area into each target's searchQuery (e.g. "Chowrastha near Liberty Hill, Texas"). Never plan a call to a distant city branch when a local one exists.
If the user named a city, landmark, or cross-street (e.g. "Chowrasta, ronald reagan, Leander"), that location WINS — do NOT replace it with the profile area, and keep the landmark in the searchQuery (e.g. "Chowrastha Ronald Reagan Blvd Leander, Texas").
Saved contacts (use these when the user names a person):
${contactsBlock}

Contacts matched in this request:
${
  matchedContacts.length
    ? matchedContacts.map((c) => `- ${c.name} → ${c.phone}`).join('\n')
    : '(none)'
}

${conversationBlock(request, history)}

Latest user line (if this is only "make a call" / "call them", the errand is whatever the chat already decided):
"""
${request}
"""

${
  attachmentBlock
    ? `Supporting files/data:\n${attachmentBlock}\n`
    : ''
}

Phone numbers explicitly found in the request/files:
${explicitPhones.length ? explicitPhones.join(', ') : '(none)'}

Return ONLY JSON with:
{
  "title": "short mission title",
  "category": "direct_call|pickup_order|insurance_quote|appointment|reservation|price_check|general_inquiry",
  "goal": "one sentence goal",
  "requirements": ["bullet requirements"],
  "compareOffers": true/false,
  "maxTargets": 1-3,
  "targets": [
    {
      "name": "who we are calling",
      "phone": "E.164 if known from user/contact, else empty string",
      "searchQuery": "ONLY if phone is empty",
      "reason": "why this target"
    }
  ],
  "discoveryQuery": "when the user asked for a CATEGORY of business rather than a specific one, put the search phrase here (e.g. 'car dealerships offering lease deals'). Empty string otherwise.",
  "requestedArea": "the city/area the USER named in this request (e.g. 'Leander, Texas'), or empty string if they did not name one. Never copy the profile area here.",
  "callObjective": "what success looks like",
  "spokenBrief": "NUMBERED turn-by-turn guide of what a real person would SAY, in their actual words. Each line = one short spoken line (or a wait). Write the words they should use — 'Do you guys have tea?' not 'Ask whether the restaurant serves tea'. Never hedge ('I was wondering'). Never use the business name when talking TO that business. Same name spelling and pronouns the user gave.",
  "firstMessageTemplate": "MUST be only Hi. Never put the order or message here.",
  "notesForCaller": "talk like a customer/friend; one beat; no hedging; no business-name-to-itself",
  "calleeIdentity": {
    "nameAsGiven": "exact name spelling from the user",
    "relation": "brother|sister|mom|dad|friend|null",
    "pronouns": "he/him|she/her|they/them"
  }
}

CRITICAL RULES:
1. If the user named a saved contact (e.g. "call Mom and say..."), category MUST be "direct_call" and target.phone MUST be that contact's number. Deliver their message.
2. If the user provided phone number(s), dial those numbers only. Do NOT invent businesses.
3. If they said what to say, put that in spokenBrief as a TURN-BY-TURN list (1. ask X — wait 2. then Y …). firstMessageTemplate must stay "Hi." — do not dump the message as the opening line or as one monologue.
4. Only search for businesses when NO phone and NO matching contact was given.
4b. If the latest line is "make a call" / "call them" / "call now", plan the call from the CONVERSATION so far (who, where, what to say). Do not invent a new errand. spokenBrief must follow those chat instructions in natural speech.
5. Never invent phone numbers.
6. Target names must be REAL, specific businesses (e.g. "Covert Honda Austin"), never placeholders like "Local Car Dealership" or "Nearby Insurance Agency". If you cannot name real businesses confidently, leave "targets" as [] and set "discoveryQuery" instead.
7. Keep maxTargets <= 3.
8. For invites/plans/questions to people (pickleball, dinner, hangout, etc.), callObjective and notesForCaller must say: if they decline without a reason, ask why once, react, then wrap up — do not instantly goodbye.
9. spokenBrief is the WORDS to say, not a task list. Each numbered line should be speakable as-is.
10. spokenBrief BAD (robot / hedge / third-person):
"1. Ask if Sport Fusion Kitchen serves tea
2. Thank them for letting you know and wish them a great day"
11. spokenBrief GOOD (restaurant / business inquiry) — ask the thing; if yes thank them for the info and say you'll come later. NEVER write "Goodbye" as a line:
"1. After they say hello: Just checking — do you guys have mutton biryani?
2. If yes: Cool, thanks for the info — I'll come buy some later.
3. If no: Ah okay — thanks anyway."
FORBIDDEN spokenBrief lines: "Goodbye." / "Bye." / "Say goodbye."
12. spokenBrief GOOD (pickup order):
"1. After they say hello: Can I get one plate of idly to go?
2. If they ask name: give the user's name
3. Ask when it'll be ready
4. Cool, thanks — I'll come pick it up."
13. spokenBrief GOOD (friend):
"1. After they greet back: How are you?
2. React, then: What are you up to?
3. Then the actual ask in one short line
4. Chat a beat, then wrap up"
14. NAME + PRONOUN FIDELITY (critical): If the user says "ANNA (my brother)" and uses he/him, the callee is male — use he/him/his forever. NEVER guess gender from the first name. Never respell the name (Anna ≠ Ana). Put this in calleeIdentity and notesForCaller.`;

  const completion = await client.chat.completions.create({
    model: config.openai?.planModel || 'gpt-4.1',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You plan simple phone missions. Prefer saved contacts and explicit numbers. Never substitute unrelated businesses. Never invent gender/pronouns from a name — only from explicit cues (brother/sister, he/him, she/her). spokenBrief must be the actual short lines a person would say on the phone — never "ask if they…", never "I was wondering".',
      },
      { role: 'user', content: prompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  const plan = JSON.parse(raw);

  // Safety net: the location the user typed wins, even if the model dropped it or
  // echoed the profile area instead. Downstream search keys off this.
  plan.requestedArea = requestedArea || String(plan.requestedArea || '').trim();
  if (plan.requestedArea) {
    const areaCity = plan.requestedArea.split(',')[0].trim();
    plan.targets = (plan.targets || []).map((t) => {
      if (!t || t.phone || !t.name) return t;
      const query = String(t.searchQuery || t.name);
      return new RegExp(`\\b${areaCity}\\b`, 'i').test(query)
        ? t
        : { ...t, searchQuery: `${query} near ${plan.requestedArea}` };
    });
  }

  // Hard override priority: explicit phones > matched contacts > model plan
  if (explicitPhones.length) {
    plan.category = 'direct_call';
    plan.compareOffers = false;
    plan.maxTargets = Math.min(explicitPhones.length, 3);
    plan.targets = explicitPhones.slice(0, 3).map((phone, idx) => {
      const contactHit = matchedContacts.find((c) => toE164US(c.phone) === phone);
      return {
        name: contactHit?.name || plan.targets?.[idx]?.name || 'Requested number',
        phone,
        searchQuery: '',
        reason: contactHit ? 'Saved contact + number in request' : 'Phone number provided by user',
      };
    });
  } else if (matchedContacts.length) {
    plan.category = 'direct_call';
    plan.compareOffers = false;
    plan.maxTargets = matchedContacts.length;
    plan.targets = matchedContacts.map((c) => ({
      name: c.name,
      phone: toE164US(c.phone),
      searchQuery: '',
      reason: 'Saved contact matched by name',
    }));
  } else {
    plan.maxTargets = Math.min(Math.max(Number(plan.maxTargets) || plan.targets?.length || 1, 1), 3);
    plan.targets = Array.isArray(plan.targets) ? plan.targets.slice(0, plan.maxTargets) : [];

    // Placeholder names can never be looked up — fall back to category discovery.
    const generic = plan.targets.filter((t) => isGenericTargetName(t?.name));
    if (generic.length) {
      plan.discoveryQuery =
        plan.discoveryQuery || generic[0].searchQuery || generic[0].name || request;
      plan.targets = plan.targets.filter((t) => !isGenericTargetName(t?.name));
    }
    if (!plan.targets.length && !plan.discoveryQuery) {
      plan.discoveryQuery = request;
    }
  }

  applyCalleeIdentity(plan, corpus);

  if (plan.category === 'direct_call') {
    if (!plan.spokenBrief) plan.spokenBrief = request;
    plan.spokenBrief = ensureTurnByTurnBrief(plan.spokenBrief);
    if (!plan.callObjective) {
      plan.callObjective =
        "Have a natural turn-by-turn conversation: one question or statement at a time, wait for replies; if they decline without a reason ask why once, react briefly, then wrap up.";
    }
    if (!plan.notesForCaller) {
      plan.notesForCaller =
        'Talk like a friend: one short line, wait, react. No hedging. Do not instantly goodbye on a bare no/not joining.';
    }
    plan.firstMessageTemplate = 'Hi.';
    if (!plan.title) plan.title = 'Direct call';
    if (!plan.goal) plan.goal = 'Call the person and deliver the message';
  }

  if (plan.spokenBrief) {
    plan.spokenBrief = ensureTurnByTurnBrief(plan.spokenBrief);
    if (plan.category !== 'direct_call' && plan.category !== 'pickup_order') {
      plan.spokenBrief = ensureInquiryFollowThrough(plan.spokenBrief);
    }
  }

  if (plan.category !== 'direct_call') {
    const talkStraight =
      'Talk like a customer checking the menu: "Just checking — do you guys have mutton biryani?" Never "I was wondering" and never say the restaurant name to the restaurant. If yes: "Cool, thanks for the info — I\'ll come buy some later." NEVER just say Goodbye. If no: "Ah okay — thanks anyway." Pickup: "Cool, thanks — I\'ll come pick it up."';
    plan.notesForCaller = plan.notesForCaller
      ? `${talkStraight} ${plan.notesForCaller}`
      : talkStraight;
  }

  // Re-apply after brief normalization so identity rules stay on top
  applyCalleeIdentity(plan, corpus);

  return plan;
}

const MALE_RELATIONS = new Set([
  'brother',
  'dad',
  'father',
  'husband',
  'uncle',
  'son',
  'boyfriend',
  'papa',
  'grandpa',
  'grandfather',
]);
const FEMALE_RELATIONS = new Set([
  'sister',
  'mom',
  'mother',
  'wife',
  'aunt',
  'daughter',
  'girlfriend',
  'mama',
  'grandma',
  'grandmother',
]);

/**
 * Infer exact name spelling + pronouns from the user request.
 * Never guess gender from the first name alone.
 */
function extractCalleeIdentity(request = '', fallbackName = '') {
  const text = String(request || '');
  const lower = text.toLowerCase();

  const paren = text.match(
    /\b([A-Za-z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,20})?)\s*\(\s*(?:my\s+)?(brother|sister|mom|mother|dad|father|wife|husband|friend|cousin|uncle|aunt|son|daughter|boyfriend|girlfriend|papa|mama|grandpa|grandma)\s*\)/i
  );
  const callTo = text.match(
    /\b(?:call(?:\s+to)?|phone|dial)\s+([A-Za-z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,20})?)(?=\s*[\(+]|\s+\+|\s+at\b|\s+and\b|,|$)/i
  );

  let nameAsGiven = String(paren?.[1] || callTo?.[1] || fallbackName || '').trim().replace(/\s+/g, ' ');
  nameAsGiven = nameAsGiven.replace(/^(?:call|to|phone|dial)\s+/i, '').trim();
  if (/^(?:call|to|phone|dial)$/i.test(nameAsGiven)) nameAsGiven = '';
  if (nameAsGiven && nameAsGiven === nameAsGiven.toUpperCase() && nameAsGiven.length > 1) {
    nameAsGiven = nameAsGiven.charAt(0) + nameAsGiven.slice(1).toLowerCase();
  }

  let relation = String(paren?.[2] || '').toLowerCase();
  if (!relation) {
    for (const r of [...MALE_RELATIONS, ...FEMALE_RELATIONS, 'friend', 'cousin']) {
      if (new RegExp(`\\b(?:my\\s+)?${r}\\b`).test(lower)) {
        relation = r;
        break;
      }
    }
  }

  const heHits = (lower.match(/\b(he|him|his)\b/g) || []).length;
  const sheHits = (lower.match(/\b(she|her|hers)\b/g) || []).length;

  const forceMale = MALE_RELATIONS.has(relation) || (heHits > 0 && sheHits === 0);
  const forceFemale = FEMALE_RELATIONS.has(relation) || (sheHits > 0 && heHits === 0);

  let pronouns = 'they/them';
  let subject = 'they';
  let object = 'them';
  let possessive = 'their';
  if (forceMale && !forceFemale) {
    pronouns = 'he/him';
    subject = 'he';
    object = 'him';
    possessive = 'his';
  } else if (forceFemale && !forceMale) {
    pronouns = 'she/her';
    subject = 'she';
    object = 'her';
    possessive = 'her';
  }

  const locked = forceMale || forceFemale;
  const namePart = nameAsGiven ? `"${nameAsGiven}"` : 'the callee';
  const rule = locked
    ? `NAME/PRONOUN LOCK: Call ${namePart}${relation ? ` (${relation})` : ''}. ALWAYS use ${pronouns} (${subject}/${object}/${possessive}). NEVER use the opposite gender pronouns. NEVER guess gender from the first name. Spell the name exactly ${namePart} — do not shorten or respell (Anna ≠ Ana). If a gatekeeper/voicemail answers, still use these pronouns ("when ${subject}'s available" / "let ${object} know").`
    : `NAME LOCK: Call ${namePart}. Do not invent gender from the name; use they/them unless the callee states otherwise. Spell the name exactly as given.`;

  return {
    nameAsGiven: nameAsGiven || fallbackName || '',
    relation: relation || null,
    pronouns,
    subject,
    object,
    possessive,
    locked,
    rule,
  };
}

function applyCalleeIdentity(plan, request) {
  if (!plan) return plan;
  const fallbackName = plan.targets?.[0]?.name || '';
  const identity = extractCalleeIdentity(request, fallbackName);
  // Only lock people-calls — not restaurant / business missions
  if (plan.category !== 'direct_call' && !identity.relation) return plan;
  const modelIdentity = plan.calleeIdentity && typeof plan.calleeIdentity === 'object' ? plan.calleeIdentity : {};

  plan.calleeIdentity = {
    ...modelIdentity,
    ...identity,
    nameAsGiven: identity.nameAsGiven || modelIdentity.nameAsGiven || fallbackName,
    pronouns: identity.locked ? identity.pronouns : modelIdentity.pronouns || identity.pronouns,
    relation: identity.relation || modelIdentity.relation || null,
    rule: identity.rule,
  };

  if (plan.calleeIdentity.nameAsGiven && Array.isArray(plan.targets)) {
    for (const t of plan.targets) {
      if (!t) continue;
      // Prefer user's spelling over model/contact generic "Requested number"
      if (!t.name || t.name === 'Requested number' || /requested number/i.test(t.name)) {
        t.name = plan.calleeIdentity.nameAsGiven;
      } else if (identity.nameAsGiven && t.name.toLowerCase() !== identity.nameAsGiven.toLowerCase()) {
        // If model shortened Ana vs Anna, restore user spelling when close
        const a = t.name.toLowerCase().replace(/[^a-z]/g, '');
        const b = identity.nameAsGiven.toLowerCase().replace(/[^a-z]/g, '');
        if (a.startsWith(b.slice(0, 3)) || b.startsWith(a.slice(0, 3))) {
          t.name = identity.nameAsGiven;
        }
      } else if (identity.nameAsGiven) {
        t.name = identity.nameAsGiven;
      }
    }
  }

  const lockLine = plan.calleeIdentity.rule;
  if (lockLine) {
    const notes = String(plan.notesForCaller || '');
    if (!notes.includes('PRONOUN LOCK') && !notes.includes('NAME LOCK')) {
      plan.notesForCaller = notes ? `${lockLine}\n${notes}` : lockLine;
    }
    if (!String(plan.spokenBrief || '').includes('PRONOUN LOCK') && !String(plan.spokenBrief || '').includes('NAME LOCK')) {
      plan.spokenBrief = `${lockLine}\n${plan.spokenBrief || ''}`.trim();
    }
    const reqs = Array.isArray(plan.requirements) ? plan.requirements : [];
    if (!reqs.some((r) => /pronoun|brother|sister|he\/him|she\/her/i.test(String(r)))) {
      plan.requirements = [
        `Use name ${plan.calleeIdentity.nameAsGiven || 'as given'} and pronouns ${plan.calleeIdentity.pronouns}`,
        ...reqs,
      ];
    }
  }

  return plan;
}

/**
 * If the model returned a monologue of stacked questions, rewrite as a turn-by-turn guide.
 */
/**
 * Inquiry calls: a yes is not the end — say you'll come / have it. The planner
 * otherwise writes "Great, thanks!" and the agent hangs up like a survey bot.
 */
function ensureInquiryFollowThrough(brief) {
  const text = String(brief || '')
    .split('\n')
    .filter((line) => !/^\s*(\d+[.)]\s*)?(goodbye|bye)\.?\s*$/i.test(line.trim()))
    .join('\n');
  if (!/if yes/i.test(text)) return text;
  // Already has buy/pick-up/check intent — leave it.
  if (/\b(buy|purchase|pick(?:\s*it)?\s*up|check\s+it\s+out|have some|get\s+(it|some|one)|later|after)\b/i.test(text)) {
    return text;
  }
  // "I'll come by" alone is too vague — rewrite the yes line.
  return text.replace(
    /(if yes[:\s]+)([^\n]+)/i,
    '$1Cool, thanks for the info — I\'ll come buy some later.'
  );
}

function ensureTurnByTurnBrief(brief) {
  const text = String(brief || '').trim();
  if (!text) return text;

  const looksNumbered = /(?:^|\n)\s*\d+[.)]/m.test(text) || /(?:^|\n)\s*[-•]/m.test(text);
  const questionMarks = (text.match(/\?/g) || []).length;
  const stackedInOneLine =
    !text.includes('\n') && (questionMarks >= 2 || /how are you[^.?!]*what/i.test(text));

  const withoutOpeningHi = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\s*(\d+[.)]\s*)?hi\.?\s*$/i.test(line));

  const renumbered = withoutOpeningHi.map((line, i) => {
    const body = line.replace(/^\s*\d+[.)]\s*/, '').replace(/^\s*[-•]\s*/, '').trim();
    return `${i + 1}. ${body}`;
  });

  if (looksNumbered && !stackedInOneLine) {
    return renumbered.length ? renumbered.join('\n') : text;
  }
  if (!stackedInOneLine && questionMarks < 2) return text;

  // Split on sentence boundaries / question marks into beats
  const parts = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^hi\.?$/i.test(p));

  if (parts.length <= 1) {
    return `Turn-by-turn (one thing per reply):\n1. After they greet back: cover this naturally — ${text}\n2. Chat briefly based on their answers, then wrap up warmly.`;
  }

  const lines = parts.map((p, i) => `${i + 1}. ${p.replace(/^Hi\.\s*/i, '')}`);
  return `Turn-by-turn (say one line, wait for their reply, then continue):\n${lines.join('\n')}`;
}

/**
 * Find a business phone/address via OpenAI web search.
 * Location bias is mandatory when the user has an area / coordinates.
 */
async function findBusinessWithOpenAI({ name, searchQuery, location, locationHint, strictNearbyOnly = false }) {
  const { buildLocationContext } = require('./location');
  const loc =
    location && typeof location === 'object' && 'searchRules' in location
      ? location
      : buildLocationContext({ area: locationHint || location?.area || '', latitude: location?.latitude, longitude: location?.longitude });

  const near = loc.nearPhrase || (loc.area ? `near ${loc.area}` : '');
  const query = strictNearbyOnly
    ? `Find the CLOSEST "${name}" location to the user ${near}. Reject any branch that is hours away.`
    : `Find the official customer-facing phone number and address for "${name}" ${near}.
Search context: ${searchQuery || name} ${near}.
Prefer a sales/quoting/ordering line that a real person can call.`;

  try {
    const response = await client.responses.create({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: `${query}

${loc.searchRules}

Return ONLY JSON with:
- name
- phone (E.164 if possible, else as listed)
- address (full street + city + state — required)
- website
- confidence ("high"|"medium"|"low")
- notes (mention approx distance from user if known)
- approxMilesFromUser (number or null)`,
    });

    const text = response.output_text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (err) {
    console.warn('[openai] business lookup failed:', err.message);
    return null;
  }
}

/** @deprecated alias */
async function findRestaurantWithOpenAI({ restaurantName, locationHint, latitude, longitude }) {
  return findBusinessWithOpenAI({
    name: restaurantName,
    searchQuery: restaurantName,
    locationHint,
    location: { area: locationHint, latitude, longitude },
  });
}

async function parseOrderRequest({ restaurantName, orderDetails, userName, userPhone, locationHint }) {
  const plan = await planMission({
    request: `Place a pickup order at ${restaurantName}. ${orderDetails}`,
    profile: { name: userName, phone: userPhone, area: locationHint },
  });
  return {
    restaurantName: plan.targets?.[0]?.name || restaurantName,
    locationHint: locationHint || '',
    items: [],
    specialRequests: (plan.requirements || []).join('; '),
    pickupName: userName,
    pickupPhone: userPhone,
    spokenOrderSummary: plan.spokenBrief,
  };
}

/**
 * After calls finish, compare transcripts and recommend the best outcome.
 */
async function summarizeMissionResults({ plan, profile, targets }) {
  const payload = targets.map((t) => ({
    name: t.name,
    phone: t.phone,
    address: t.address,
    status: t.status,
    transcript: t.transcript || '',
    endedReason: t.endedReason || '',
    error: t.error || null,
  }));

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You summarize phone call outcomes for a user. Be honest about missing info. Prefer concrete offers, prices, times, and next steps. If the call did not connect or the person did not answer, say so clearly (e.g. did not pick up, unavailable, went to voicemail). Never say a call is still dialing if status is ended with no transcript.',
      },
      {
        role: 'user',
        content: `Mission: ${plan.title}
Goal: ${plan.goal}
Category: ${plan.category}
Requirements: ${(plan.requirements || []).join('; ')}
Compare offers: ${Boolean(plan.compareOffers)}
User: ${profile.name} (${profile.phone}) in ${profile.area || 'unknown area'}

Call results JSON:
${JSON.stringify(payload, null, 2)}

Return ONLY JSON:
{
  "summary": "short overall summary",
  "bestOffer": {
    "targetName": "winner or empty if none",
    "headline": "best offer in one line",
    "details": "why this wins / what was offered",
    "nextStep": "what the user should do next"
  },
  "alternatives": [{"targetName":"", "headline":"", "details":""}],
  "unresolved": ["anything still unknown"]
}`,
      },
    ],
  });

  return JSON.parse(completion.choices[0]?.message?.content || '{}');
}

module.exports = {
  planMission,
  clarifyRequest,
  canPlaceDirectCall,
  needsOrderItemsBeforeCall,
  isOrderPlacementRequest,
  isMenuAvailabilityInquiry,
  discoverBusinesses,
  isGenericTargetName,
  findBusinessWithOpenAI,
  findRestaurantWithOpenAI,
  parseOrderRequest,
  summarizeMissionResults,
  extractCalleeIdentity,
  applyCalleeIdentity,
};