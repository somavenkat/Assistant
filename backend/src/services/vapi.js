const axios = require('axios');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const VAPI_BASE = 'https://api.vapi.ai';

function headers() {
  if (!config.vapi.apiKey) {
    throw new Error('VAPI_API_KEY is missing. Add your Vapi private API key to .env');
  }
  return {
    Authorization: `Bearer ${config.vapi.apiKey}`,
    'Content-Type': 'application/json',
  };
}

const HUMAN_CONVERSATION_RULES = `HOW TO TALK (mandatory — sound like a normal person, not a concierge robot):

PLAIN ENGLISH — NO HEDGING
- Ask the thing. Do not warm it up with "I was wondering…", "I was just calling to see if…", "I wanted to check whether…", "quick question for you…".
- You are talking TO them. Never use their business name in the question.
  BAD: "Hey, I was wondering, does Spot Fusion Kitchen serve tea?"
  GOOD: "Hey — do you guys have tea?"
  GOOD (order): "Can I get one plate of idly to go?"
- Short sentences. Everyday words. Contractions. "Do you have…", "Can I get…", "What time are you open till?"
- One thought per turn. Then shut up and listen.

GREETING
1. Opening is already "Hi". Do not add your name, intro, or the reason on top of it.
2. "Can you hear me?" is ONLY if they stay silent right after pickup. Once anyone has spoken — including after goodbye — NEVER say it again. If you already wrapped up, stay silent and let the call end.
3. The INSTANT they speak (hello, yes, who is this): reply right away with the first real ask. No dead air.
4. Do NOT volunteer your name / "I'm X's assistant" unless they ask, or the brief explicitly says to introduce — and then as its own short turn.
5. After they greet back, go straight to why you called. Skip fake small talk with a restaurant ("how are you today?") unless they start it.

ONE BEAT AT A TIME
6. Say ONE short thing, wait, react, then the next. Never stack questions.
7. BAD: "How are you? What are you doing? I'm Venkat's assistant. What's your plan?"
8. Friend/family GOOD: "How are you?" → … → "What are you up to?" → … → the actual ask.
9. Business/restaurant GOOD: they say hello → "Do you have tea?" / "Can I put in a to-go order?" — not a speech.

WRAP-UP LIKE A PERSON — NEVER BARE "GOODBYE"
10. After they answer your question, you MUST thank them and say what you'll do next. Then stop talking. Do NOT say only "Goodbye" / "Bye" / "Alright, goodbye."
    Real bug (FORBIDDEN):
      Them: "Yeah. We have it."
      You: "Goodbye."
    Required instead:
      Them: "Yeah. We have it."
      You: "Cool, thanks for the info — I'll come buy some later."
    Or: "Thanks for letting me know — I'll swing by after a bit."
11. If they don't have it: "Ah okay — thanks anyway." Then stop. Still never bare "Goodbye."
12. One short closer only. No stacked thank-you + have-a-great-day + goodbye.
13. After that closer: stay silent. Never "Can you hear me?" again.

WHEN TO ASK ONE MORE THING (friends / invites — not simple yes/no facts)
14. Bare decline with no reason ("not joining", "can't"): ask why once — "Oh, how come?" — then react and wrap up.
15. A clear yes on a dish/item: "Cool, thanks for the info — I'll come buy some later." Then stop. A clear no: "Ah okay — thanks anyway."
16. Never invent facts. Never mention Vapi, Twilio, OpenAI, scripts, or automation.`;

