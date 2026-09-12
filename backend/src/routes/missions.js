const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const {
  planMission,
  clarifyRequest,
  canPlaceDirectCall,
  discoverBusinesses,
  summarizeMissionResults,
} = require('../services/openai');
const { lookupBusiness, toE164US } = require('../services/places');
const { placeMissionCall, getCall, endCall, extractTranscriptFromCall, upsertLiveTurn } = require('../services/vapi');
const { answerChat, isInformationalQuery } = require('../services/chat');
const { processUploads } = require('../services/attachments');
const { parseChatHistory, conversationCorpus } = require('../services/conversation');
const {
  getMission,
  saveMission,
  listMissions,
  removeMission,
  findMissionByCallId,
  loadChatHistory,
  saveChatHistory,
} = require('../services/store');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
});

function maybeUpload(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    return upload.array('files', 5)(req, res, next);
  }
  return next();
}

const TERMINAL_STATUSES = new Set(['ended', 'completed', 'failed', 'busy', 'no-answer']);

function isTargetPending(target) {
  if (!target.phone || target.status === 'lookup_failed') return false;
  if (!target.callId) return true;
  return !TERMINAL_STATUSES.has(String(target.status));
}

const OPEN_MISSION_STATUSES = new Set(['planning', 'starting', 'calling', 'in_progress']);

/**
 * Every call is over but the mission was never wrapped up. This happens whenever nobody is
 * polling the mission page as the call ends — `isMissionPending` reports false once the
 * targets go terminal, so a plain GET would never refresh it and the card sat on
 * "In progress" forever.
 */
function needsFinalize(mission) {
  if (!OPEN_MISSION_STATUSES.has(String(mission.status))) return false;
  const dialed = (mission.targets || []).filter((t) => t.callId);
  if (!dialed.length) return false;
  return dialed.every((t) => TERMINAL_STATUSES.has(String(t.status)));
}

const STALLED_AFTER_MS = 15 * 60 * 1000;

/**
 * Dialing never got off the ground — the request died between planning and placing the
 * call, so there is no callId to poll and nothing will ever move this forward.
 */
function isStalledBeforeDialing(mission) {
  if (!OPEN_MISSION_STATUSES.has(String(mission.status))) return false;
  if ((mission.targets || []).some((t) => t.callId)) return false;
  const age = Date.now() - Date.parse(mission.updatedAt || mission.createdAt || '');
  return Number.isFinite(age) && age > STALLED_AFTER_MS;
}

/** Bring one stale mission up to date. Returns true when something changed. */
async function reconcileMission(mission) {
  if (isStalledBeforeDialing(mission)) {
    mission.status = 'failed';
    mission.error = mission.error || 'Calls never started. Open the mission and retry.';
    mission.updatedAt = new Date().toISOString();
    await save(mission);
    return true;
  }
  if (isMissionPending(mission)) {
    await refreshMissionCalls(mission);
    return true;
  }
  if (needsFinalize(mission)) {
    await finalizeIfReady(mission);
    await save(mission);
    return true;
  }
  return false;
}

function isMissionPending(mission) {
  const hasLiveOrDialing = (mission.targets || []).some(
    (t) =>
      t.status === 'dialing' ||
      (t.callId && !TERMINAL_STATUSES.has(String(t.status)))
  );
  if (mission.status === 'planning') return true;
  if (mission.status === 'starting' || mission.status === 'calling' || mission.status === 'in_progress') {
    return hasLiveOrDialing;
  }
  if (mission.status === 'completed' || mission.status === 'completed_with_errors') {
    return mission.targets.some(isTargetPending);
  }
  return false;
}

function isUnreachableTarget(target) {
  const reason = String(target.endedReason || '');
  const status = String(target.status || '');
  if (reason.includes('pipeline-error-eleven-labs-voice-failed') || reason.includes('eleven-labs')) return true;
  if (reason.includes('error-get-transport') || reason.includes('twilio-failed')) return true;
  if (status === 'no-answer' || status === 'busy' || status === 'failed') return true;
  if (reason.includes('customer-did-not-answer')) return true;
  if (reason.includes('customer-busy')) return true;
  if (reason.includes('voicemail') || reason.includes('machine')) return true;
  if (reason.includes('silence-timed-out')) return true;
  if (reason.includes('manually-canceled') || reason.includes('user-hangup')) return true;
  if (status === 'ended' && !(target.transcript || '').trim()) return true;
  return false;
}

