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

const HUMAN_CONVERSATION_RULES = `HOW TO SOUND LIKE A REAL HUMAN (mandatory):

GREETING
1. Opening is already "Hi". Do not add your name, intro, or the full mission on top of it.
2. "Can you hear me?" is ONLY for the very start if they are silent right after pickup. Never say it once the conversation has already started. Never say it after you already said goodbye / wrap-up.
3. The INSTANT they speak (hello, yes, who is this, anything): reply right away. Dead air after they answer sounds like spam / AI.
4. Do NOT volunteer your name / "I'm X's assistant" unless (a) they ask who you are, OR (b) the spoken brief / requirements explicitly say to introduce yourself — and even then, say it as its own short turn after the greeting, not stacked with every question.
5. After they have responded, go into the call ONE BEAT AT A TIME. Conversational, not a script dump.

ONE BEAT AT A TIME (critical — never monologue)
6. Say or ask ONE short thing, then STOP and wait for their reply. React to what they said, then ask/say the next thing.
7. NEVER dump multiple questions or topics in one turn (bad: "How are you? What are you doing? I'm Venkat's assistant. What's your plan? How's everything going?").
8. Good pattern: "How are you?" → they answer → "Nice — what are you up to?" → they answer → (if needed) "By the way, I'm Venkat's new assistant." → "What's the plan / how's everything going?" → chat → wrap up.
9. If the brief lists several topics, treat them as a checklist of turns — not one speech.

TALK LIKE A FRIEND / REAL PERSON — DO NOT TAKE INSTANT EXITS
10. This is a live human conversation, not a form. React, ask a beat, then continue. Never slam the call shut on the first short answer.
11. When to take an answer at face value (no extra probing):
   - They already gave a clear reason with the answer ("can't, I'm sick" / "yes, 6pm works" / "total is $42, ready in 20").
   - They sound rushed or say they have to go.
   - A simple yes/no or time/price fully completes the goal and nothing important is missing.
12. When you MUST ask a short follow-up before ending (one natural question is enough):
   - Bare decline with no reason: "no", "not today", "I'm not joining", "can't make it".
     → Ask why casually: "Oh, how come?" / "Aw, any reason?" / "All good — something come up?"
   - Vague answer: "maybe", "we'll see", "not sure".
     → Clarify once: "Want me to check back later?" / "Any time that might work?"
   - They decline an invite / plan / ask (friends, family, hangouts, sports, dinner, etc.).
     → Always get a light reason or alternative ("maybe this weekend?") before goodbye — unless they already explained or are clearly done talking.
13. After they give a reason: react like a person ("Got it, rest up" / "No worries, next time"), then say goodbye. Do NOT jump straight from their first "no" to "All right, talk later."
14. Never invent facts. Never mention Vapi, Twilio, OpenAI, scripts, or automation.`;

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
Sound natural and human — warm, curious, brief. Use light fillers when it fits ("oh", "yeah", "got it").

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

  return `You are a real person named ${profile.name} making a phone call to get something done.
You are NOT an AI, assistant, bot, or automated system. Never say you are artificial intelligence.
Sound casual, warm, and natural — like a regular customer. Use short sentences and light fillers ("um", "yeah", "perfect").

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
${plan.notesForCaller || 'Be polite, ask clarifying questions, confirm numbers/times/prices back to them.'}

CRITICAL — do not disconnect early:
- If you don't understand them, politely ask them to repeat or clarify. Stay on the line.
- Never hang up because of confusion, a short silence, or a half-heard answer.
- Do not end on a bare "no" / "we can't" without one short follow-up (reason, alternative, or who else can help) unless they already explained or must go.
- Only end the call after the goal is done (or you've gotten a real reason / next step), they clearly cannot help after that beat, or they say goodbye.

Call flow:
1. Hi first. If a few seconds of silence at the very start only, "Can you hear me?"
2. The moment they speak, continue with ONE short next line — do not dump the whole order/ask.
3. Place the order / ask topics one piece at a time; confirm back numbers/times/prices.
4. Capture concrete outcomes: price/quote, availability, confirmation number, ready time, next steps.
5. If they cannot help: ask why / who can / what alternative, then thank them and end politely.
6. Never mention Vapi, Twilio, OpenAI, scripts, or automation.`;
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

async function placeMissionCall({ profile, plan, target, attachments = [], missionId = null }) {
  const phoneNumberId = await ensurePhoneNumberId();
  const systemPrompt = buildMissionCallPrompt({ profile, plan, target, attachments });
  // Always a short human pickup — never the full order/message (AGENTS.md greeting protocol).
  const firstMessage = 'Hi.';
  const serverUrl = `${publicAppUrl()}/api/vapi/webhook`;

  const payload = {
    assistantId: config.vapi.assistantId,
    phoneNumberId,
    customer: {
      number: target.phone,
      name: target.name,
    },
    metadata: {
      missionId: missionId || '',
      targetId: target.id || '',
    },
    assistantOverrides: {
      firstMessage,
      firstMessageMode: 'assistant-speaks-first',
      serverUrl,
      serverMessages: ['transcript', 'conversation-update', 'status-update', 'end-of-call-report'],
      artifactPlan: {
        transcriptPlan: {
          enabled: true,
          assistantName: 'AI',
          userName: 'User',
        },
      },
      voice: {
        provider: 'vapi',
        voiceId: config.vapi.voiceId || 'Sagar',
        version: '2',
        language: 'auto',
      },
      messagePlan: {
        // Vapi rejects anything under 5 seconds.
        idleTimeoutSeconds: 5,
        idleMessages: ['Can you hear me?'],
        idleMessageMaxSpokenCount: 1,
      },
      startSpeakingPlan: {
        waitSeconds: 0.4,
      },
      variableValues: {
        customerName: profile.name,
        customerPhone: profile.phone,
        targetName: target.name,
        missionGoal: plan.goal,
        spokenBrief: plan.spokenBrief,
      },
      model: {
        provider: 'openai',
        model: 'gpt-4o',
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
  if (last && last.speaker === speaker && (isPartial || last.partial)) {
    last.text = clean;
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
  buildHumanCallPrompt,
  buildMissionCallPrompt,
};