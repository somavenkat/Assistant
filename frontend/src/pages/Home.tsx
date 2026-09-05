import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonPage,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
  useIonViewWillEnter,
} from '@ionic/react';
import { attachOutline, closeCircleOutline, peopleOutline, settingsOutline, timeOutline } from 'ionicons/icons';
import { askChat, clarifyRequest, createMission, type ChatMessage, type ClarifyAnswer, type ClarifyQuestion } from '../api';
import { loadContacts } from '../contacts';
import { loadProfile, profileIsReady } from '../profile';

const CHAT_KEY = 'assistant-chat-history';

const EXAMPLES = [
  'What\'s the current time in Hyderabad, India?',
  'Call Mom and say I\'ll be 20 minutes late for dinner.',
  'Place a pickup order at Joe\'s Pizza for 2 pepperoni slices and a coke.',
];

function looksLikePhoneMission(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (/\b(call|dial|phone|ring)\b/i.test(t)) return true;
  if (/\+?\d[\d\s().-]{8,}\d/.test(t)) return true;
  if (/\b(pickup|pick[\s-]*up|takeout|place\s+(an?\s+)?order)\b/i.test(t)) return true;
  if (/\b(tell|ask|say|inform|text)\s+(?!me\b)(?!you\b)/i.test(t)) return true;
  if (/\blet\s+\w+\s+know\b/i.test(t)) return true;
  return false;
}

function loadChatHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(-40) : [];
  } catch {
    return [];
  }
}

const ACCEPT =
  '.txt,.md,.csv,.json,.pdf,.png,.jpg,.jpeg,.webp,.gif,text/plain,text/csv,application/json,application/pdf,image/*';