function buildMissionCallPrompt({ profile, plan, target, attachments = [] }) {
  const { formatAttachmentsForPrompt } = require('./attachments');
  const attachmentBlock = formatAttachmentsForPrompt(attachments);
  const isDirect = plan.category === 'direct_call' || target.source === 'user_provided';
  const identity = plan.calleeIdentity || {};
  const calleeName = identity.nameAsGiven || target.name || 'them';
  const pronouns = identity.pronouns || 'they/them';
  const subject = identity.subject || 'they';
  const object = identity.object || 'them';
  const possessive = identity.possessive || 'their';
  const relation = identity.relation ? ` (${identity.relation})` : '';
  const identityBlock = `CALLEE IDENTITY (absolute — do not invent otherwise):
- Name: ${calleeName}${relation}
- Pronouns: ${pronouns} → use ${subject} / ${object} / ${possessive} in every sentence about them
- ${identity.rule || 'Do not guess gender from the name. Prefer they/them if unsure.'}
- BAD (real bug): User said "Anna (my brother)" + he/him → saying "Ana" or "when she's available"
- GOOD: "I'm calling for Anna" / "is he available?" / "ask him how he's doing"
- If a gatekeeper, IVR, or assistant answers: still use ${calleeName} + ${pronouns}. Never switch to she/her because the name sounds feminine.`;

  if (isDirect) {
    return `You are a real person named ${profile.name} on a phone call.
You are NOT an AI, bot, or automated system. Never say you are artificial intelligence.
Talk the way you would to a friend on the phone: short, direct, a little casual. No corporate politeness.

${HUMAN_CONVERSATION_RULES}

${identityBlock}

Your job on this call (after they have responded):
${plan.callObjective || plan.goal}

Conversation guide (topics to cover turn-by-turn — NOT a script to read aloud in one breath):
${plan.spokenBrief}

Requirements:
${(plan.requirements || []).map((r) => `- ${r}`).join('\n') || '- Deliver the message naturally'}

Identity (you): default is do not offer your name unprompted. If requirements/spoken brief say to introduce (e.g. "Venkat's assistant"), do that in its own short turn after greeting — never as part of a question pile. If they ask who you are: you are ${profile.name}${profile.phone ? `, callback ${profile.phone}` : ''}.

REAL CONVERSATION:
- One question or statement per turn. Wait for them. React. Then next topic.
- Always refer to ${calleeName} with ${pronouns} — never the opposite.
- If they say yes to an invite → get missing detail (time, place) if needed, confirm, then wrap up.
- If they say no / not joining / can't → ask why once (unless they already said why), react briefly, THEN wrap up.
- BAD (robot dump): "How are you? What are you doing? I'm Venkat's assistant. What's your plan? How's everything going?"
- GOOD (human): "How are you?" → … → "What are you up to?" → … → intro if requested → … → "What's the plan?" → chat → goodbye.
- BAD (instant exit): Them: "I'm not joining today." You: "All right, no problem. Talk to you later."
- GOOD: Them: "I'm not joining today." You: "Oh, how come?" → … → "Got it, maybe next time."

If you don't understand them (noise, accent, unclear reply): ask them to repeat or clarify — NEVER hang up mid-conversation just because you were confused.
Never invent a different purpose for the call.`;
  }

  return `You are a real person named ${profile.name} calling a business as a regular customer.
You are NOT an AI, assistant, bot, or automated system. Never say you are artificial intelligence.
Talk like someone who just picked up the phone and asked a normal question — not a call-center script.

${HUMAN_CONVERSATION_RULES}

Mission: ${plan.title}
Category: ${plan.category}
Goal: ${plan.goal}
Your requirements:
${(plan.requirements || []).map((r) => `- ${r}`).join('\n') || '- (see spoken brief)'}

You are calling: ${target.name}
Their address (if known): ${target.address || 'unknown'}

If they ask who you are (do not volunteer this unless the brief says to introduce):
- Name: ${profile.name}
- Callback phone: ${profile.phone}
- Area: ${profile.area || 'nearby'}

What you need on this call:
${plan.callObjective}

Conversation guide (cover turn-by-turn — never read as one monologue):
${plan.spokenBrief}

${
  attachmentBlock
    ? `Supporting details from files the user provided (cite naturally only when useful; do not read documents verbatim):\n${attachmentBlock}\n`
    : ''
}
Extra coaching:
${plan.notesForCaller || 'Ask like a customer. Confirm numbers/times/prices back only when they matter.'}

Talking TO this business (critical):
- Do not say "${target.name}" in your questions. They already know who they are.
- BAD: "I was wondering, does ${target.name} serve tea?"
- GOOD: "Just checking — do you guys have mutton biryani?"
- When they say yes they have it:
  FORBIDDEN: "Goodbye." / "Bye." / "Alright, goodbye."
  REQUIRED: "Cool, thanks for the info — I'll come buy some later." (or "...I'll swing by after a bit.")
- When they say no: "Ah okay — thanks anyway." — still never bare goodbye.

CRITICAL — stay on the line, then shut up when done:
- If you don't understand them, ask them to repeat. Stay on the line.
- Never hang up because of confusion or a short silence.
- Business "we don't have that" → one alternative if it still matters, then wrap up.
- After your thank-you closer: stay silent. The call ends. Never "Can you hear me?" after that.
- Ending the call is fine AFTER a human closer — never use "Goodbye" as the entire closer.

Call flow:
1. Hi first. Silence at the very start only → "Can you hear me?" once.
2. They speak → one short ask. No dump.
3. They answer → thank them + say you'll come / buy / check later. NEVER just "Goodbye."
4. Stop talking. Let the call end.
5. Never mention Vapi, Twilio, OpenAI, scripts, or automation.`;
}

