import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { listMissions, type MissionRecord } from './api';
import { showNotification } from './notifications';

const ACTIVE_STATUSES = new Set(['planning', 'starting', 'calling', 'in_progress']);
const DONE_STATUSES = new Set(['completed', 'completed_with_errors', 'failed']);

const FAST_MS = 5000;
const IDLE_MS = 30000;

function isActive(m: MissionRecord) {
  return ACTIVE_STATUSES.has(m.status) || (m.targets || []).some((t) => t.live);
}

/** One line per turn, so the notification shows how the call actually went. */
function conversationSummary(mission: MissionRecord) {
  const summary = mission.recommendation?.bestOffer?.headline || mission.recommendation?.summary;
  if (summary) return summary;

  const spoken = (mission.targets || []).find((t) => t.transcript);
  if (spoken?.transcript) {
    const lines = spoken.transcript
      .split('\n')
      .map((l) => l.replace(/^(AI|User):\s*/i, '').trim())
      .filter(Boolean);
    const tail = lines.slice(-2).join(' — ');
    if (tail) return tail;
  }

  const outcome = (mission.targets || []).map((t) => t.outcome).find(Boolean);
  return outcome || 'The call finished.';
}

function notificationTitle(mission: MissionRecord) {
  const who = (mission.targets || []).map((t) => t.name).filter(Boolean)[0];
  if (mission.status === 'failed') return who ? `Call to ${who} failed` : 'Call failed';
  return who ? `Call with ${who} finished` : 'Call finished';
}

/**
 * Watches missions app-wide (not just on the mission page) and raises a browser
 * notification the moment a call wraps up.
 */
export function useMissionWatcher() {
  const navigate = useNavigate();
  const seen = useRef<Map<string, string>>(new Map());
  const primed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      let nextDelay = IDLE_MS;
      try {
        const list = await listMissions();
        if (cancelled) return;

        let anyActive = false;

        for (const mission of list) {
          const prev = seen.current.get(mission.id);
          seen.current.set(mission.id, mission.status);
          if (isActive(mission)) anyActive = true;

          if (!primed.current) continue;
          if (!prev || prev === mission.status) continue;
          if (!DONE_STATUSES.has(mission.status)) continue;
          if (DONE_STATUSES.has(prev)) continue;

          showNotification(notificationTitle(mission), conversationSummary(mission), {
            tag: `mission-${mission.id}`,
            onClick: () => navigate(`/missions/${mission.id}`),
          });
        }

        primed.current = true;
        nextDelay = anyActive ? FAST_MS : IDLE_MS;
      } catch {
        nextDelay = IDLE_MS;
      } finally {
        if (!cancelled) timer.current = setTimeout(tick, nextDelay);
      }
    }

    tick();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [navigate]);
}