function describeTargetOutcome(target) {
  const name = target.name || 'Contact';
  const reason = String(target.endedReason || '');
  const status = String(target.status || '');

  const transportTip = explainCallFailure(reason, target.phone);
  if (transportTip && reason.includes('error-get-transport')) return transportTip;

  if (reason.includes('manually-canceled') || reason.includes('user-hangup') || reason.includes('customer-ended-call')) {
    if (reason.includes('user-hangup') || reason.includes('manually-canceled')) {
      return `You hung up the call to ${name}.`;
    }
  }
  if (status === 'no-answer' || reason.includes('customer-did-not-answer')) {
    return `${name} didn't pick up — they may be unavailable right now.`;
  }
  if (status === 'busy' || reason.includes('customer-busy')) {
    return `${name}'s line was busy. Try again in a few minutes.`;
  }
  if (reason.includes('voicemail') || reason.includes('machine')) {
    return `${name} didn't answer; the call went to voicemail.`;
  }
  if (reason.includes('silence-timed-out')) {
    return `No one responded on the call to ${name}.`;
  }
  if (status === 'failed' || (target.error && !target.transcript)) {
    const err = typeof target.error === 'string' ? target.error : 'Call could not be completed.';
    return `${name}: ${err}`;
  }
  if (status === 'ended' && !(target.transcript || '').trim()) {
    return `${name} didn't respond — the call ended without a conversation.`;
  }
  if (!target.callId) {
    return `Call to ${name} hasn't started yet.`;
  }
  if (!TERMINAL_STATUSES.has(status)) {
    if (status === 'queued') return `Calling ${name}…`;
    if (status === 'ringing') return `Ringing ${name}…`;
    if (status === 'in-progress' || status === 'dialing') return `On the line with ${name}…`;
    return `Call to ${name} is in progress…`;
  }
  return '';
}

function buildUnreachableRecommendation(mission) {
  const outcomes = mission.targets
    .filter((t) => t.phone)
    .map((t) => ({ target: t, text: describeTargetOutcome(t) }))
    .filter((o) => o.text);

  const allTransport = mission.targets.every((t) =>
    String(t.endedReason || '').includes('error-get-transport')
  );

  const summary =
    outcomes.length === 1
      ? outcomes[0].text
      : outcomes.map((o) => o.text).join(' ');

  return {
    summary,
    bestOffer: {
      targetName: mission.targets[0]?.name || '',
      headline: allTransport ? 'Call never connected' : 'Could not reach contact',
      details: summary,
      nextStep: allTransport
        ? 'Upgrade Twilio or verify the destination number, then try again.'
        : 'Tap Retry call to ring again with the same message, or try later.',
    },
    alternatives: [],
    unresolved: outcomes.map((o) => o.text),
  };
}

async function save(mission) {
  await saveMission(mission);
}

function explainCallFailure(endedReason = '', targetPhone = '') {
  const reason = String(endedReason || '');
  if (reason.includes('pipeline-error-eleven-labs-voice-failed') || reason.includes('eleven-labs')) {
    return `Call dropped: ElevenLabs voice failed. Kumaran and other library voices need a paid ElevenLabs API plan — upgrade at elevenlabs.io, add ELEVENLABS_API_KEY to .env, then retry. Until then the app falls back to the default Vapi voice.`;
  }
  if (reason.includes('error-get-transport') || reason.includes('twilio-failed-to-connect')) {
    return [
      `The call to ${targetPhone || 'the number'} never connected.`,
      'Your Twilio account is on Trial mode. Trial accounts can ONLY call numbers you have verified in Twilio.',
      'Fix: upgrade Twilio to a paid account (Console → Upgrade), OR verify this destination number under Phone Numbers → Verified Caller IDs, then try again.',
    ].join(' ');
  }
  if (reason.includes('customer-did-not-answer')) {
    return `Didn't pick up — may be unavailable right now.`;
  }
  if (reason.includes('customer-busy')) {
    return `Line was busy.`;
  }
  if (reason.includes('voicemail') || reason.includes('machine')) {
    return `Went to voicemail — no one answered.`;
  }
  if (reason.includes('silence-timed-out')) {
    return `No one responded on the call.`;
  }
  if (reason) return `Call ended: ${reason.replace(/-/g, ' ')}`;
  return '';
}

