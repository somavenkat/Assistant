const OpenAI = require('openai');
const config = require('../config');

const client = new OpenAI({ apiKey: config.openaiApiKey });

const ZONE_ALIASES = [
  { keys: ['hyderabad', 'india', 'ist', 'kolkata', 'mumbai', 'delhi', 'chennai', 'bangalore', 'bengaluru', 'pune'], tz: 'Asia/Kolkata', label: 'India (IST)' },
  { keys: ['austin', 'liberty hill', 'cedar park', 'round rock', 'texas', 'dallas', 'houston', 'chicago', 'cst', 'cdt'], tz: 'America/Chicago', label: 'US Central' },
  { keys: ['new york', 'nyc', 'est', 'edt', 'boston', 'atlanta'], tz: 'America/New_York', label: 'US Eastern' },
  { keys: ['los angeles', 'la', 'pst', 'pdt', 'seattle', 'san francisco', 'california'], tz: 'America/Los_Angeles', label: 'US Pacific' },
  { keys: ['london', 'uk', 'bst', 'gmt'], tz: 'Europe/London', label: 'London' },
  { keys: ['dubai', 'uae', 'gst'], tz: 'Asia/Dubai', label: 'Dubai' },
  { keys: ['utc', 'gmt'], tz: 'UTC', label: 'UTC' },
];

function formatInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
}

function currentClock(profile = {}) {
  const now = new Date();
  return {
    iso: now.toISOString(),
    utc: formatInZone(now, 'UTC'),
    india: formatInZone(now, 'Asia/Kolkata'),
    chicago: formatInZone(now, 'America/Chicago'),
    userArea: profile.area || '',
  };
}

function looksLikeTimeQuestion(text = '') {
  return /\b(what('?s| is)?|current|tell me|give me)?\s*(the\s+)?(time|date|day|timezone)\b/i.test(text)
    || /\bwhat time\b/i.test(text)
    || /\bcurrent time\b/i.test(text);
}

function inferZone(text = '', profile = {}) {
  const hay = `${text} ${profile.area || ''}`.toLowerCase();
  for (const row of ZONE_ALIASES) {
    if (row.keys.some((k) => hay.includes(k))) return row;
  }
  if (/\b(india|hyderabad|mumbai|delhi)\b/i.test(text)) {
    return { tz: 'Asia/Kolkata', label: 'India (IST)' };
  }
  return null;
}

function exactTimeAnswer(message, profile = {}) {
  if (!looksLikeTimeQuestion(message)) return null;
  const now = new Date();
  const zone = inferZone(message, profile) || { tz: 'Asia/Kolkata', label: 'India (IST)' };
  const stamp = formatInZone(now, zone.tz);
  const extra = zone.tz === 'Asia/Kolkata' ? ' (Hyderabad uses India Standard Time, UTC+5:30)' : '';
  return `It's ${stamp} in ${zone.label}${extra}.`;
}

/**
 * True when the user wants us to place / plan a phone call — not a normal question.
 */
function isPhoneMissionRequest(request = '', contacts = []) {
  const text = String(request || '').trim();
  if (!text) return false;

  if (/\b(call|dial|phone|ring)\b/i.test(text)) return true;
  if (/\+?\d[\d\s().-]{8,}\d/.test(text)) return true;
  if (/\b(pickup|pick[\s-]*up|takeout|take[\s-]*out|place\s+(an?\s+)?order)\b/i.test(text)) return true;
  if (/\b(book|reservation|appointment|quote|lease)\b/i.test(text) && /\b(call|restaurant|dealer|clinic|shop|store)\b/i.test(text)) {
    return true;
  }

  // "tell/ask/say <someone>" is a call. "tell me / ask me" is a question.
  if (/\b(tell|ask|say|inform|text)\s+(?!me\b)(?!you\b)/i.test(text)) return true;
  if (/\blet\s+\w+\s+know\b/i.test(text)) return true;

  const names = (contacts || []).map((c) => String(c.name || '').trim()).filter((n) => n.length >= 2);
  if (names.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))) {
    if (/\b(tell|ask|say|call|message|remind)\b/i.test(text)) return true;
  }

  return false;
}

function isInformationalQuery(request = '', contacts = []) {
  if (isPhoneMissionRequest(request, contacts)) return false;
  const text = String(request || '').trim();
  if (text.length < 2) return false;
  return (
    /\?/.test(text)
    || /^(what|who|when|where|why|how|which|is|are|can|do|does|did|will|should|explain|remember|remind me)\b/i.test(text)
    || looksLikeTimeQuestion(text)
    || /\b(weather|news|meaning|capital|define|translate|calculate|convert)\b/i.test(text)
  );
}

async function answerChat({ message, history = [], profile = {} }) {
  const text = String(message || '').trim();
  if (!text) throw new Error('Message is required');

  const clock = currentClock(profile);
  const exact = exactTimeAnswer(text, profile);
  if (exact) {
    return {
      answer: exact,
      mode: 'clock',
      clock,
    };
  }

  const prior = (history || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .slice(-20)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const input = `You are ${profile.name || 'the user'}'s personal assistant in a continuing chat.

AUTHORITATIVE CLOCK — never invent date/time. Use these values if the user asks the time:
- UTC now: ${clock.utc}
- India / Hyderabad (Asia/Kolkata): ${clock.india}
- US Central (America/Chicago): ${clock.chicago}
- ISO: ${clock.iso}
- User home area: ${profile.area || 'unknown'}

Rules:
- Remember facts the user already told you in this conversation. Refer back to them naturally.
- For current facts (news, weather, scores, prices, hours), use web search. If you cannot verify, say you are not sure — do not guess confidently.
- For "what time is it in X", convert from the clock above. Hyderabad, India is IST (Asia/Kolkata, UTC+5:30).
- Keep answers concise and human. Do not offer to place a phone call unless they asked for one.

${prior ? `Conversation so far:\n${prior}\n` : ''}
User: ${text}`;

  const response = await client.responses.create({
    model: 'gpt-4o-mini',
    tools: [{ type: 'web_search_preview' }],
    input,
  });

  const answer = String(response.output_text || '').trim();
  if (!answer) throw new Error('No answer generated');
  return { answer, mode: 'assistant', clock };
}

module.exports = {
  answerChat,
  isPhoneMissionRequest,
  isInformationalQuery,
  currentClock,
  exactTimeAnswer,
};
