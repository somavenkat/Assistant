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
const { createMemoryMap, persistMission, deleteMission } = require('../services/store');

const router = express.Router();
const missions = createMemoryMap();

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

function save(mission) {
  missions.set(mission.id, mission);
  persistMission(mission);
}

function explainCallFailure(endedReason = '', targetPhone = '') {
  const reason = String(endedReason || '');
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
      searchQuery: target.searchQuery || `${target.name} near ${profile.area || ''}`.trim(),
      locationHint: profile.area,
      latitude: profile.latitude,
      longitude: profile.longitude,
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
      locationHint: profile.area,
      latitude: profile.latitude,
      longitude: profile.longitude,
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
  save(mission);
}

async function refreshMissionCalls(mission) {
  let pending = mission.targets.some(isTargetPending);

  for (const target of mission.targets) {
    if (!target.callId) continue;
    if (TERMINAL_STATUSES.has(target.status) && target.transcript) continue;
    try {
      const call = await getCall(target.callId);
      target.status = call.status || target.status;
      target.endedReason = call.endedReason || target.endedReason || '';
      target.controlUrl =
        call.monitor?.controlUrl || call.controlUrl || target.controlUrl || null;
      const nextTranscript = extractTranscriptFromCall(call);
      if (nextTranscript && nextTranscript.length >= String(target.transcript || '').length) {
        target.transcript = nextTranscript;
      }
      const tip = explainCallFailure(target.endedReason, target.phone);
      if (tip && isUnreachableTarget(target)) target.error = tip;
      if (!TERMINAL_STATUSES.has(String(target.status))) {
        pending = true;
      }
    } catch (err) {
      target.error = err.response?.data || err.message;
      pending = true;
    }
  }

  pending = pending || mission.targets.some(isTargetPending);

  if (!pending) {
    await finalizeIfReady(mission);
  } else {
    mission.status = mission.status === 'starting' ? 'starting' : 'in_progress';
  }
  mission.updatedAt = new Date().toISOString();
  save(mission);
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
    save(mission);
    return;
  }

  const allUnreachable = dialed.every((t) => isUnreachableTarget(t));
  if (allUnreachable) {
    mission.recommendation = buildUnreachableRecommendation(mission);
    mission.status = dialed.every((t) => String(t.endedReason || '').includes('error-get-transport'))
      ? 'failed'
      : 'completed';
    mission.updatedAt = new Date().toISOString();
    save(mission);
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
  save(mission);
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

/**
 * Ask follow-up questions until we know enough to place the call.
 */
function findMissionByCallId(callId, hintMissionId) {
  if (hintMissionId && missions.has(hintMissionId)) {
    const hinted = missions.get(hintMissionId);
    if ((hinted.targets || []).some((t) => t.callId === callId || !callId)) return hinted;
  }
  if (!callId) return null;
  for (const mission of missions.values()) {
    if ((mission.targets || []).some((t) => t.callId === callId)) return mission;
  }
  return null;
}

function applyVapiWebhook(body = {}) {
  const message = body.message || body;
  const type = String(message.type || body.type || '');
  const call = message.call || body.call || {};
  const callId = call.id || message.callId || body.callId;
  const meta = call.metadata || message.metadata || body.metadata || {};
  const mission = findMissionByCallId(callId, meta.missionId);
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
    if (full) target.transcript = full;
    target.status = 'ended';
    target.endedReason = message.endedReason || target.endedReason || '';
  }

  mission.updatedAt = new Date().toISOString();
  save(mission);
  return mission;
}

router.post('/vapi/webhook', async (req, res) => {
  try {
    applyVapiWebhook(req.body || {});
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[vapi webhook]', err);
    return res.status(200).json({ ok: false });
  }
});

router.post('/chat', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const profile = parseProfile(req.body?.profile) || {};
    if (!message) return res.status(400).json({ error: 'message is required' });
    const result = await answerChat({ message, history, profile });
    return res.json(result);
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
    const result = await clarifyRequest({
      request,
      profile: { ...profile, phone: toE164US(profile.phone) },
      contacts,
      attachments,
      answers,
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

    // Safety net: only when we skipped clarify AND this is not a known-person call.
    if (!dryRun && !clarifications.length && !canPlaceDirectCall({ request, contacts })) {
      const check = await clarifyRequest({
        request,
        profile: normalizedProfile,
        contacts,
        attachments,
        answers: [],
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

    missions.set(id, mission);
    save(mission);

    if (dryRun) {
      return res.status(201).json(publicMission(mission));
    }

    // Respond immediately — placing calls can take 10–30s (lookup + Vapi).
    // Don't block the HTTP request or the dev proxy will 502.
    mission.status = 'starting';
    mission.updatedAt = new Date().toISOString();
    save(mission);
    res.status(201).json(publicMission(mission));

    dialTargets(mission).catch((err) => {
      console.error('[missions] background dial failed', err);
      mission.status = 'failed';
      mission.error = err.message || 'Failed to start calls';
      mission.updatedAt = new Date().toISOString();
      save(mission);
    });
    return;
  } catch (err) {
    console.error('[missions] create failed', err);
    return res.status(500).json({ error: err.message || 'Failed to create mission' });
  }
});

router.post('/missions/:id/execute', async (req, res) => {
  try {
    const mission = missions.get(req.params.id);
    if (!mission) return res.status(404).json({ error: 'Mission not found' });
    if (mission.status !== 'preview') {
      return res.status(400).json({ error: 'Only preview missions can be executed from here.' });
    }
    if (!mission.targets?.some((t) => t.phone)) {
      return res.status(422).json({ error: 'No callable targets in this plan.' });
    }

    mission.status = 'planning';
    mission.updatedAt = new Date().toISOString();
    save(mission);

    res.json(publicMission(mission));

    dialTargets(mission).catch((err) => {
      console.error('[missions] execute dial failed', err);
      mission.status = 'failed';
      mission.error = err.message || 'Failed to start calls';
      mission.updatedAt = new Date().toISOString();
      save(mission);
    });
    return;
  } catch (err) {
    console.error('[missions] execute failed', err);
    return res.status(500).json({ error: err.message || 'Failed to execute mission' });
  }
});

router.get('/missions', (req, res) => {
  const includePreviews = req.query.includePreviews === 'true';
  let list = Array.from(missions.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!includePreviews) {
    list = list.filter((m) => m.status !== 'preview');
  }
  res.json(list.map(publicMission));
});

router.get('/missions/:id', async (req, res) => {
  const mission = missions.get(req.params.id);
  if (!mission) return res.status(404).json({ error: 'Mission not found' });

  if (isMissionPending(mission)) {
    await refreshMissionCalls(mission);
  }
  return res.json(publicMission(mission));
});

router.post('/missions/:id/refresh', async (req, res) => {
  const mission = missions.get(req.params.id);
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
    const mission = missions.get(req.params.id);
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
    save(mission);

    res.json(publicMission(mission));

    dialTargets(mission, { onlyTargetIds: retryable.map((t) => t.id) }).catch((err) => {
      console.error('[missions] retry dial failed', err);
      mission.status = 'failed';
      mission.error = err.message || 'Failed to retry calls';
      mission.updatedAt = new Date().toISOString();
      save(mission);
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
    const mission = missions.get(req.params.id);
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
    save(mission);
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

router.delete('/missions/:id', (req, res) => {
  const mission = missions.get(req.params.id);
  if (!mission) return res.status(404).json({ error: 'Mission not found' });
  missions.delete(req.params.id);
  deleteMission(req.params.id);
  return res.json({ ok: true, id: req.params.id });
});

module.exports = router;
module.exports.missions = missions;