function publicMission(mission) {
  return {
    ...mission,
    canRetry: (mission.targets || []).some(isRetryableTarget),
    targets: (mission.targets || []).map((t) => ({
      ...t,
      controlUrl: undefined,
      outcome: describeTargetOutcome(t),
      canRetry: isRetryableTarget(t),
      live: Boolean(t.callId && !TERMINAL_STATUSES.has(String(t.status))),
    })),
    attachments: (mission.attachments || []).map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      status: a.status,
      error: a.error,
      // keep a short preview only in API responses
      preview: (a.extractedText || '').slice(0, 400),
      hasContent: Boolean(a.extractedText),
    })),
  };
}

function parseProfile(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseContacts(raw) {
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
    .filter((c) => c && c.name && c.phone)
    .map((c) => ({
      id: c.id || null,
      name: String(c.name).trim(),
      phone: toE164US(c.phone),
      notes: c.notes ? String(c.notes).trim() : '',
    }));
}

function parseDryRun(raw) {
  if (raw === true || raw === 'true' || raw === '1') return true;
  return false;
}

function buildProcessSteps(plan, targets, profile) {
  const steps = [];
  let n = 1;

  steps.push({
    step: n++,
    title: 'Review your request',
    detail: plan.goal || 'Understand what you need done.',
  });

  if (plan.discoveryQuery) {
    steps.push({
      step: n++,
      title: 'Find businesses to call',
      detail: `Search for real businesses matching "${plan.discoveryQuery}"${profile.area ? ` near ${profile.area}` : ''}.`,
    });
  }

  const callable = targets.filter((t) => t.phone);
  if (callable.length) {
    steps.push({
      step: n++,
      title: `Place ${callable.length} outbound call${callable.length > 1 ? 's' : ''}`,
      detail: `Dial from your number as ${profile.name}. Callback: ${profile.phone}.`,
    });

    for (const t of callable) {
      steps.push({
        step: n++,
        title: `Call ${t.name}`,
        detail: [t.phone, t.address].filter(Boolean).join(' · ') || t.phone,
      });
    }
  }

  if (plan.compareOffers) {
    steps.push({
      step: n++,
      title: 'Compare & recommend',
      detail: 'Review transcripts and tell you the best offer or outcome.',
    });
  } else {
    steps.push({
      step: n++,
      title: 'Report back',
      detail: 'Share what was confirmed on the call(s).',
    });
  }

  return steps;
}

function buildTarget(fields) {
  return {
    id: uuidv4(),
    plannedName: fields.plannedName || fields.name,
    reason: fields.reason || '',
    searchQuery: fields.searchQuery || '',
    name: fields.name,
    phone: fields.phone || '',
    address: fields.address || '',
    website: fields.website || '',
    source: fields.source || null,
    confidence: fields.confidence || null,
    status: fields.phone ? 'ready' : 'lookup_failed',
    callId: null,
    transcript: '',
    endedReason: '',
    error: fields.phone ? null : fields.error || 'Could not find phone number',
  };
}

async function resolveTargets(plan, profile) {
  const resolved = [];

  // A location named in the request outranks the saved profile area. When they differ we
  // also drop the profile coordinates — Round Rock lat/lng would drag a Leander search back.
  const requestedArea = String(plan.requestedArea || '').trim();
  const profileCity = String(profile.area || '').split(',')[0].trim();
  const overridesProfile =
    Boolean(requestedArea) &&
    (!profileCity || !new RegExp(`\\b${profileCity}\\b`, 'i').test(requestedArea));
  const searchArea = overridesProfile ? requestedArea : profile.area;
  const searchLat = overridesProfile ? null : profile.latitude;
  const searchLng = overridesProfile ? null : profile.longitude;

  for (const target of plan.targets || []) {
    const directPhone = target.phone ? toE164US(target.phone) : '';

    // User already gave the number — dial it. Do not invent a different business.
    if (directPhone) {
      resolved.push({
        id: uuidv4(),
        plannedName: target.name || 'Requested number',
        reason: target.reason || 'Phone number provided by user',
        searchQuery: '',
        name: target.name || 'Requested number',
        phone: directPhone,
        address: '',
        website: '',
        source: 'user_provided',
        confidence: 'high',
        status: 'ready',
        callId: null,
        transcript: '',
        endedReason: '',
        error: null,
      });
      continue;
    }

    const found = await lookupBusiness({
      name: target.name,
      searchQuery: target.searchQuery || `${target.name} near ${searchArea || ''}`.trim(),
      locationHint: searchArea,
      latitude: searchLat,
      longitude: searchLng,
    });
    resolved.push(
      buildTarget({
        plannedName: target.name,
        reason: target.reason || '',
        searchQuery: target.searchQuery || target.name,
        name: found?.name || target.name,
        phone: found?.phone || '',
        address: found?.address,
        website: found?.website,
        source: found?.source,
        confidence: found?.confidence,
        error: found?.error || found?.notes || null,
      })
    );
  }

  // Category requests ("shop car leases") have no named business — go find real ones.
  const stillNeeded = Math.max((plan.maxTargets || 1) - resolved.filter((t) => t.phone).length, 0);
  if (plan.discoveryQuery && stillNeeded > 0) {
    const discovered = await discoverBusinesses({
      query: plan.discoveryQuery,
      locationHint: searchArea,
      latitude: searchLat,
      longitude: searchLng,
      count: stillNeeded,
    });

    for (const biz of discovered) {
      const phone = toE164US(biz.phone);
      if (!phone) continue;
      if (resolved.some((t) => t.phone === phone)) continue;
      resolved.push(
        buildTarget({
          plannedName: biz.name,
          reason: 'Found by search for your request',
          searchQuery: plan.discoveryQuery,
          name: biz.name,
          phone,
          address: biz.address,
          website: biz.website,
          source: 'openai_discovery',
          confidence: biz.confidence || 'medium',
        })
      );
    }
  }

  const withPhones = resolved.filter((t) => t.phone);
  return withPhones.length ? withPhones.slice(0, plan.maxTargets || 3) : resolved;
}

function isRetryableTarget(target) {
  if (!target?.phone || target.status === 'lookup_failed') return false;
  // Still mid-call — don't redial yet
  if (target.callId && !TERMINAL_STATUSES.has(String(target.status))) return false;
  if (isUnreachableTarget(target)) return true;
  // Never dialed / stuck before connect
  if (!target.callId) return true;
  return false;
}

async function dialTargets(mission, { onlyTargetIds } = {}) {
  mission.status = 'calling';
  for (const target of mission.targets) {
    if (onlyTargetIds && !onlyTargetIds.includes(target.id)) continue;
    if (!target.phone) {
      target.status = 'lookup_failed';
      continue;
    }
    try {
      target.status = 'dialing';
      target.error = null;
      const call = await placeMissionCall({
        profile: mission.profile,
        plan: mission.plan,
        target,
        attachments: mission.attachments || [],
        missionId: mission.id,
      });
      target.callId = call.id;
      target.status = call.status || 'queued';
      target.callCreatedAt = call.createdAt;
      target.controlUrl = call.monitor?.controlUrl || call.controlUrl || null;
    } catch (err) {
      target.status = 'failed';
      target.error = err.response?.data || err.message;
    }
  }

  const scoped = onlyTargetIds
    ? mission.targets.filter((t) => onlyTargetIds.includes(t.id))
    : mission.targets;

  const anyQueued = scoped.some((t) => t.callId && !TERMINAL_STATUSES.has(t.status));
  const anySuccessDial = scoped.some((t) => t.callId);
  if (!anySuccessDial) {
    mission.status = 'failed';
    mission.error = 'No calls could be started';
  } else if (!anyQueued) {
    await finalizeIfReady(mission);
  } else {
    mission.status = 'in_progress';
  }
  mission.updatedAt = new Date().toISOString();
  await save(mission);
}

async function refreshMissionCalls(mission) {
  let pending = mission.targets.some(isTargetPending);

  for (const target of mission.targets) {
    if (!target.callId) continue;
    // Once ended we still pull one authoritative copy of the transcript, otherwise the
    // conversation stays stuck on whatever partial text the live webhook had last.
    if (TERMINAL_STATUSES.has(target.status) && target.transcriptFinal) continue;
    try {
      const call = await getCall(target.callId);
      target.status = call.status || target.status;
      target.endedReason = call.endedReason || target.endedReason || '';
      target.controlUrl =
        call.monitor?.controlUrl || call.controlUrl || target.controlUrl || null;
      const nextTranscript = extractTranscriptFromCall(call);
      const ended = TERMINAL_STATUSES.has(String(target.status));
      if (nextTranscript) {
        // The ended call's stored transcript is authoritative even if it reads shorter
        // than the accumulated live text.
        if (ended || nextTranscript.length >= String(target.transcript || '').length) {
          target.transcript = nextTranscript;
        }
      }
      if (ended && (target.transcript || target.endedReason)) {
        target.transcriptFinal = true;
      }
      const tip = explainCallFailure(target.endedReason, target.phone);
      if (tip && isUnreachableTarget(target)) target.error = tip;
      if (!TERMINAL_STATUSES.has(String(target.status))) {
        pending = true;
      }
    } catch (err) {
      target.error = err.response?.data || err.message;
      // Vapi no longer knows this call (aged out / bad id). Treating it as still pending
      // would keep the mission on "In progress" forever, so close it out instead.
      if (err.response?.status === 404) {
        target.status = 'ended';
        target.endedReason = target.endedReason || 'call-not-found';
      } else {
        pending = true;
      }
    }
  }

  pending = pending || mission.targets.some(isTargetPending);

  if (!pending) {
    await finalizeIfReady(mission);
  } else {
    mission.status = mission.status === 'starting' ? 'starting' : 'in_progress';
  }
  mission.updatedAt = new Date().toISOString();
  await save(mission);
  return mission;
}

async function finalizeIfReady(mission) {
  const dialed = mission.targets.filter((t) => t.callId);
  if (!dialed.length) {
    mission.status = mission.status === 'starting' ? 'starting' : 'calling';
    return;
  }

  const softPending = dialed.some((t) => !TERMINAL_STATUSES.has(String(t.status)));
  if (softPending) {
    mission.status = 'in_progress';
    return;
  }

  // Attach human-readable errors onto targets
  for (const t of mission.targets) {
    const tip = explainCallFailure(t.endedReason, t.phone) || describeTargetOutcome(t);
    if (tip && (isUnreachableTarget(t) || !t.transcript)) t.error = tip;
  }

  const transportFails = mission.targets.filter((t) =>
    String(t.endedReason || '').includes('error-get-transport')
  );

  if (transportFails.length && transportFails.length === dialed.length) {
    mission.status = 'failed';
    mission.error = explainCallFailure(transportFails[0].endedReason, transportFails[0].phone);
    mission.recommendation = buildUnreachableRecommendation(mission);
    mission.updatedAt = new Date().toISOString();
    await save(mission);
    return;
  }

  const allUnreachable = dialed.every((t) => isUnreachableTarget(t));
  if (allUnreachable) {
    mission.recommendation = buildUnreachableRecommendation(mission);
    mission.status = dialed.every((t) => String(t.endedReason || '').includes('error-get-transport'))
      ? 'failed'
      : 'completed';
    mission.updatedAt = new Date().toISOString();
    await save(mission);
    return;
  }

  try {
    mission.recommendation = await summarizeMissionResults({
      plan: mission.plan,
      profile: mission.profile,
      targets: mission.targets,
    });
    mission.status = 'completed';
  } catch (err) {
    mission.status = 'completed_with_errors';
    mission.error = err.message;
    mission.recommendation = {
      summary: 'Calls finished but summary failed.',
      bestOffer: { targetName: '', headline: '', details: '', nextStep: '' },
      alternatives: [],
      unresolved: [err.message],
    };
  }
  mission.updatedAt = new Date().toISOString();
  await save(mission);
}

function parseAnswers(raw) {
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
    .filter((a) => a && a.question && String(a.answer || '').trim())
    .map((a) => ({
      id: a.id || null,
      question: String(a.question),
      answer: String(a.answer).trim(),
    }));
}

async function applyVapiWebhook(body = {}) {
  const message = body.message || body;
  const type = String(message.type || body.type || '');
  const call = message.call || body.call || {};
  const callId = call.id || message.callId || body.callId;
  const meta = call.metadata || message.metadata || body.metadata || {};
  const mission = await findMissionByCallId(callId, meta.missionId);
  if (!mission) return null;
  const target =
    (mission.targets || []).find((t) => t.id === meta.targetId && t.callId === callId)
    || (mission.targets || []).find((t) => t.callId === callId);
  if (!target) return null;

  if (type === 'status-update' && message.status) {
    target.status = message.status;
  }

  if (type === 'transcript' || type.startsWith('transcript')) {
    const role = message.role || 'user';
    const text = message.transcript || message.message || '';
    const isPartial = String(message.transcriptType || '').toLowerCase() === 'partial';
    upsertLiveTurn(target, role, text, isPartial);
  }

  if (type === 'conversation-update') {
    const list = message.messages || message.conversation || [];
    if (Array.isArray(list) && list.length) {
      target.liveTurns = [];
      for (const m of list) {
        const role = m.role || m.speaker || '';
        const text = m.message || m.transcript || m.content || m.text || '';
        if (['system', 'tool', 'function'].includes(String(role).toLowerCase())) continue;
        upsertLiveTurn(target, role, text, false);
      }
    }
  }

  if (type === 'end-of-call-report') {
    const artifact = message.artifact || {};
    const full = extractTranscriptFromCall({ artifact, ...call, transcript: artifact.transcript });
    if (full) {
      target.transcript = full;
      target.transcriptFinal = true;
    }
    target.status = 'ended';
    target.endedReason = message.endedReason || target.endedReason || '';
  }

  // The call is over — wrap the mission up here rather than waiting for someone to poll.
  if (needsFinalize(mission)) {
    try {
      await finalizeIfReady(mission);
    } catch (err) {
      console.error('[vapi webhook] finalize failed', err);
    }
  }

  mission.updatedAt = new Date().toISOString();
  await save(mission);
  return mission;
}

router.post('/vapi/webhook', async (req, res) => {
  try {
    await applyVapiWebhook(req.body || {});
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[vapi webhook]', err);
    return res.status(200).json({ ok: false });
  }
});

router.get('/chat/history', async (req, res) => {
  const phone = String(req.query?.phone || req.body?.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  return res.json({ history: await loadChatHistory(phone) });
});

router.post('/chat/history', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  const saved = await saveChatHistory(phone, history);
  return res.json({ history: saved });
});

router.post('/chat', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const profile = parseProfile(req.body?.profile) || {};
    if (!message) return res.status(400).json({ error: 'message is required' });
    const result = await answerChat({ message, history, profile });
    const nextHistory = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: result.answer || '' },
    ].slice(-40);
    if (profile.phone) await saveChatHistory(profile.phone, nextHistory);
    return res.json({ ...result, history: nextHistory });
  } catch (err) {
    console.error('[chat] failed', err);
    return res.status(500).json({ error: err.message || 'Could not answer' });
  }
});

