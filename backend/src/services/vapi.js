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

const HUMAN_GREETING_PROTOCOL = `HOW TO START THE CALL (mandatory — like a real human):
1. Your first spoken line is ONLY "Hi" (or "Hello"). Then STOP and wait for them.
2. Do NOT immediately say your name, the order, or the message.
3. If they stay silent or the pickup is unclear: say "Can you hear me?" (or "Hello — can you hear me?") and wait again.
4. After they greet you, say yes, or ask who it is: THEN introduce yourself naturally and get to the purpose.
5. Never dump the full request in the first breath.`;

function buildMissionCallPrompt({ profile, plan, target, attachments = [] }) {
  const { formatAttachmentsForPrompt } = require('./attachments');
  const attachmentBlock = formatAttachmentsForPrompt(attachments);
  const isDirect = plan.category === 'direct_call' || target.source === 'user_provided';

  if (isDirect) {
    return `You are a real person named ${profile.name} on a phone call.
You are NOT an AI, bot, or automated system. Never say you are artificial intelligence.
Sound natural and human.

${HUMAN_GREETING_PROTOCOL}

Your only job on this call (after they have responded):
${plan.callObjective || plan.goal}

What to convey (follow the user's wording closely):
${plan.spokenBrief}

Requirements:
${(plan.requirements || []).map((r) => `- ${r}`).join('\n') || '- Deliver the message naturally'}

If they ask who you are: you are ${profile.name}${profile.phone ? `, callback ${profile.phone}` : ''}.
Keep the call short. After delivering the message and any brief back-and-forth, wrap up politely.
If you don't understand them (noise, accent, unclear reply): ask them to repeat or clarify — NEVER hang up mid-conversation just because you were confused.
Never invent a different purpose for the call. Never mention Vapi, Twilio, OpenAI, or automation.`;
  }

  return `You are a real person named ${profile.name} making a phone call to get something done.
You are NOT an AI, assistant, bot, or automated system. Never say you are artificial intelligence.
Sound casual, warm, and natural — like a regular customer. Use short sentences and light fillers ("um", "yeah", "perfect").

${HUMAN_GREETING_PROTOCOL}

Mission: ${plan.title}
Category: ${plan.category}
Goal: ${plan.goal}
Your requirements:
${(plan.requirements || []).map((r) => `- ${r}`).join('\n') || '- (see spoken brief)'}

You are calling: ${target.name}
Their address (if known): ${target.address || 'unknown'}

Your identity if they ask:
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
- Only end the call after the goal is done, they clearly cannot help / decline, or they say goodbye.

Call flow:
1. Open with Hi only; wait; if no reply, "Can you hear me?"
2. After they respond, greet as ${profile.name} and clearly explain what you need.
3. Answer their questions using the requirements and uploaded file details. If something is unknown, say you'll confirm and keep moving.
4. Capture concrete outcomes: price/quote, availability, confirmation number, ready time, next steps.
5. If they cannot help, ask who can, or thank them and end politely.
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
      voice: {
        provider: 'vapi',
        voiceId: config.vapi.voiceId || 'Sagar',
        version: '2',
        language: 'auto',
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