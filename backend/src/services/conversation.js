/**
 * Home chat is the source of truth for a later "make a call".
 * A thin trigger like "make a call" / "call them" must inherit who, where, and
 * what to say from the thread — not start a blank mission.
 */

function parseChatHistory(raw) {
  if (!raw) return [];
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: String(m.content).trim() }));
}

function formatChatHistory(history = []) {
  return parseChatHistory(history)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
}

/**
 * Latest message is only "go do the call we just talked about" — no new who/what.
 */
function isThinCallTrigger(text = '') {
  const t = String(text || '')
    .trim()
    .replace(/[.!?]+$/g, '')
    .trim();
  if (!t || t.length > 80) return false;
  return /^(ok(ay)?[,.]?\s*)?(yeah[,.]?\s*)?(please\s+)?(just\s+)?(go\s+ahead\s+(and\s+)?)?(make(\s+the)?\s+(a\s+)?calls?|place\s+the\s+call|do\s+the\s+call|call(\s+(them|him|her|it|that|now|please|the\s+(place|restaurant|number|shop)|that\s+(place|restaurant|one)))?|dial(\s+(them|him|her|it|now))?|do\s+it)(\s+please)?$/i.test(
    t
  );
}

/** All user + assistant text plus the latest line — for location / items / contacts. */
function conversationCorpus(request = '', history = []) {
  const prior = parseChatHistory(history)
    .map((m) => m.content)
    .join('\n');
  const latest = String(request || '').trim();
  return [prior, latest].filter(Boolean).join('\n');
}

function conversationBlock(request = '', history = []) {
  const thread = formatChatHistory(history);
  const latest = String(request || '').trim();
  if (!thread) return latest;
  if (isThinCallTrigger(latest)) {
    return `Conversation so far:\n${thread}\n\nLatest: "${latest}"\nThe user now wants you to PLACE THE CALL discussed above. Use the whole thread for who to call, where, and what to say. Do not invent a different errand.`;
  }
  return `Conversation so far:\n${thread}\n\nLatest request:\n${latest}`;
}

function whoToCallQuestions() {
  return [
    {
      id: 'who_to_call',
      question: 'Who should I call?',
      why: 'You asked to make a call — I need the person or place (and what to say) if it is not already in this chat.',
      suggestions: [],
    },
  ];
}

module.exports = {
  parseChatHistory,
  formatChatHistory,
  isThinCallTrigger,
  conversationCorpus,
  conversationBlock,
  whoToCallQuestions,
};