router.post('/clarify', maybeUpload, async (req, res) => {
  try {
    const request = req.body?.request;
    const profile = parseProfile(req.body?.profile);
    const contacts = parseContacts(req.body?.contacts);
    const answers = parseAnswers(req.body?.answers);

    if (!request || !profile?.name || !profile?.phone) {
      return res.status(400).json({
        error: 'request and profile.name / profile.phone are required. Save them in Settings first.',
      });
    }

    const attachments = await processUploads(req.files || []);
    const history = parseChatHistory(req.body?.history);
    const result = await clarifyRequest({
      request,
      profile: { ...profile, phone: toE164US(profile.phone) },
      contacts,
      attachments,
      answers,
      history,
    });

    return res.json(result);
  } catch (err) {
    console.error('[clarify] failed', err);
    return res.status(500).json({ error: err.message || 'Failed to check request' });
  }
});

router.post('/missions', maybeUpload, async (req, res) => {
  try {
    const request = req.body?.request;
    const originalRequest = req.body?.originalRequest || request;
    const profile = parseProfile(req.body?.profile);
    const contacts = parseContacts(req.body?.contacts);
    const clarifications = parseAnswers(req.body?.clarifications);
    const dryRun = parseDryRun(req.body?.dryRun);

    if (!request || !profile?.name || !profile?.phone) {
      return res.status(400).json({
        error: 'request and profile.name / profile.phone are required. Save them in Settings first.',
      });
    }

    const normalizedProfile = {
      name: profile.name,
      phone: toE164US(profile.phone),
      area: profile.area || '',
      latitude: profile.latitude ?? null,
      longitude: profile.longitude ?? null,
    };

    const attachments = await processUploads(req.files || []);
    const history = parseChatHistory(req.body?.history);

    // Safety net: only when we skipped clarify AND this is not a known-person call.
    if (
      !dryRun &&
      !clarifications.length &&
      !canPlaceDirectCall({ request: conversationCorpus(request, history), contacts })
    ) {
      const check = await clarifyRequest({
        request,
        profile: normalizedProfile,
        contacts,
        attachments,
        answers: [],
        history,
      });
      if (!check.ready && check.questions.length) {
        return res.status(422).json({
          error: 'More details needed before calling.',
          needsClarification: true,
          questions: check.questions,
        });
      }
    }

    const plan = await planMission({
      request,
      profile: normalizedProfile,
      attachments,
      contacts,
      history,
    });
    const targets = await resolveTargets(plan, normalizedProfile);

    if (!targets.some((t) => t.phone)) {
      return res.status(422).json({
        error:
          'Could not find phone numbers for this request. Set your area in Settings, or name a specific business/contact.',
        plan,
        targets,
      });
    }

    plan.processSteps = buildProcessSteps(plan, targets, normalizedProfile);

    const id = uuidv4();
    const mission = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: dryRun ? 'preview' : 'planning',
      request,
      originalRequest,
      clarifications,
      profile: normalizedProfile,
      contactsUsed: contacts,
      plan,
      targets,
      attachments,
      recommendation: null,
      error: null,
    };

    await save(mission);

    if (dryRun) {
      return res.status(201).json(publicMission(mission));
    }

    // Respond immediately — placing calls can take 10–30s (lookup + Vapi).
    // Don't block the HTTP request or the dev proxy will 502.
    mission.status = 'starting';
    mission.updatedAt = new Date().toISOString();
    await save(mission);
    res.status(201).json(publicMission(mission));

    dialTargets(mission).catch(async (err) => {
      console.error('[missions] background dial failed', err);
      mission.status = 'failed';
      mission.error = err.message || 'Failed to start calls';
      mission.updatedAt = new Date().toISOString();
      await save(mission);
    });
    return;
  } catch (err) {
    console.error('[missions] create failed', err);
    return res.status(500).json({ error: err.message || 'Failed to create mission' });
  }
});

