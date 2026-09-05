const API_BASE = import.meta.env.VITE_API_URL || '/api';

export type MissionTarget = {
  id: string;
  plannedName: string;
  name: string;
  phone: string;
  address?: string;
  website?: string;
  reason?: string;
  status: string;
  callId?: string | null;
  transcript?: string;
  endedReason?: string;
  error?: unknown;
  outcome?: string;
  canRetry?: boolean;
  live?: boolean;
  source?: string;
  confidence?: string;
};

export type MissionAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  status: string;
  error?: string | null;
  preview?: string;
  hasContent?: boolean;
};

export type MissionRecord = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  request: string;
  originalRequest?: string;
  clarifications?: ClarifyAnswer[];
  profile: {
    name: string;
    phone: string;
    area?: string;
    latitude?: number | null;
    longitude?: number | null;
  };
  plan: {
    title: string;
    category: string;
    goal: string;
    requirements?: string[];
    compareOffers?: boolean;
    spokenBrief?: string;
    callObjective?: string;
    discoveryQuery?: string;
    firstMessageTemplate?: string;
    processSteps?: Array<{ step: number; title: string; detail: string }>;
    calleeIdentity?: {
      nameAsGiven?: string;
      relation?: string | null;
      pronouns?: string;
      subject?: string;
      object?: string;
      possessive?: string;
      locked?: boolean;
      rule?: string;
    };
  };
  targets: MissionTarget[];
  attachments?: MissionAttachment[];
  recommendation?: {
    summary?: string;
    bestOffer?: {
      targetName?: string;
      headline?: string;
      details?: string;
      nextStep?: string;
    };
    alternatives?: Array<{ targetName?: string; headline?: string; details?: string }>;
    unresolved?: string[];
  } | null;
  error?: unknown;
  canRetry?: boolean;
};

export type ClarifyQuestion = {
  id: string;
  question: string;
  why?: string;
  suggestions?: string[];
};

export type ClarifyAnswer = {
  id?: string | null;
  question: string;
  answer: string;
};

export type ClarifyResult = {
  ready: boolean;
  informational?: boolean;
  questions: ClarifyQuestion[];
  finalBrief?: string;
  summaryBullets?: string[];
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ChatResult = {
  answer: string;
  mode?: string;
};

async function postApi(path: string, payload: Record<string, unknown>, files?: File[]) {
  if (files && files.length > 0) {
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) {
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    for (const file of files) form.append('files', file);
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) {
      throw Object.assign(new Error(data.error || 'Request failed'), { data, status: res.status });
    }
    return data;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(data.error || 'Request failed'), { data, status: res.status });
  }
  return data;
}

export async function clarifyRequest(payload: {
  request: string;
  profile: {
    name: string;
    phone: string;
    area?: string;
    latitude?: number | null;
    longitude?: number | null;
  };
  contacts?: Array<{ id?: string; name: string; phone: string; notes?: string }>;
  answers?: ClarifyAnswer[];
  files?: File[];
}): Promise<ClarifyResult> {
  return postApi('/clarify', {
    request: payload.request,
    profile: payload.profile,
    contacts: payload.contacts || [],
    answers: payload.answers || [],
  }, payload.files);
}

export async function createMission(payload: {
  request: string;
  originalRequest?: string;
  profile: {
    name: string;
    phone: string;
    area?: string;
    latitude?: number | null;
    longitude?: number | null;
  };
  contacts?: Array<{ id?: string; name: string; phone: string; notes?: string }>;
  clarifications?: ClarifyAnswer[];
  dryRun?: boolean;
  files?: File[];
}): Promise<MissionRecord> {
  return postApi('/missions', {
    request: payload.request,
    originalRequest: payload.originalRequest,
    profile: payload.profile,
    contacts: payload.contacts || [],
    clarifications: payload.clarifications || [],
    dryRun: payload.dryRun || false,
  }, payload.files);
}

export async function getMission(id: string): Promise<MissionRecord> {
  const res = await fetch(`${API_BASE}/missions/${id}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Mission not found');
  return data;
}

export async function listMissions(includePreviews = false): Promise<MissionRecord[]> {
  const qs = includePreviews ? '?includePreviews=true' : '';
  const res = await fetch(`${API_BASE}/missions${qs}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not load history');
  return Array.isArray(data) ? data : [];
}

export async function deleteMission(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/missions/${id}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Delete failed');
}

export async function executeMission(id: string): Promise<MissionRecord> {
  const res = await fetch(`${API_BASE}/missions/${id}/execute`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not start calls');
  return data;
}

export async function refreshMission(id: string): Promise<MissionRecord> {
  const res = await fetch(`${API_BASE}/missions/${id}/refresh`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Refresh failed');
  return data;
}

export async function retryMission(id: string, targetIds?: string[]): Promise<MissionRecord> {
  const res = await fetch(`${API_BASE}/missions/${id}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(targetIds?.length ? { targetIds } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not retry call');
  return data;
}

export async function askChat(
  message: string,
  history: ChatMessage[] = [],
  profile?: MissionRecord['profile']
): Promise<ChatResult> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history, profile }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not answer');
  return data;
}

export async function hangupMission(id: string, targetIds?: string[]): Promise<MissionRecord> {
  const res = await fetch(`${API_BASE}/missions/${id}/hangup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(targetIds?.length ? { targetIds } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.mission?.error || 'Could not hang up');
  return data.mission || data;
}