function buildHumanCallPrompt({ order, restaurant }) {
  return buildMissionCallPrompt({
    profile: {
      name: order.pickupName,
      phone: order.pickupPhone,
      area: '',
    },
    plan: {
      title: 'Pickup order',
      category: 'pickup_order',
      goal: 'Place a pickup order',
      requirements: (order.items || []).map(
        (i) => `${i.quantity || 1}x ${i.name}${i.notes ? ` (${i.notes})` : ''}`
      ),
      callObjective: 'Place the pickup order and get ready time / total if possible.',
      spokenBrief: order.spokenOrderSummary,
      notesForCaller: order.specialRequests || '',
    },
    target: restaurant,
  });
}

async function ensurePhoneNumberId() {
  if (config.vapi.phoneNumberId) {
    return config.vapi.phoneNumberId;
  }

  const { data: numbers } = await axios.get(`${VAPI_BASE}/phone-number`, { headers: headers() });
  const list = Array.isArray(numbers) ? numbers : [];
  const existing = list.find(
    (n) => n.number === config.twilio.phoneNumber || n.twilioPhoneNumber === config.twilio.phoneNumber
  );
  if (existing?.id) {
    config.vapi.phoneNumberId = existing.id;
    return existing.id;
  }

  const { data: created } = await axios.post(
    `${VAPI_BASE}/phone-number`,
    {
      provider: 'twilio',
      number: config.twilio.phoneNumber,
      twilioAccountSid: config.twilio.accountSid,
      twilioAuthToken: config.twilio.authToken,
      name: 'AI Personal Assistant Twilio',
      assistantId: config.vapi.assistantId,
    },
    { headers: headers() }
  );

  if (!created?.id) {
    throw new Error('Failed to import Twilio number into Vapi');
  }

  config.vapi.phoneNumberId = created.id;
  persistPhoneNumberId(created.id);
  return created.id;
}

function persistPhoneNumberId(id) {
  try {
    const envPath = path.resolve(__dirname, '../../../.env');
    let env = fs.readFileSync(envPath, 'utf8');
    if (env.includes('VAPI_PHONE_NUMBER_ID=')) {
      env = env.replace(/VAPI_PHONE_NUMBER_ID=.*/g, `VAPI_PHONE_NUMBER_ID=${id}`);
    } else {
      env += `\nVAPI_PHONE_NUMBER_ID=${id}\n`;
    }
    fs.writeFileSync(envPath, env);
    console.log(`[vapi] Saved VAPI_PHONE_NUMBER_ID=${id} to .env`);
  } catch (err) {
    console.warn('[vapi] Could not persist phone number id:', err.message);
  }
}

function publicAppUrl() {
  if (process.env.PUBLIC_APP_URL) return String(process.env.PUBLIC_APP_URL).replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://assistant-six-omega.vercel.app';
}

let elevenLabsProbe = null;
let cachedElevenLabsCredentialId = config.vapi.elevenLabsCredentialId || null;

/** Kumaran + other library voices need a paid ElevenLabs API plan. */
async function probeElevenLabsVoice(apiKey, voiceId, model) {
  if (!apiKey || !voiceId) return { ok: false, reason: 'missing_api_key' };
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text: 'Hi', model_id: model || 'eleven_turbo_v2_5' },
      {
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: 8000,
        validateStatus: () => true,
        responseType: 'arraybuffer',
      }
    );
    if (res.status === 200) return { ok: true };
    let detail = '';
    try {
      detail = JSON.parse(Buffer.from(res.data).toString('utf8'))?.detail?.message || '';
    } catch {
      detail = String(res.status);
    }
    if (res.status === 402 || /paid_plan_required|payment_required/i.test(detail)) {
      return { ok: false, reason: 'paid_plan_required', detail };
    }
    return { ok: false, reason: 'elevenlabs_error', detail: detail || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: 'network', detail: err.message };
  }
}

