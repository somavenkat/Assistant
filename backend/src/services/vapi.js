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
1. Opening is already "Hi". Do not add your name or the mission on top of it.
2. "Can you hear me?" is ONLY for the very start if they are silent right after pickup. Never say it once the conversation has already started. Never say it after you already said goodbye / wrap-up.
3. The INSTANT they speak (hello, yes, who is this, anything): reply right away. Dead air after they answer sounds like spam / AI.
4. Do NOT say "this is [your name]" or volunteer your name unless they ASK who you are.
5. After they have responded, go naturally into why you called. Conversational, not a script dump.

TALK LIKE A FRIEND / REAL PERSON — DO NOT TAKE INSTANT EXITS
6. This is a live human conversation, not a checklist. React, ask a beat, then wrap up. Never slam the call shut on the first short answer.
7. When to take an answer at face value (no extra probing):
   - They already gave a clear reason with the answer ("can't, I'm sick" / "yes, 6pm works" / "total is $42, ready in 20").
   - They sound rushed or say they have to go.
   - A simple yes/no or time/price fully completes the goal and nothing important is missing.
8. When you MUST ask a short follow-up before ending (one natural question is enough):
   - Bare decline with no reason: "no", "not today", "I'm not joining", "can't make it".
     → Ask why casually: "Oh, how come?" / "Aw, any reason?" / "All good — something come up?"
   - Vague answer: "maybe", "we'll see", "not sure".
     → Clarify once: "Want me to check back later?" / "Any time that might work?"
   - They decline an invite / plan / ask (friends, family, hangouts, sports, dinner, etc.).
     → Always get a light reason or alternative ("maybe this weekend?") before goodbye — unless they already explained or are clearly done talking.
9. After they give a reason: react like a person ("Got it, rest up" / "No worries, next time"), then say goodbye. Do NOT jump straight from their first "no" to "All right, talk later."
10. Never invent facts. Never mention Vapi, Twilio, OpenAI, scripts, or automation.`;

function buildMissionCallPrompt({ profile, plan, target, attachments = [] }) {
  const { formatAttachmentsForPrompt } = require('./attachments');
  const attachmentBlock = formatAttachmentsForPrompt(attachments);
  const isDirect = plan.category === 'direct_call' || target.source === 'user_provided';

  if (isDirect) {
    return `You are a real person named ${profile.name} on a phone call.
You are NOT an AI, bot, or automated system. Never say you are artificial intelligence.
Sound natural and human — warm, curious, brief. Use light fillers when it fits ("oh", "yeah", "got it").

${HUMAN_CONVERSATION_RULES}

Your job on this call (after they have responded):
${plan.callObjective || plan.goal}

What to convey (follow the user's wording closely):
${plan.spokenBrief}

Requirements:
${(plan.requirements || []).map((r) => `- ${r}`).join('\n') || '- Deliver the message naturally'}

Only if they ask who you are: you are ${profile.name}${profile.phone ? `, callback ${profile.phone}` : ''}. Do not offer your name unprompted.

REAL CONVERSATION — especially for invites / plans / questions to friends:
- Ask the question naturally. Listen.
- If they say yes → get the missing detail (time, place) if needed, confirm, then wrap up.
- If they say no / not joining / can't → ask why once (unless they already said why), react briefly to their reason, THEN wrap up.
- BAD (robot): Them: "I'm not joining today." You: "All right, no problem. Talk to you later." / "Goodbye."
- GOOD (human): Them: "I'm not joining today." You: "Oh, how come?" → they answer → "Got it, no worries — maybe next time. Talk later."

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

If they ask who you are (do not volunteer this):
- Name: ${profile.name}
- Callback phone: ${profile.phone}
- Area: ${profile.area || 'nearby'}

What you need on this call:
${plan.callObjective}

Spoken brief you can adapt naturally:
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
2. The moment they speak, continue immediately with why you called — do not wait, do not say your name unless asked.
3. Answer their questions using the requirements and uploaded file details. If something is unknown, say you'll confirm and keep moving.
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

async function placeMissionCall({ profile, plan, target, attachments = [] }) {
  const phoneNumberId = await ensurePhoneNumberId();
  const systemPrompt = buildMissionCallPrompt({ profile, plan, target, attachments });
  // Always a short human pickup — never the full order/message (AGENTS.md greeting protocol).
  const firstMessage = 'Hi.';

  const payload = {
    assistantId: config.vapi.assistantId,
    phoneNumberId,
    customer: {
      number: target.phone,
      name: target.name,
    },
    assistantOverrides: {
      firstMessage,
      firstMessageMode: 'assistant-speaks-first',
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

module.exports = {
  placeMissionCall,
  placeOutboundCall,
  getCall,
  ensurePhoneNumberId,
  buildHumanCallPrompt,
  buildMissionCallPrompt,
};