export default function Home() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [request, setRequest] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [profileName, setProfileName] = useState('');

  const [questions, setQuestions] = useState<ClarifyQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [priorAnswers, setPriorAnswers] = useState<ClarifyAnswer[]>([]);
  const [finalBrief, setFinalBrief] = useState('');
  const [summaryBullets, setSummaryBullets] = useState<string[]>([]);
  const [askedOnce, setAskedOnce] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>(() => loadChatHistory());

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(chat.slice(-40)));
    } catch {
      /* ignore quota */
    }
  }, [chat]);

  useIonViewWillEnter(() => {
    const profile = loadProfile();
    setReady(profileIsReady(profile));
    setProfileName(profile.name);
  });

  function resetClarification() {
    setQuestions([]);
    setAnswers({});
    setPriorAnswers([]);
    setFinalBrief('');
    setSummaryBullets([]);
    setAskedOnce(false);
  }

  function onPickFiles(list: FileList | null) {
    if (!list?.length) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      if (next.length >= 5) break;
      if (next.some((f) => f.name === file.name && f.size === file.size)) continue;
      next.push(file);
    }
    setFiles(next);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function currentAnswers(): ClarifyAnswer[] {
    return questions
      .map((q) => ({
        id: q.id,
        question: q.question,
        answer: (answers[q.id] || '').trim(),
      }))
      .filter((a) => a.answer);
  }

  function allAnswers(): ClarifyAnswer[] {
    return [...priorAnswers, ...currentAnswers()];
  }

  async function startMission(dryRun: boolean, clarifications: ClarifyAnswer[]) {
    const profile = loadProfile();
    const brief =
      finalBrief ||
      (clarifications.length
        ? `${request.trim()} Additional details: ${clarifications.map((a) => `${a.question} ${a.answer}`).join(' ')}`
        : request.trim());

    const mission = await createMission({
      request: brief,
      originalRequest: request.trim(),
      profile,
      contacts: loadContacts(),
      clarifications,
      dryRun,
      files,
    });
    navigate(`/missions/${mission.id}`);
  }

  async function run(dryRun = false, skipQuestions = false) {
    setError('');
    const profile = loadProfile();
    if (!profileIsReady(profile)) {
      setError('Save your name and phone in Settings first.');
      return;
    }
    if (!request.trim()) {
      setError('Tell me what you want done.');
      return;
    }

    setBusy(true);
    try {
      if (!skipQuestions && !looksLikePhoneMission(request)) {
        await sendChat(request.trim(), profile);
        return;
      }

      const clarifications = allAnswers();

      // Explicit skip only — do not auto-dial just because questions were already shown.
      if (skipQuestions) {
        await startMission(dryRun, clarifications);
        return;
      }

      const clarification = await clarifyRequest({
        request: request.trim(),
        profile,
        contacts: loadContacts(),
        answers: clarifications,
        files,
      });

      if (clarification.informational) {
        await sendChat(request.trim(), profile);
        return;
      }

      if (!clarification.ready && clarification.questions.length > 0) {
        setPriorAnswers(clarifications);
        setQuestions(clarification.questions);
        setAskedOnce(true);
        setFinalBrief('');
        setSummaryBullets([]);
        if (askedOnce && clarifications.length === 0) {
          setError('Please type what you want to order (or tap Skip — just call).');
        }
        return;
      }

      const brief = clarification.finalBrief || request.trim();
      setFinalBrief(brief);
      setSummaryBullets(clarification.summaryBullets || []);
      setQuestions([]);

      await startMission(dryRun, clarifications);
    } catch (e: any) {
      const extraQuestions = e?.data?.questions;
      if (e?.status === 422 && Array.isArray(extraQuestions) && extraQuestions.length) {
        setQuestions(extraQuestions);
        setAskedOnce(true);
        setError('Please answer these before we dial (or tap Skip — just call).');
        return;
      }
      const msg =
        e?.data?.error ||
        (typeof e?.data?.error === 'object' ? JSON.stringify(e.data.error) : null) ||
        e.message ||
        'Could not start mission';
      setError(typeof msg === 'string' ? msg : 'Could not start mission');
    } finally {
      setBusy(false);
    }
  }

  async function sendChat(text: string, profile = loadProfile()) {
    const history = chat.slice(-20);
    setChat((prev) => [...prev, { role: 'user', content: text }]);
    setRequest('');
    resetClarification();
    try {
      const result = await askChat(text, history, profile);
      setChat((prev) => [...prev, { role: 'assistant', content: result.answer }]);
    } catch (e: any) {
      setChat((prev) => [
        ...prev,
        { role: 'assistant', content: e.message || 'I could not answer that just now.' },
      ]);
    }
  }

  function setSuggestion(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonTitle>Concierge</IonTitle>
          <IonButtons slot="end">
            <IonButton routerLink="/history">
              <IonIcon slot="icon-only" icon={timeOutline} />
            </IonButton>
            <IonButton routerLink="/contacts">
              <IonIcon slot="icon-only" icon={peopleOutline} />
            </IonButton>
            <IonButton routerLink="/settings">
              <IonIcon slot="icon-only" icon={settingsOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <div className="page-wrap">
          <h1 className="brand">What do you need?</h1>
          <p className="lede">
            {ready
              ? `Hi ${profileName || 'there'} — ask a question or tell me who to call. I'll remember this chat and only dial when you want a phone call.`
              : 'Set up your profile once (name, phone, area), then ask questions or place calls.'}
          </p>

          {chat.length > 0 && (
            <div className="meta-block chat-thread">
              <h3>Conversation</h3>
              {chat.map((m, idx) => (
                <div key={`${m.role}-${idx}`} className={`chat-turn ${m.role === 'user' ? 'chat-user' : 'chat-assistant'}`}>
                  <span className="turn-label">{m.role === 'user' ? 'You' : 'Assistant'}</span>
                  <div className="turn-bubble">{m.content}</div>
                </div>
              ))}
              <div className="actions" style={{ marginTop: '0.5rem' }}>
                <IonButton fill="clear" size="small" onClick={() => setChat([])}>
                  Clear chat
                </IonButton>
              </div>
            </div>
          )}

          {!ready && (
            <div className="meta-block">
              <h3>Profile needed</h3>
              <p>Save your name and phone so calls can confirm who you are.</p>
              <div className="actions">
                <IonButton routerLink="/settings">Open settings</IonButton>
              </div>
            </div>
          )}

          <div className="panel">
            <div style={{ padding: '0.75rem 0.25rem 0' }}>
              <IonTextarea
                autoGrow
                rows={6}
                value={request}
                placeholder="Ask anything, or say who to call — e.g. What’s the time in Hyderabad?"
                onIonInput={(e) => {
                  setRequest(String(e.detail.value || ''));
                  resetClarification();
                }}
              />
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT}
              hidden
              onChange={(e) => onPickFiles(e.target.files)}
            />

            <div className="actions">
              <IonButton
                fill="outline"
                disabled={busy || files.length >= 5}
                onClick={() => fileInputRef.current?.click()}
              >
                <IonIcon slot="start" icon={attachOutline} />
                Add files
              </IonButton>
              <IonButton fill="outline" disabled={!ready || busy || !request.trim()} onClick={() => run(true, askedOnce)}>
                Preview plan
              </IonButton>
              <IonButton disabled={!ready || busy || !request.trim()} onClick={() => run(false)}>
                {busy ? (
                  <IonSpinner name="crescent" />
                ) : questions.length ? (
                  'Call now'
                ) : looksLikePhoneMission(request) ? (
                  'Make the calls'
                ) : (
                  'Ask'
                )}
              </IonButton>
            </div>

            {files.length > 0 && (
              <div className="file-list">
                {files.map((file, index) => (
                  <div key={`${file.name}-${file.size}-${index}`} className="file-chip">
                    <span>
                      {file.name}{' '}
                      <em>({(file.size / 1024).toFixed(0)} KB)</em>
                    </span>
                    <button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeFile(index)}>
                      <IonIcon icon={closeCircleOutline} />
                    </button>
                  </div>
                ))}
                <p className="file-hint">Up to 5 files · txt, csv, json, md, pdf, or images</p>
              </div>
            )}
          </div>

          {questions.length > 0 && (
            <div className="meta-block highlight">
              <h3>A few quick questions</h3>
              <p className="lede" style={{ marginBottom: '0.75rem' }}>
                Type your answers below so we can place the call correctly. Skip anything you want asked on the phone instead.
              </p>
              {questions.map((q) => (
                <div key={q.id} className="clarify-block">
                  <p>
                    <strong>{q.question}</strong>
                  </p>
                  {q.why && <p className="clarify-why">{q.why}</p>}
                  <div className="clarify-input-wrap">
                    <IonTextarea
                      className="clarify-input"
                      autoGrow
                      rows={2}
                      value={answers[q.id] || ''}
                      placeholder="Tap here and type your answer…"
                      onIonInput={(e) =>
                        setAnswers((prev) => ({ ...prev, [q.id]: String(e.detail.value || '') }))
                      }
                    />
                  </div>
                  {q.suggestions && q.suggestions.length > 0 && (
                    <div className="suggestion-row">
                      {q.suggestions.map((s) => (
                        <button key={s} type="button" className="example-chip" onClick={() => setSuggestion(q.id, s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <div className="actions" style={{ marginTop: '0.75rem' }}>
                <IonButton fill="outline" disabled={busy} onClick={() => run(false, true)}>
                  Skip — just call
                </IonButton>
              </div>
            </div>
          )}

          {finalBrief && questions.length === 0 && summaryBullets.length > 0 && (
            <div className="meta-block">
              <h3>Ready to call</h3>
              {summaryBullets.map((b) => (
                <p key={b}>• {b}</p>
              ))}
            </div>
          )}

          <div className="example-row">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="example-chip"
                onClick={() => {
                  setRequest(ex);
                  resetClarification();
                }}
              >
                {ex}
              </button>
            ))}
          </div>

          {error && <p className="error-text">{error}</p>}
        </div>
      </IonContent>
    </IonPage>
  );
}
