import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  askChat,
  clarifyRequest,
  createMission,
  getChatHistory,
  saveChatHistoryRemote,
  type ChatMessage,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '../api';
import { loadContacts } from '../contacts';
import { loadProfile, profileIsReady } from '../profile';
import {
  AutoTextarea,
  Button,
  Card,
  Content,
  ErrorText,
  Hero,
  IconButton,
  IconClock,
  IconMoon,
  IconPaperclip,
  IconSettings,
  IconSun,
  IconUsers,
  IconX,
  Page,
  TopBar,
  useTheme,
} from '../ui';

const CHAT_KEY = 'assistant-chat-history';

const EXAMPLES = [
  "What's the current time in Hyderabad, India?",
  "Call Mom and say I'll be 20 minutes late for dinner.",
  "Place a pickup order at Joe's Pizza for 2 pepperoni slices and a coke.",
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
  const { theme, toggle } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const threadEnd = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [chat.length]);

  useEffect(() => {
    const profile = loadProfile();
    setReady(profileIsReady(profile));
    setProfileName(profile.name);
    if (profile.phone) {
      getChatHistory(profile.phone)
        .then((server) => {
          if (server.length) {
            setChat(server.slice(-40));
          }
        })
        .catch(() => {
          /* keep local copy */
        });
    }
  }, []);

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
      .map((q) => ({ id: q.id, question: q.question, answer: (answers[q.id] || '').trim() }))
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
        ? `${request.trim()} Additional details: ${clarifications
            .map((a) => `${a.question} ${a.answer}`)
            .join(' ')}`
        : request.trim());

    const line = request.trim();
    const thread = [...chat, { role: 'user' as const, content: line }].slice(-40);
    setChat(thread);
    if (profile.phone) saveChatHistoryRemote(profile.phone, thread).catch(() => {});

    const mission = await createMission({
      request: brief,
      originalRequest: line,
      profile,
      contacts: loadContacts(),
      clarifications,
      history: chat.slice(-20),
      dryRun,
      files,
    });
    navigate(`/missions/${mission.id}`);
  }

  async function sendChat(text: string, profile = loadProfile()) {
    const history = chat.slice(-20);
    setChat((prev) => [...prev, { role: 'user', content: text }]);
    setRequest('');
    resetClarification();
    try {
      const result = await askChat(text, history, profile);
      const next: ChatMessage[] = [
        ...history,
        { role: 'user' as const, content: text },
        { role: 'assistant' as const, content: result.answer },
      ].slice(-40);
      setChat(next);
      if (profile.phone) saveChatHistoryRemote(profile.phone, next).catch(() => {});
    } catch (e: any) {
      setChat((prev) => [
        ...prev,
        { role: 'assistant', content: e.message || 'I could not answer that just now.' },
      ]);
    }
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

      if (skipQuestions) {
        await startMission(dryRun, clarifications);
        return;
      }

      const clarification = await clarifyRequest({
        request: request.trim(),
        profile,
        contacts: loadContacts(),
        answers: clarifications,
        history: chat.slice(-20),
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
      const msg = e?.data?.error || e.message || 'Could not start mission';
      setError(typeof msg === 'string' ? msg : 'Could not start mission');
    } finally {
      setBusy(false);
    }
  }

  const primaryLabel = questions.length
    ? 'Call now'
    : looksLikePhoneMission(request)
      ? 'Make the calls'
      : 'Ask';

  return (
    <Page>
      <TopBar
        title="Assistant"
        right={
          <>
            <IconButton label="Toggle theme" onClick={toggle}>
              {theme === 'dark' ? <IconSun /> : <IconMoon />}
            </IconButton>
            <IconButton label="History" to="/history">
              <IconClock />
            </IconButton>
            <IconButton label="Contacts" to="/contacts">
              <IconUsers />
            </IconButton>
            <IconButton label="Settings" to="/settings">
              <IconSettings />
            </IconButton>
          </>
        }
      />
      <Content>
        <Hero badge="Personal Assistant" title="What do you need?">
          {ready
            ? `Hi ${profileName || 'there'} — ask a question or tell me who to call. I only dial when you want a phone call.`
            : 'Set up your profile once (name, phone, area), then ask questions or place calls.'}
        </Hero>

        {chat.length > 0 && (
          <Card>
            <h3>Conversation</h3>
            <div className="thread">
              {chat.map((m, idx) => (
                <div key={`${m.role}-${idx}`} className={`turn ${m.role === 'user' ? 'turn-you' : 'turn-them'}`}>
                  <span className="turn-label">{m.role === 'user' ? 'You' : 'Assistant'}</span>
                  <div className="bubble">{m.content}</div>
                </div>
              ))}
              <div ref={threadEnd} />
            </div>
            <div className="actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setChat([]);
                  const profile = loadProfile();
                  if (profile.phone) saveChatHistoryRemote(profile.phone, []).catch(() => {});
                }}
              >
                Clear chat
              </Button>
            </div>
          </Card>
        )}

        {!ready && (
          <Card highlight>
            <h3>Profile needed</h3>
            <p>Save your name and phone so calls can confirm who you are.</p>
            <div className="actions">
              <Button to="/settings">Open settings</Button>
            </div>
          </Card>
        )}

        <div className="composer">
          <AutoTextarea
            value={request}
            placeholder="Ask anything, or say who to call — e.g. What's the time in Hyderabad?"
            minRows={3}
            onSubmit={() => !busy && ready && request.trim() && run(false)}
            onChange={(v) => {
              setRequest(v);
              resetClarification();
            }}
          />

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => onPickFiles(e.target.files)}
          />

          <div className="composer-actions">
            <IconButton
              label="Add files"
              onClick={() => !busy && files.length < 5 && fileInputRef.current?.click()}
            >
              <IconPaperclip />
            </IconButton>
            <span className="composer-spacer" />
            <Button
              variant="outline"
              size="sm"
              disabled={!ready || busy || !request.trim()}
              onClick={() => run(true, askedOnce)}
            >
              Preview plan
            </Button>
            <Button size="sm" disabled={!ready || !request.trim()} loading={busy} onClick={() => run(false)}>
              {primaryLabel}
            </Button>
          </div>

          {files.length > 0 && (
            <div>
              {files.map((file, index) => (
                <div key={`${file.name}-${file.size}-${index}`} className="file-chip">
                  <span>
                    {file.name} <em>({(file.size / 1024).toFixed(0)} KB)</em>
                  </span>
                  <button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeFile(index)}>
                    <IconX size={16} />
                  </button>
                </div>
              ))}
              <p className="note">Up to 5 files · txt, csv, json, md, pdf, or images</p>
            </div>
          )}
        </div>

        {questions.length > 0 && (
          <Card highlight>
            <h3>A few quick questions</h3>
            <p className="clarify-why">
              Type your answers so we can place the call correctly. Skip anything you'd rather have asked on the
              phone.
            </p>
            {questions.map((q) => (
              <div key={q.id} className="clarify">
                <p className="clarify-q">{q.question}</p>
                {q.why && <p className="clarify-why">{q.why}</p>}
                <AutoTextarea
                  minRows={2}
                  value={answers[q.id] || ''}
                  placeholder="Type your answer…"
                  onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
                />
                {q.suggestions && q.suggestions.length > 0 && (
                  <div className="chip-row">
                    {q.suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="chip chip-sm"
                        onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: s }))}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div className="actions">
              <Button variant="outline" disabled={busy} onClick={() => run(false, true)}>
                Skip — just call
              </Button>
            </div>
          </Card>
        )}

        {finalBrief && questions.length === 0 && summaryBullets.length > 0 && (
          <Card>
            <h3>Ready to call</h3>
            {summaryBullets.map((b) => (
              <p key={b}>• {b}</p>
            ))}
          </Card>
        )}

        {chat.length === 0 && (
          <div className="chip-grid">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="chip"
                onClick={() => {
                  setRequest(ex);
                  resetClarification();
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        )}

        {error && <ErrorText>{error}</ErrorText>}
      </Content>
    </Page>
  );
}