router.post('/missions/:id/execute', async (req, res) => {
  try {
    const mission = await getMission(req.params.id);
    if (!mission) return res.status(404).json({ error: 'Mission not found' });
    if (mission.status !== 'preview') {
      return res.status(400).json({ error: 'Only preview missions can be executed from here.' });
    }
    if (!mission.targets?.some((t) => t.phone)) {
      return res.status(422).json({ error: 'No callable targets in this plan.' });
    }

    mission.status = 'planning';
    mission.updatedAt = new Date().toISOString();
    await save(mission);

    res.json(publicMission(mission));

    dialTargets(mission).catch(async (err) => {
      console.error('[missions] execute dial failed', err);
      mission.status = 'failed';
      mission.error = err.message || 'Failed to start calls';
      mission.updatedAt = new Date().toISOString();
      await save(mission);
    });
    return;
  } catch (err) {
    console.error('[missions] execute failed', err);
    return res.status(500).json({ error: err.message || 'Failed to execute mission' });
  }
});

router.get('/missions', async (req, res) => {
  const includePreviews = req.query.includePreviews === 'true';
  let list = (await listMissions()).sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  );
  if (!includePreviews) {
    list = list.filter((m) => m.status !== 'preview');
  }

  // Heal cards left on "In progress" by a call that ended while nobody was watching.
  // Bounded so History stays fast; the rest settle on the next load.
  const stale = list
    .filter((m) => isStalledBeforeDialing(m) || isMissionPending(m) || needsFinalize(m))
    .slice(0, 3);
  await Promise.all(
    stale.map(async (mission) => {
      try {
        await reconcileMission(mission);
      } catch (err) {
        console.warn('[missions] reconcile on list failed', mission.id, err.message);
      }
    })
  );

  res.json(list.map(publicMission));
});

