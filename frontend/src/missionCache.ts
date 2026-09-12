import type { MissionRecord } from './api';

const KEY = 'apa.mission-history.v1';
const MAX = 200;

export function loadCachedMissions(): MissionRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveCachedMissions(list: MissionRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* ignore quota */
  }
}

export function upsertCachedMission(mission: MissionRecord) {
  if (!mission?.id) return;
  const prev = loadCachedMissions().filter((m) => m.id !== mission.id);
  saveCachedMissions([mission, ...prev]);
}

const OPEN_STATUSES = new Set(['planning', 'starting', 'calling', 'in_progress']);
const STALE_OPEN_MS = 10 * 60 * 1000;

/**
 * A cached mission the server no longer knows about cannot still be running. Without this
 * these rows sat on "In progress" forever: nothing on the server could ever refresh them,
 * because the server has no record to refresh.
 */
function settleOrphan(mission: MissionRecord): MissionRecord {
  if (!OPEN_STATUSES.has(String(mission.status))) return mission;
  const age = Date.now() - Date.parse(mission.updatedAt || mission.createdAt || '');
  if (!Number.isFinite(age) || age < STALE_OPEN_MS) return mission;
  return {
    ...mission,
    status: 'failed',
    error: mission.error || 'Call result unavailable — this mission is no longer on the server.',
  };
}

/** Server list wins on id conflicts; cached items fill gaps when server is empty or missing rows. */
export function mergeMissionLists(server: MissionRecord[], cached: MissionRecord[]): MissionRecord[] {
  const serverIds = new Set(server.map((m) => m?.id).filter(Boolean));
  const map = new Map<string, MissionRecord>();
  for (const m of cached) {
    if (m?.id && !serverIds.has(m.id)) map.set(m.id, settleOrphan(m));
  }
  for (const m of server) {
    if (m?.id) map.set(m.id, m);
  }
  return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
