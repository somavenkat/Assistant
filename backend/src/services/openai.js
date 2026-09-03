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
  return /\b(pickup|pick[\s-]*up|takeout|take[\s-]*out|to[\s-]*go|delivery)\b/i.test(text)
    || /\b(place|make|put)\s+(an?\s+)?(order|pickup)\b/i.test(text)
    || /\border\s+(from|at|food)\b/i.test(text)
    || /\b(food|restaurant|eatery)\b.*\border\b/i.test(text)
    || /\border\b.*\b(food|restaurant|eatery|pickup)\b/i.test(text);
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
async function clarifyRequest({ request, profile, contacts = [], attachments = [], answers = [] }) {
  const { formatAttachmentsForPrompt } = require('./attachments');
  const attachmentBlock = formatAttachmentsForPrompt(attachments);

  if (canPlaceDirectCall({ request, contacts })) {
    const matched = matchContactsInRequest(request, contacts);
    const who = matched.map((c) => c.name).join(', ') || 'the number in the request';
    return {
      ready: true,
      questions: [],
      finalBrief: buildFallbackBrief(request, answers),
      summaryBullets: [`Call ${who} and handle this on the phone.`],
    };
  }

  // Hard rule: never dial a pickup/order without knowing the items.
  if (needsOrderItemsBeforeCall(request, answers)) {
    return {
      ready: false,
      questions: orderItemsQuestions(),
      finalBrief: '',
      summaryBullets: [],
    };
  }

  // One round of answers is enough — don't keep the user in a form loop.
  const filledAnswers = (answers || []).filter((a) => String(a.answer || '').trim());
  if (filledAnswers.length > 0) {
    return {
      ready: true,
      questions: [],
      finalBrief: buildFallbackBrief(request, filledAnswers),
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
          'You decide if a personal concierge can PLACE a phone call now. Ask the user only for details we must know BEFORE dialing. Never ask the user for facts the other person on the call is supposed to provide. For restaurant pickup/orders, NEVER set ready:true unless specific food items (and quantities) are already known.',
      },
      {
        role: 'user',
        content: `User profile: ${profile.name}, ${profile.phone}, area: ${profile.area || 'unknown'}
Saved contacts:
${contactsBlock}

Original request:
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
  if (ready && needsOrderItemsBeforeCall(request, answers)) {
    ready = false;
    questions = orderItemsQuestions();
  }

  return {
    ready,
    questions: ready ? [] : questions,
    finalBrief: ready ? parsed.finalBrief || buildFallbackBrief(request, answers) : '',
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
async function planMission({ request, profile, attachments = [], contacts = [] }) {
  const { formatAttachmentsForPrompt } = require('./attachments');
  const { toE164US } = require('./places');
  const attachmentBlock = formatAttachmentsForPrompt(attachments);
  const explicitPhones = extractExplicitPhones(
    `${request}\n${attachmentBlock}\n${(attachments || []).map((a) => a.extractedText || '').join('\n')}`
  );
  const matchedContacts = matchContactsInRequest(request, contacts);

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

IMPORTANT: Any business/restaurant you plan to call MUST be near this user location. Put the area into each target's searchQuery (e.g. "Chowrastha near Liberty Hill, Texas"). Never plan a call to a distant city branch when a local one exists.
Saved contacts (use these when the user names a person):
${contactsBlock}

Contacts matched in this request:
${
  matchedContacts.length
    ? matchedContacts.map((c) => `- ${c.name} → ${c.phone}`).join('\n')
    : '(none)'
}

User request:
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
  "callObjective": "what success looks like",
  "spokenBrief": "exactly what to say / convey on the call, based on the user request",
  "firstMessageTemplate": "MUST be only Hi. Never put the order or message here.",
  "notesForCaller": "keep short"
}

CRITICAL RULES:
1. If the user named a saved contact (e.g. "call Mom and say..."), category MUST be "direct_call" and target.phone MUST be that contact's number. Deliver their message.
2. If the user provided phone number(s), dial those numbers only. Do NOT invent businesses.
3. If they said what to say, put that in spokenBrief only. firstMessageTemplate must stay "Hi." — do not dump the message as the opening line.
4. Only search for businesses when NO phone and NO matching contact was given.
5. Never invent phone numbers.
6. Target names must be REAL, specific businesses (e.g. "Covert Honda Austin"), never placeholders like "Local Car Dealership" or "Nearby Insurance Agency". If you cannot name real businesses confidently, leave "targets" as [] and set "discoveryQuery" instead.
7. Keep maxTargets <= 3.
8. For invites/plans/questions to people (pickleball, dinner, hangout, etc.), callObjective and notesForCaller must say: if they decline without a reason, ask why once, react, then wrap up — do not instantly goodbye.`;

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You plan simple phone missions. Prefer saved contacts and explicit numbers. Never substitute unrelated businesses.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  const plan = JSON.parse(raw);

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

  if (plan.category === 'direct_call') {
    if (!plan.spokenBrief) plan.spokenBrief = request;
    if (!plan.callObjective) {
      plan.callObjective =
        "Have a natural conversation: deliver the ask, and if they decline without a reason ask why once, react briefly, then wrap up.";
    }
    if (!plan.notesForCaller) {
      plan.notesForCaller =
        'Do not instantly goodbye on a bare no/not joining — ask how come, then end warmly.';
    }
    plan.firstMessageTemplate = 'Hi.';
    if (!plan.title) plan.title = 'Direct call';
    if (!plan.goal) plan.goal = 'Call the person and deliver the message';
  }

  return plan;
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
  discoverBusinesses,
  isGenericTargetName,
  findBusinessWithOpenAI,
  findRestaurantWithOpenAI,
  parseOrderRequest,
  summarizeMissionResults,
};