router.get('/missions/:id', async (req, res) => {
  const mission = await getMission(req.params.id);
  if (!mission) return res.status(404).json({ error: 'Mission not found' });

  await reconcileMission(mission);
  return res.json(publicMission(mission));
});

router.post('/missions/:id/refresh', async (req, res) => {
  const mission = await getMission(req.params.id);
  if (!mission) return res.status(404).json({ error: 'Mission not found' });
  await refreshMissionCalls(mission);
  return res.json(publicMission(mission));
});

/**
 * Redial targets that didn't connect (no answer, busy, voicemail, failed, never started).
 * Reuses the same mission plan / conversation brief.
 */
router.post('/missions/:id/retry', async (req, res) => {
  try {
    const mission = await getMission(req.params.id);
    if (!mission) return res.status(404).json({ error: 'Mission not found' });
    if (mission.status === 'preview') {
      return res.status(400).json({ error: 'Preview missions cannot be retried. Use Start calls.' });
    }

    const requestedIds = Array.isArray(req.body?.targetIds) ? req.body.targetIds : null;
    const retryable = mission.targets.filter((t) => {
      if (requestedIds && !requestedIds.includes(t.id)) return false;
      return isRetryableTarget(t);
    });

    if (!retryable.length) {
      return res.status(400).json({
        error: 'Nothing to retry — no unanswered, busy, voicemail, or failed calls.',
      });
    }

    for (const target of retryable) {
      if (!Array.isArray(target.previousAttempts)) target.previousAttempts = [];
      if (target.callId || target.transcript || target.endedReason) {
        target.previousAttempts.push({
          callId: target.callId || null,
          status: target.status,
          endedReason: target.endedReason || '',
          transcript: target.transcript || '',
          at: new Date().toISOString(),
        });
      }
      target.callId = null;
      target.status = 'ready';
      target.transcript = '';
      target.endedReason = '';
      target.error = null;
      target.callCreatedAt = null;
    }

    mission.recommendation = null;
    mission.error = null;
    mission.status = 'starting';
    mission.updatedAt = new Date().toISOString();
    await save(mission);

    res.json(publicMission(mission));

    dialTargets(mission, { onlyTargetIds: retryable.map((t) => t.id) }).catch(async (err) => {
      console.error('[missions] retry dial failed', err);
      mission.status = 'failed';
      mission.error = err.message || 'Failed to retry calls';
      mission.updatedAt = new Date().toISOString();
      await save(mission);
    });
    return;
  } catch (err) {
    console.error('[missions] retry failed', err);
    return res.status(500).json({ error: err.message || 'Failed to retry mission' });
  }
});