async function ensureElevenLabsCredential(apiKey) {
  if (!apiKey) return null;
  if (cachedElevenLabsCredentialId) return cachedElevenLabsCredentialId;

  try {
    const { data: existing } = await axios.get(`${VAPI_BASE}/credential`, { headers: headers() });
    const list = Array.isArray(existing) ? existing : [];
    const hit = list.find((c) => c.provider === '11labs');
    if (hit?.id) {
      await axios.patch(
        `${VAPI_BASE}/credential/${hit.id}`,
        { apiKey, name: 'Assistant ElevenLabs' },
        { headers: headers() }
      );
      cachedElevenLabsCredentialId = hit.id;
      return hit.id;
    }

    const { data: created } = await axios.post(
      `${VAPI_BASE}/credential`,
      { provider: '11labs', apiKey, name: 'Assistant ElevenLabs' },
      { headers: headers() }
    );
    cachedElevenLabsCredentialId = created?.id || null;
    return cachedElevenLabsCredentialId;
  } catch (err) {
    console.warn('[vapi] ElevenLabs credential sync failed:', err.response?.data || err.message);
    return null;
  }
}

function buildVapiVoice(voiceId) {
  return {
    provider: 'vapi',
    voiceId: voiceId || 'Sagar',
    version: 2,
    language: 'auto',
  };
}

/** Deepgram + endpointing tuned for natural phone calls (Indian + US accents). */
function buildCallQualityOverrides() {
  return {
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
      smartFormat: true,
    },
    startSpeakingPlan: {
      waitSeconds: 0.35,
      smartEndpointingEnabled: true,
    },
    stopSpeakingPlan: {
      numWords: 2,
      voiceSeconds: 0.25,
      backoffSeconds: 0.8,
    },
  };
}

async function resolveVoiceOverride() {
  const provider = String(config.vapi.voiceProvider || 'vapi').toLowerCase();
  const voiceId = config.vapi.voiceId || 'Sagar';
  const fallbackId = config.vapi.voiceFallbackId || 'Sagar';

  if (provider === 'vapi') {
    return {
      voice: buildVapiVoice(voiceId || fallbackId),
      credentialIds: [],
      voiceLabel: `vapi:${voiceId || fallbackId}:v2`,
    };
  }

  if (elevenLabsProbe === null) {
    const apiKey = config.vapi.elevenLabsApiKey;
    elevenLabsProbe = await probeElevenLabsVoice(apiKey, voiceId, config.vapi.elevenLabsModel);
    if (!elevenLabsProbe.ok) {
      console.warn('[vapi] ElevenLabs unavailable, falling back to Vapi voice:', elevenLabsProbe);
    }
  }

  if (!elevenLabsProbe.ok) {
    return {
      voice: buildVapiVoice(fallbackId),
      credentialIds: [],
      voiceLabel: `fallback:vapi:${fallbackId}:v2`,
      elevenLabsIssue: elevenLabsProbe,
    };
  }

  const credentialId = await ensureElevenLabsCredential(config.vapi.elevenLabsApiKey);
  const voice = {
    provider: '11labs',
    voiceId,
    model: config.vapi.elevenLabsModel || 'eleven_turbo_v2_5',
    stability: 0.45,
    similarityBoost: 0.78,
  };
  // credentialId on voice is rejected by Vapi — pass via assistantOverrides.credentialIds instead.

  return {
    voice,
    credentialIds: credentialId ? [credentialId] : [],
    voiceLabel: `11labs:${voiceId}`,
  };
}

function buildVoiceOverride() {
  // sync fallback for callers that don't await — prefer resolveVoiceOverride in calls
  const provider = String(config.vapi.voiceProvider || 'vapi').toLowerCase();
  const voiceId = config.vapi.voiceId || 'Sagar';
  if (provider === 'vapi') {
    return buildVapiVoice(voiceId);
  }
  return {
    provider: '11labs',
    voiceId,
    model: config.vapi.elevenLabsModel || 'eleven_turbo_v2_5',
    stability: 0.45,
    similarityBoost: 0.78,
  };
}

