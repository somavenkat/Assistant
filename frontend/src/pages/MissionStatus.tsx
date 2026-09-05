import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
  IonBackButton,
} from '@ionic/react';
import { executeMission, getMission, hangupMission, retryMission, type MissionRecord } from '../api';
import CallTranscript from '../components/CallTranscript';

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
  const done =
    mission?.status === 'completed' ||
    mission?.status === 'completed_with_errors';
  const liveCallInProgress = (mission?.targets || []).some(
    (t) =>
      t.live ||
      (t.callId &&
        !['ended', 'completed', 'failed', 'busy', 'no-answer'].includes(String(t.status)))
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
      (done &&
        mission.targets.some(
          (t) =>
            t.callId &&
            !['ended', 'completed', 'failed', 'busy', 'no-answer'].includes(t.status)
        )));
  const showRetry =
    Boolean(mission?.canRetry) &&
    !isPreview &&
    !liveCallInProgress &&
    !dialingNow &&
    !executing &&
    !hangingUp;

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
    // Faster while live so the chat grid updates during the call
    const ms = liveCallInProgress || dialingNow ? 1200 : 4000;
    const timer = setInterval(refresh, ms);
    return () => clearInterval(timer);
  }, [id, mission?.status, pending, retrying, hangingUp, liveCallInProgress, dialingNow, isPreview]);

  async function startCalls() {
    if (!id) return;
    setExecuting(true);
    setError('');
    try {
      const data = await executeMission(id);
      setMission(data);
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
      const data = await retryMission(id);
      setMission(data);
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
      const data = await hangupMission(id);
      setMission(data);
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
    return Boolean(
      t.live ||
        (t.callId &&
          !['ended', 'completed', 'failed', 'busy', 'no-answer'].includes(String(t.status)))
    );
  }

  const callableTargets = (mission?.targets || []).filter((t) => t.phone);

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref={isPreview ? '/home' : '/history'} />
          </IonButtons>
          <IonTitle>{isPreview ? 'Plan preview' : 'Mission'}</IonTitle>
          <IonButtons slot="end">
            <IonButton routerLink="/history">History</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <div className="page-wrap mission-page">
          {loading && <IonSpinner name="crescent" />}
          {error && <p className="error-text">{error}</p>}

          {mission && (
            <>
              <h1 className="brand">{mission.plan.title}</h1>
              <p className="lede">{mission.plan.goal}</p>
              <span className={`status-pill ${failed ? 'failed' : ''}`}>
                {isPreview ? 'preview — no calls placed yet' : mission.status}
              </span>

              {isPreview && (
                <div className="meta-block highlight" style={{ marginTop: '1rem' }}>
                  <h3>What will happen</h3>
                  {(mission.plan.processSteps || []).map((s) => (
                    <div key={s.step} className="process-step">
                      <span className="process-num">{s.step}</span>
                      <div>
                        <p>
                          <strong>{s.title}</strong>
                        </p>
                        <p>{s.detail}</p>
                      </div>
                    </div>
                  ))}
                  {!mission.plan.processSteps?.length && (
                    <p>We'll call the businesses below on your behalf and report back.</p>
                  )}
                </div>
              )}

              <div className="meta-block">
                <h3>Your request</h3>
                <p>{mission.originalRequest || mission.request}</p>
              </div>

              {mission.clarifications && mission.clarifications.length > 0 && (
                <div className="meta-block">
                  <h3>Details you provided</h3>
                  {mission.clarifications.map((c, idx) => (
                    <p key={`${c.id || idx}-${c.question}`}>
                      <strong>{c.question}</strong>
                      <br />
                      {c.answer}
                    </p>
                  ))}
                </div>
              )}

              {mission.plan.spokenBrief && (
                <div className="meta-block">
                  <h3>How we'll talk on the call</h3>
                  <p className="clarify-why" style={{ marginBottom: '0.5rem' }}>
                    One thing at a time — wait for their reply before the next.
                  </p>
                  {mission.plan.calleeIdentity?.nameAsGiven && (
                    <p className="clarify-why" style={{ marginBottom: '0.5rem' }}>
                      Calling {mission.plan.calleeIdentity.nameAsGiven}
                      {mission.plan.calleeIdentity.relation
                        ? ` (${mission.plan.calleeIdentity.relation})`
                        : ''}
                      {mission.plan.calleeIdentity.pronouns
                        ? ` · pronouns ${mission.plan.calleeIdentity.pronouns}`
                        : ''}
                    </p>
                  )}
                  <p style={{ whiteSpace: 'pre-wrap' }}>{mission.plan.spokenBrief}</p>
                  {mission.plan.callObjective && (
                    <p className="clarify-why" style={{ marginTop: '0.5rem' }}>
                      Goal: {mission.plan.callObjective}
                    </p>
                  )}
                </div>
              )}

              {mission.attachments && mission.attachments.length > 0 && (
                <div className="meta-block">
                  <h3>Attached files</h3>
                  {mission.attachments.map((a) => (
                    <div key={a.id} className="target-row">
                      <p>
                        <strong>{a.filename}</strong> · {a.status}
                        {a.hasContent ? ' · details extracted' : ''}
                      </p>
                      {a.preview && <pre>{a.preview}{a.preview.length >= 400 ? '…' : ''}</pre>}
                      {a.error && <p className="error-text">{a.error}</p>}
                    </div>
                  ))}
                </div>
              )}

              {mission.plan.requirements && mission.plan.requirements.length > 0 && (
                <div className="meta-block">
                  <h3>Requirements</h3>
                  {mission.plan.requirements.map((r) => (
                    <p key={r}>• {r}</p>
                  ))}
                </div>
              )}

              <div className="meta-block">
                <h3>{isPreview ? `Will call (${callableTargets.length})` : 'Calls'}</h3>
                {callableTargets.length === 0 && (
                  <p className="error-text">No phone numbers found. Update your area in Settings or name a specific business.</p>
                )}
                {mission.targets.map((t) => (
                  <div key={t.id} className="target-row">
                    <p>
                      <strong>{t.name}</strong>
                      {!isPreview && <> · {targetStatusLabel(t)}</>}
                    </p>
                    <p>{t.phone || 'No phone found'}</p>
                    {t.address && <p>{t.address}</p>}
                    {t.reason && isPreview && <p className="clarify-why">{t.reason}</p>}
                    {t.source && isPreview && (
                      <p className="clarify-why">Source: {t.source.replace(/_/g, ' ')}</p>
                    )}
                    {t.error != null && !t.transcript && !isTargetLive(t) && (
                      <p className="error-text">
                        {typeof t.error === 'string' ? t.error : JSON.stringify(t.error)}
                      </p>
                    )}
                    {(t.transcript || isTargetLive(t)) && (
                      <>
                        <p style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                          <strong>{isTargetLive(t) ? 'Live conversation' : 'Transcript'}</strong>
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
              </div>

              {mission.recommendation && !isPreview && (
                <div className="meta-block highlight">
                  <h3>{done ? 'Outcome' : 'Best outcome'}</h3>
                  <p>{mission.recommendation.summary}</p>
                  {mission.recommendation.bestOffer?.headline && (
                    <>
                      {mission.recommendation.bestOffer.targetName && (
                        <p style={{ marginTop: '0.75rem' }}>
                          <strong>{mission.recommendation.bestOffer.targetName}</strong>
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
                      <ul style={{ marginTop: '0.5rem', paddingLeft: '1.2rem' }}>
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
                </div>
              )}

              {(pending || retrying || dialingNow || hangingUp) && (
                <p className="lede" style={{ marginTop: '1rem' }}>
                  {hangingUp
                    ? 'Hanging up…'
                    : retrying || mission.status === 'starting' || dialingNow
                      ? 'Starting calls…'
                      : liveCallInProgress
                        ? 'Call in progress — live chat updates below.'
                        : 'Waiting for call to finish…'}{' '}
                  this page refreshes automatically.
                </p>
              )}

              <div className="actions">
                {isPreview ? (
                  <>
                    <IonButton fill="outline" onClick={() => navigate('/home')}>
                      Edit request
                    </IonButton>
                    <IonButton disabled={executing || callableTargets.length === 0} onClick={startCalls}>
                      {executing ? <IonSpinner name="crescent" /> : 'Start calls'}
                    </IonButton>
                  </>
                ) : (
                  <>
                    <IonButton fill="outline" onClick={refresh}>
                      Refresh
                    </IonButton>
                    {canHangUp && (
                      <IonButton
                        className="hangup-btn"
                        color="danger"
                        disabled={hangingUp}
                        onClick={hangUpCalls}
                      >
                        {hangingUp ? <IonSpinner name="crescent" /> : 'Hang up'}
                      </IonButton>
                    )}
                    {showRetry && (
                      <IonButton disabled={retrying} onClick={retryCalls}>
                        {retrying ? <IonSpinner name="crescent" /> : 'Retry call'}
                      </IonButton>
                    )}
                    <IonButton
                      fill={showRetry || canHangUp ? 'outline' : 'solid'}
                      onClick={() => navigate('/home')}
                    >
                      New request
                    </IonButton>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </IonContent>
    </IonPage>
  );
}