/**
 * Manually hang up live / ringing calls for this mission.
 */
router.post('/missions/:id/hangup', async (req, res) => {
  try {
    const mission = await getMission(req.params.id);
    if (!mission) return res.status(404).json({ error: 'Mission not found' });
    if (mission.status === 'preview') {
      return res.status(400).json({ error: 'No call to hang up yet.' });
    }

    const requestedIds = Array.isArray(req.body?.targetIds) ? req.body.targetIds : null;
    const live = mission.targets.filter((t) => {
      if (!t.callId) return false;
      if (requestedIds && !requestedIds.includes(t.id)) return false;
      return !TERMINAL_STATUSES.has(String(t.status)) || t.status === 'dialing';
    });

    if (!live.length) {
      return res.status(400).json({ error: 'No active call to hang up.' });
    }

    const errors = [];
    for (const target of live) {
      try {
        const result = await endCall(target.callId, target.controlUrl);
        const after = result.call || (await getCall(target.callId).catch(() => null));
        const nextTranscript = extractTranscriptFromCall(after);
        if (nextTranscript) target.transcript = nextTranscript;
        target.status = 'ended';
        target.endedReason = after?.endedReason || 'user-hangup';
        target.error = 'You hung up the call.';
        target.controlUrl = null;
      } catch (err) {
        errors.push(`${target.name}: ${err.message}`);
        target.status = 'ended';
        target.endedReason = 'user-hangup';
        target.error = err.message || 'Hang up failed';
      }
    }

    mission.updatedAt = new Date().toISOString();
    await save(mission);
    await refreshMissionCalls(mission);

    if (errors.length && live.length === errors.length) {
      return res.status(502).json({
        error: errors.join('; '),
        mission: publicMission(mission),
      });
    }

    return res.json(publicMission(mission));
  } catch (err) {
    console.error('[missions] hangup failed', err);
    return res.status(500).json({ error: err.message || 'Failed to hang up' });
  }
});

router.delete('/missions/:id', async (req, res) => {
  const mission = await getMission(req.params.id);
  if (!mission) return res.status(404).json({ error: 'Mission not found' });
  await removeMission(req.params.id);
  return res.json({ ok: true, id: req.params.id });
});

module.exports = router;