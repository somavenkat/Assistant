import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { executeMission, getMission, hangupMission, retryMission, type MissionRecord } from '../api';
import CallTranscript from '../components/CallTranscript';
import { Button, Card, Content, ErrorText, Page, Pill, Spinner, TopBar } from '../ui';

const TERMINAL = ['ended', 'completed', 'failed', 'busy', 'no-answer'];

export default function MissionStatus() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [mission, setMission] = useState<MissionRecord | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [hangingUp, setHangingUp] = useState(false);

  const isPreview = mission?.status === 'preview';
  const failed = mission?.status === 'failed';
  const done = mission?.status === 'completed' || mission?.status === 'completed_with_errors';

  const liveCallInProgress = (mission?.targets || []).some(
    (t) => t.live || (t.callId && !TERMINAL.includes(String(t.status)))
  );
  const dialingNow = (mission?.targets || []).some((t) => t.status === 'dialing');
  const canHangUp = Boolean(liveCallInProgress || dialingNow) && !isPreview;

  const pending =
    mission &&
    !isPreview &&
    (liveCallInProgress ||
      dialingNow ||
      mission.status === 'planning' ||
      (mission.status === 'in_progress' && liveCallInProgress) ||
      (done && mission.targets.some((t) => t.callId && !TERMINAL.includes(t.status))));

  const showRetry =
    Boolean(mission?.canRetry) && !isPreview && !liveCallInProgress && !dialingNow && !executing && !hangingUp;

  async function refresh() {
    if (!id) return;
    try {
      const data = await getMission(id);
      setMission(data);
      setError('');
    } catch (e: any) {
      setError(e.message || 'Failed to load mission');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [id]);

  // The last webhook often lands just after the call ends, so pull once more to pick up
  // the complete transcript.
  const wasLive = useRef(false);
  useEffect(() => {
    if (liveCallInProgress || dialingNow) {
      wasLive.current = true;
      return;
    }
    if (!wasLive.current) return;
    wasLive.current = false;
    const t = setTimeout(refresh, 2500);
    return () => clearTimeout(t);
  }, [liveCallInProgress, dialingNow]);

  useEffect(() => {
    if (!mission || isPreview) return;
    const shouldPoll =
      pending ||
      retrying ||
      hangingUp ||
      mission.status === 'starting' ||
      mission.status === 'calling' ||
      liveCallInProgress ||
      dialingNow;
    if (!shouldPoll) return;
    const ms = liveCallInProgress || dialingNow ? 1200 : 4000;
    const timer = setInterval(refresh, ms);
    return () => clearInterval(timer);
  }, [id, mission?.status, pending, retrying, hangingUp, liveCallInProgress, dialingNow, isPreview]);

  async function startCalls() {
    if (!id) return;
    setExecuting(true);
    setError('');
    try {
      setMission(await executeMission(id));
    } catch (e: any) {
      setError(e.message || 'Could not start calls');
    } finally {
      setExecuting(false);
    }
  }

  async function retryCalls() {
    if (!id) return;
    setRetrying(true);
    setError('');
    try {
      setMission(await retryMission(id));
    } catch (e: any) {
      setError(e.message || 'Could not retry call');
    } finally {
      setRetrying(false);
    }
  }

  async function hangUpCalls() {
    if (!id) return;
    setHangingUp(true);
    setError('');
    try {
      setMission(await hangupMission(id));
    } catch (e: any) {
      setError(e.message || 'Could not hang up');
      await refresh();
    } finally {
      setHangingUp(false);
    }
  }

  function targetStatusLabel(t: MissionRecord['targets'][0]) {
    if (t.live || t.status === 'in-progress' || t.status === 'dialing') {
      if (t.status === 'queued') return 'Calling…';
      if (t.status === 'ringing') return 'Ringing…';
      if (t.status === 'dialing') return 'Dialing…';
      return 'Live on the line…';
    }
    if (t.outcome) return t.outcome;
    if (t.status === 'queued') return 'Calling…';
    if (t.status === 'ringing') return 'Ringing…';
    return t.status;
  }

  function isTargetLive(t: MissionRecord['targets'][0]) {
    return Boolean(t.live || (t.callId && !TERMINAL.includes(String(t.status))));
  }

  const callableTargets = (mission?.targets || []).filter((t) => t.phone);

  return (
    <Page>
      <TopBar
        title={isPreview ? 'Plan preview' : 'Mission'}
        back={isPreview ? '/home' : '/history'}
        right={
          <Button variant="ghost" size="sm" to="/history">
            History
          </Button>
        }
      />
      <Content wide>
        {loading && !mission && <Spinner />}
        {error && <ErrorText>{error}</ErrorText>}

        {mission && (
          <>
            <div className="hero">
              <h1 className="brand">{mission.plan.title}</h1>
              <p className="lede">{mission.plan.goal}</p>
              <div style={{ marginTop: '0.7rem' }}>
                <Pill tone={failed ? 'bad' : liveCallInProgress ? 'live' : 'default'}>
                  {isPreview ? 'preview — no calls placed yet' : mission.status}
                </Pill>
              </div>
            </div>

            {isPreview && (
              <Card highlight>
                <h3>What will happen</h3>
                {(mission.plan.processSteps || []).map((s) => (
                  <div key={s.step} className="step">
                    <span className="step-num">{s.step}</span>
                    <div>
                      <p className="row-title">{s.title}</p>
                      <p>{s.detail}</p>
                    </div>
                  </div>
                ))}
                {!mission.plan.processSteps?.length && (
                  <p>We'll call the businesses below on your behalf and report back.</p>
                )}
              </Card>
            )}

            <Card>
              <h3>Your request</h3>
              <p>{mission.originalRequest || mission.request}</p>
            </Card>

            {mission.clarifications && mission.clarifications.length > 0 && (
              <Card>
                <h3>Details you provided</h3>
                {mission.clarifications.map((c, idx) => (
                  <div key={`${c.id || idx}-${c.question}`} className="row">
                    <p className="row-title">{c.question}</p>
                    <p>{c.answer}</p>
                  </div>
                ))}
              </Card>
            )}

            {mission.plan.spokenBrief && (
              <Card>
                <h3>How we'll talk on the call</h3>
                <p className="clarify-why">Short turns — one line, wait for their reply, then continue.</p>
                {mission.plan.calleeIdentity?.nameAsGiven && (
                  <p className="clarify-why">
                    Calling {mission.plan.calleeIdentity.nameAsGiven}
                    {mission.plan.calleeIdentity.relation ? ` (${mission.plan.calleeIdentity.relation})` : ''}
                    {mission.plan.calleeIdentity.pronouns
                      ? ` · pronouns ${mission.plan.calleeIdentity.pronouns}`
                      : ''}
                  </p>
                )}
                <p>{mission.plan.spokenBrief}</p>
                {mission.plan.callObjective && (
                  <p className="clarify-why">Goal: {mission.plan.callObjective}</p>
                )}
              </Card>
            )}

            {mission.attachments && mission.attachments.length > 0 && (
              <Card>
                <h3>Attached files</h3>
                {mission.attachments.map((a) => (
                  <div key={a.id} className="row">
                    <p className="row-title">
                      {a.filename} · {a.status}
                      {a.hasContent ? ' · details extracted' : ''}
                    </p>
                    {a.preview && (
                      <pre>
                        {a.preview}
                        {a.preview.length >= 400 ? '…' : ''}
                      </pre>
                    )}
                    {a.error && <ErrorText>{a.error}</ErrorText>}
                  </div>
                ))}
              </Card>
            )}

            {mission.plan.requirements && mission.plan.requirements.length > 0 && (
              <Card>
                <h3>Requirements</h3>
                {mission.plan.requirements.map((r) => (
                  <p key={r}>• {r}</p>
                ))}
              </Card>
            )}

            <Card>
              <h3>{isPreview ? `Will call (${callableTargets.length})` : 'Calls'}</h3>
              {callableTargets.length === 0 && (
                <ErrorText>
                  No phone numbers found. Update your area in Settings or name a specific business.
                </ErrorText>
              )}
              {mission.targets.map((t) => (
                <div key={t.id} className="row">
                  <p className="row-title">
                    {t.name}
                    {!isPreview && <> · {targetStatusLabel(t)}</>}
                  </p>
                  <p>{t.phone || 'No phone found'}</p>
                  {t.address && <p>{t.address}</p>}
                  {t.reason && isPreview && <p className="clarify-why">{t.reason}</p>}
                  {t.source && isPreview && (
                    <p className="clarify-why">Source: {t.source.replace(/_/g, ' ')}</p>
                  )}
                  {t.error != null && !t.transcript && !isTargetLive(t) && (
                    <ErrorText>{typeof t.error === 'string' ? t.error : JSON.stringify(t.error)}</ErrorText>
                  )}
                  {(t.transcript || isTargetLive(t)) && (
                    <>
                      <p className="row-title" style={{ marginTop: '0.7rem' }}>
                        {isTargetLive(t) ? 'Live conversation' : 'Transcript'}
                      </p>
                      <CallTranscript
                        transcript={t.transcript || ''}
                        callerName={mission.profile.name}
                        calleeName={t.name}
                        live={isTargetLive(t)}
                      />
                    </>
                  )}
                </div>
              ))}
            </Card>

            {mission.recommendation && !isPreview && (
              <Card highlight>
                <h3>{done ? 'Outcome' : 'Best outcome'}</h3>
                <p>{mission.recommendation.summary}</p>
                {mission.recommendation.bestOffer?.headline && (
                  <>
                    {mission.recommendation.bestOffer.targetName && (
                      <p className="row-title" style={{ marginTop: '0.6rem' }}>
                        {mission.recommendation.bestOffer.targetName}
                      </p>
                    )}
                    <p>{mission.recommendation.bestOffer.headline}</p>
                    {mission.recommendation.bestOffer.details &&
                      mission.recommendation.bestOffer.details !== mission.recommendation.summary && (
                        <p>{mission.recommendation.bestOffer.details}</p>
                      )}
                    {mission.recommendation.bestOffer.nextStep && (
                      <p>{mission.recommendation.bestOffer.nextStep}</p>
                    )}
                  </>
                )}
                {(mission.recommendation.unresolved || []).length > 0 &&
                  !mission.recommendation.bestOffer?.headline && (
                    <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem', color: 'var(--ink-2)' }}>
                      {mission.recommendation.unresolved!.map((u, idx) => (
                        <li key={idx}>{u}</li>
                      ))}
                    </ul>
                  )}
                {(mission.recommendation.alternatives || []).map((alt, idx) => (
                  <p key={idx}>
                    Alt: {alt.targetName} — {alt.headline}
                  </p>
                ))}
              </Card>
            )}

            {(pending || retrying || dialingNow || hangingUp) && (
              <p className="note">
                {hangingUp
                  ? 'Hanging up…'
                  : retrying || mission.status === 'starting' || dialingNow
                    ? 'Starting calls…'
                    : liveCallInProgress
                      ? 'Call in progress — live chat updates above.'
                      : 'Waiting for call to finish…'}{' '}
                This page refreshes automatically.
              </p>
            )}

            <div className="actions actions-sticky">
              {isPreview ? (
                <>
                  <Button variant="outline" onClick={() => navigate('/home')}>
                    Edit request
                  </Button>
                  <Button
                    disabled={callableTargets.length === 0}
                    loading={executing}
                    onClick={startCalls}
                  >
                    Start calls
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={refresh}>
                    Refresh
                  </Button>
                  {canHangUp && (
                    <Button variant="danger" loading={hangingUp} onClick={hangUpCalls}>
                      Hang up
                    </Button>
                  )}
                  {showRetry && (
                    <Button loading={retrying} onClick={retryCalls}>
                      Retry call
                    </Button>
                  )}
                  <Button
                    variant={showRetry || canHangUp ? 'outline' : 'solid'}
                    onClick={() => navigate('/home')}
                  >
                    New request
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </Content>
    </Page>
  );
}