/**
 * Vapi rejects customer.name over 40 chars, and resolved business names blow past it
 * ("Chowrastha - Indian Eatery Austin Cedar Park" is 44). Trim on a word boundary so the
 * label stays readable. Only a display label — the prompt still uses the full name.
 */
function toCustomerName(name = '') {
  const clean = String(name).replace(/\s+/g, ' ').trim();
  if (clean.length <= 40) return clean;
  const cut = clean.slice(0, 40);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace >= 20 ? cut.slice(0, lastSpace) : cut;
  return trimmed.replace(/[\s,.\-–—|/]+$/, '');
}

async function placeMissionCall({ profile, plan, target, attachments = [], missionId = null }) {
  const phoneNumberId = await ensurePhoneNumberId();
  const systemPrompt = buildMissionCallPrompt({ profile, plan, target, attachments });
  // Always a short human pickup — never the full order/message (AGENTS.md greeting protocol).
  const firstMessage = 'Hi.';
  const serverUrl = `${publicAppUrl()}/api/vapi/webhook`;
  const voiceConfig = await resolveVoiceOverride();
  const quality = buildCallQualityOverrides();
  if (voiceConfig.elevenLabsIssue?.reason === 'paid_plan_required') {
    console.warn('[vapi] ElevenLabs unavailable — using Vapi Sagar v2 for this call.');
  }

  const payload = {
    assistantId: config.vapi.assistantId,
    phoneNumberId,
    customer: {
      number: target.phone,
      ...(toCustomerName(target.name) ? { name: toCustomerName(target.name) } : {}),
    },
    metadata: {
      missionId: missionId || '',
      targetId: target.id || '',
      voiceUsed: voiceConfig.voiceLabel || '',
    },
    assistantOverrides: {
      firstMessage,
      firstMessageMode: 'assistant-speaks-first',
      serverUrl,
      serverMessages: ['transcript', 'conversation-update', 'status-update', 'end-of-call-report'],
      ...(voiceConfig.credentialIds.length ? { credentialIds: voiceConfig.credentialIds } : {}),
      artifactPlan: {
        transcriptPlan: {
          enabled: true,
          assistantName: 'AI',
          userName: 'User',
        },
      },
      voice: voiceConfig.voice,
      transcriber: quality.transcriber,
      messagePlan: {
        // 5s is Vapi's minimum and fires AFTER wrap-up if they pause. 15s only
        // nudges true dead air at pickup — never a mid-call or post-goodbye beat.
        idleTimeoutSeconds: 15,
        idleMessages: ['Can you hear me?'],
        idleMessageMaxSpokenCount: 1,
      },
      startSpeakingPlan: quality.startSpeakingPlan,
      stopSpeakingPlan: quality.stopSpeakingPlan,
      variableValues: {
        customerName: profile.name,
        customerPhone: profile.phone,
        targetName: target.name,
        missionGoal: plan.goal,
        spokenBrief: plan.spokenBrief,
      },
      model: {
        provider: 'openai',
        model: config.vapi.callModel || 'gpt-4.1',
        temperature: 0.35,
        messages: [{ role: 'system', content: systemPrompt }],
      },
    },
  };

  const { data } = await axios.post(`${VAPI_BASE}/call/phone`, payload, {
    headers: headers(),
    timeout: 30000,
  });

  return data;
}

async function placeOutboundCall({ order, restaurant }) {
  return placeMissionCall({
    profile: {
      name: order.pickupName,
      phone: order.pickupPhone,
      area: '',
    },
    plan: {
      title: 'Pickup order',
      category: 'pickup_order',
      goal: 'Place a pickup order',
      requirements: [],
      callObjective: 'Place the pickup order and confirm ready time.',
      spokenBrief: order.spokenOrderSummary,
      firstMessageTemplate: 'Hi.',
      notesForCaller: '',
    },
    target: restaurant,
  });
}

async function getCall(callId) {
  const { data } = await axios.get(`${VAPI_BASE}/call/${callId}`, { headers: headers() });
  return data;
}

function messageText(m) {
  if (!m) return '';
  if (typeof m === 'string') return m.trim();
  const raw = m.message ?? m.transcript ?? m.text ?? m.content ?? '';
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part;
        return part?.text || part?.content || '';
      })
      .join(' ')
      .trim();
  }
  return '';
}

function isSkippedRole(role) {
  return ['system', 'tool', 'function', 'tool_calls', 'tool_call_result'].includes(role);
}

function isAssistantRole(role) {
  return ['bot', 'assistant', 'ai'].includes(role);
}

/**
 * Build a chat-style transcript from a Vapi call object (works mid-call when messages exist).
 */
function extractTranscriptFromCall(call) {
  if (!call) return '';
  const buckets = [
    call.artifact?.transcript,
    call.transcript,
  ];
  for (const direct of buckets) {
    if (String(direct || '').trim()) return String(direct).trim();
  }

  const messageLists = [
    call.artifact?.messages,
    call.artifact?.messagesOpenAIFormatted,
    call.messages,
    call.artifact?.openAIConversation,
  ].filter((list) => Array.isArray(list) && list.length);

  for (const messages of messageLists) {
    const lines = [];
    for (const m of messages) {
      const role = String(m.role || m.speaker || '').toLowerCase();
      if (isSkippedRole(role)) continue;
      const text = messageText(m);
      if (!text) continue;
      lines.push(`${isAssistantRole(role) ? 'AI' : 'User'}: ${text}`);
    }
    if (lines.length) return lines.join('\n');
  }
  return '';
}

function liveTurnsToTranscript(turns = []) {
  return (turns || [])
    .filter((t) => t && String(t.text || '').trim())
    .map((t) => `${t.speaker === 'AI' || t.speaker === 'assistant' ? 'AI' : 'User'}: ${String(t.text).trim()}`)
    .join('\n');
}

function upsertLiveTurn(target, role, text, isPartial = false) {
  const clean = String(text || '').trim();
  if (!clean || !target) return;
  if (!Array.isArray(target.liveTurns)) target.liveTurns = [];
  const speaker = isAssistantRole(String(role || '').toLowerCase()) ? 'AI' : 'User';
  const last = target.liveTurns[target.liveTurns.length - 1];
  // Only a still-open (partial) turn may be rewritten. A finished turn must never be
  // overwritten by the next utterance from the same speaker, or the call log loses lines.
  if (last && last.speaker === speaker && last.partial) {
    last.text = clean;
    last.partial = Boolean(isPartial);
  } else if (last && last.speaker === speaker && last.text === clean) {
    last.partial = Boolean(isPartial);
  } else {
    target.liveTurns.push({ speaker, text: clean, partial: Boolean(isPartial) });
  }
  target.transcript = liveTurnsToTranscript(target.liveTurns);
}

/**
 * Force-end an active / ringing call.
 * Prefer live controlUrl end-call; fall back to DELETE (cancels attempt).
 */
async function endCall(callId, controlUrlHint = null) {
  if (!callId) throw new Error('callId is required');

  let call = null;
  try {
    call = await getCall(callId);
  } catch {
    /* still try cancel by id */
  }

  const controlUrl =
    controlUrlHint || call?.monitor?.controlUrl || call?.controlUrl || null;

  if (controlUrl) {
    try {
      await axios.post(
        controlUrl,
        { type: 'end-call' },
        { headers: { 'Content-Type': 'application/json' }, timeout: 12000 }
      );
      return { ok: true, method: 'control', call };
    } catch (err) {
      console.warn('[vapi] control end-call failed, trying DELETE', err.response?.data || err.message);
    }
  }

  try {
    const { data } = await axios.delete(`${VAPI_BASE}/call/${callId}`, {
      headers: headers(),
      timeout: 15000,
    });
    return { ok: true, method: 'delete', call: data || call };
  } catch (err) {
    try {
      const { data } = await axios.patch(
        `${VAPI_BASE}/call/${callId}`,
        { status: 'ended' },
        { headers: headers(), timeout: 15000 }
      );
      return { ok: true, method: 'patch', call: data || call };
    } catch (err2) {
      const detail = err2.response?.data || err.response?.data || err.message;
      throw new Error(
        typeof detail === 'string' ? detail : detail?.message || 'Failed to hang up call'
      );
    }
  }
}

module.exports = {
  placeMissionCall,
  placeOutboundCall,
  getCall,
  endCall,
  extractTranscriptFromCall,
  upsertLiveTurn,
  liveTurnsToTranscript,
  ensurePhoneNumberId,
  resolveVoiceOverride,
  buildVoiceOverride,
  buildHumanCallPrompt,
  buildMissionCallPrompt,
  toCustomerName,
};