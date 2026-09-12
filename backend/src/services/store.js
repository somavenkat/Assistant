const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * Mission + chat storage.
 *
 * Vercel runs several function instances and gives each its own /tmp, so a mission written
 * by one instance is invisible to the next — that is what produced "Mission not found"
 * moments after creating a call. When Upstash Redis credentials exist we use them as the
 * single shared source of truth; otherwise we fall back to local JSON files, which is
 * perfectly fine for `npm run dev` where there is only one process.
 */
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const usingRedis = Boolean(REDIS_URL && REDIS_TOKEN);

// Vercel Blob is the shared store when no Redis is configured. Slower than Redis but it
// needs no marketplace signup, and any instance can read what another one wrote.
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const usingBlob = !usingRedis && Boolean(BLOB_TOKEN);
const blobApi = usingBlob ? require('@vercel/blob') : null;
const BLOB_LIST_FETCH = 60;

// Missions are a rolling window, not an archive. Keys expire so trimmed ids cannot leak.
const MISSION_TTL_SECONDS = 60 * 60 * 24 * 90;
const MISSION_LIMIT = 200;
const CALL_INDEX_TTL_SECONDS = 60 * 60 * 24 * 7;

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'ai-personal-assistant')
  : path.resolve(__dirname, '../../data');
const STORE_PATH = path.join(DATA_DIR, 'missions.json');
const CHAT_STORE_PATH = path.join(DATA_DIR, 'chat-history.json');

if (!usingRedis && !usingBlob && process.env.VERCEL) {
  console.warn(
    '[store] No shared storage — missions will NOT survive across serverless instances. ' +
      'Set KV_REST_API_URL / KV_REST_API_TOKEN (Upstash) or BLOB_READ_WRITE_TOKEN (Vercel Blob).'
  );
}

const backend = usingRedis ? 'redis' : usingBlob ? 'blob' : 'file';
console.log(`[store] backend: ${backend}`);

function chatUserKey(phone = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits || 'anonymous';
}

/* ------------------------------------------------------------------ Redis */

async function redis(command) {
  const { data } = await axios.post(REDIS_URL, command, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    timeout: 8000,
  });
  return data?.result;
}

async function redisPipeline(commands) {
  if (!commands.length) return [];
  const { data } = await axios.post(`${REDIS_URL}/pipeline`, commands, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    timeout: 8000,
  });
  return Array.isArray(data) ? data.map((entry) => entry?.result) : [];
}

function parseMission(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- Blob backend */

/** Returns the parsed JSON at a blob path, or null when it does not exist. */
async function blobRead(pathname) {
  const res = await blobApi.get(pathname, { access: 'private', token: BLOB_TOKEN });
  if (!res || res.statusCode !== 200 || !res.stream) return null;
  const chunks = [];
  for await (const chunk of res.stream) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function blobWrite(pathname, value) {
  await blobApi.put(pathname, JSON.stringify(value), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    token: BLOB_TOKEN,
  });
}

async function blobDelete(pathname) {
  try {
    await blobApi.del(pathname, { token: BLOB_TOKEN });
  } catch (err) {
    if (err?.constructor?.name !== 'BlobNotFoundError') {
      console.warn('[store] blob delete failed:', err.message);
    }
  }
}

/* ------------------------------------------------------------- File backend */

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, '[]', 'utf8');
}

function ensureChatStore() {
  ensureStore();
  if (!fs.existsSync(CHAT_STORE_PATH)) fs.writeFileSync(CHAT_STORE_PATH, '{}', 'utf8');
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed ?? fallback;
  } catch (err) {
    console.warn(`[store] failed to read ${path.basename(file)}:`, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function fileLoadAll() {
  ensureStore();
  const list = readJson(STORE_PATH, []);
  return Array.isArray(list) ? list : [];
}

/* ----------------------------------------------------------------- Missions */

async function getMission(id) {
  if (!id) return null;
  if (usingRedis) return parseMission(await redis(['GET', `mission:${id}`]));
  if (usingBlob) return blobRead(`mission/${id}.json`);
  return fileLoadAll().find((m) => m.id === id) || null;
}

async function saveMission(mission) {
  if (!mission?.id) return;
  const copy = JSON.parse(JSON.stringify(mission));

  if (usingBlob) {
    await blobWrite(`mission/${mission.id}.json`, copy);
    // Lets the Vapi webhook resolve a mission from just the callId.
    await Promise.all(
      (copy.targets || [])
        .filter((t) => t?.callId)
        .map((t) => blobWrite(`call/${t.callId}.json`, { missionId: copy.id }))
    );
    return;
  }

  if (!usingRedis) {
    ensureStore();
    const list = fileLoadAll();
    const idx = list.findIndex((m) => m.id === mission.id);
    if (idx >= 0) list[idx] = copy;
    else list.unshift(copy);
    writeJson(STORE_PATH, list.slice(0, MISSION_LIMIT));
    return;
  }

  const score = Date.parse(mission.createdAt || '') || Date.now();
  const commands = [
    ['SET', `mission:${mission.id}`, JSON.stringify(copy), 'EX', String(MISSION_TTL_SECONDS)],
    ['ZADD', 'missions:index', String(score), mission.id],
    ['ZREMRANGEBYRANK', 'missions:index', '0', String(-(MISSION_LIMIT + 1))],
  ];
  // Lets the Vapi webhook find the mission by callId without scanning every key.
  for (const target of mission.targets || []) {
    if (target?.callId) {
      commands.push([
        'SET',
        `call:${target.callId}`,
        mission.id,
        'EX',
        String(CALL_INDEX_TTL_SECONDS),
      ]);
    }
  }
  await redisPipeline(commands);
}

async function listMissions(limit = MISSION_LIMIT) {
  if (usingBlob) {
    const { blobs } = await blobApi.list({ prefix: 'mission/', token: BLOB_TOKEN });
    // list() returns metadata only, so narrow by write time before fetching bodies.
    const recent = (blobs || [])
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
      .slice(0, Math.min(limit, BLOB_LIST_FETCH));
    const loaded = await Promise.all(recent.map((b) => blobRead(b.pathname).catch(() => null)));
    return loaded
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  if (!usingRedis) {
    return fileLoadAll()
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, limit);
  }

  const ids = await redis(['ZRANGE', 'missions:index', '0', String(limit - 1), 'REV']);
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = await redis(['MGET', ...ids.map((id) => `mission:${id}`)]);
  return (Array.isArray(rows) ? rows : []).map(parseMission).filter(Boolean);
}

async function removeMission(id) {
  if (!id) return;
  if (usingBlob) {
    await blobDelete(`mission/${id}.json`);
    return;
  }
  if (!usingRedis) {
    ensureStore();
    writeJson(STORE_PATH, fileLoadAll().filter((m) => m.id !== id));
    return;
  }
  await redisPipeline([
    ['DEL', `mission:${id}`],
    ['ZREM', 'missions:index', id],
  ]);
}

/** Vapi webhooks arrive with a callId; map it back to the owning mission. */
async function findMissionByCallId(callId, hintMissionId) {
  if (hintMissionId) {
    const hinted = await getMission(hintMissionId);
    if (hinted && (hinted.targets || []).some((t) => t.callId === callId || !callId)) {
      return hinted;
    }
  }
  if (!callId) return null;

  if (usingRedis) {
    const mappedId = await redis(['GET', `call:${callId}`]);
    if (mappedId) {
      const mission = await getMission(mappedId);
      if (mission) return mission;
    }
  }

  if (usingBlob) {
    const mapped = await blobRead(`call/${callId}.json`);
    if (mapped?.missionId) {
      const mission = await getMission(mapped.missionId);
      if (mission) return mission;
    }
  }

  const all = usingRedis || usingBlob ? await listMissions() : fileLoadAll();
  return all.find((m) => (m.targets || []).some((t) => t.callId === callId)) || null;
}

/* ------------------------------------------------------------- Chat history */

async function loadChatHistory(phone) {
  const key = chatUserKey(phone);
  if (usingRedis) {
    const raw = await redis(['GET', `chat:${key}`]);
    const list = parseMission(raw);
    return Array.isArray(list) ? list.slice(-40) : [];
  }
  if (usingBlob) {
    const list = await blobRead(`chat/${key}.json`);
    return Array.isArray(list) ? list.slice(-40) : [];
  }
  ensureChatStore();
  const store = readJson(CHAT_STORE_PATH, {});
  const list = store?.[key];
  return Array.isArray(list) ? list.slice(-40) : [];
}

async function saveChatHistory(phone, messages) {
  const key = chatUserKey(phone);
  if (!key || key === 'anonymous') return [];

  const clean = (messages || [])
    .filter(
      (m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
    )
    .slice(-40)
    .map((m) => ({ role: m.role, content: String(m.content).trim() }));

  if (usingRedis) {
    await redis(['SET', `chat:${key}`, JSON.stringify(clean)]);
    return clean;
  }
  if (usingBlob) {
    await blobWrite(`chat/${key}.json`, clean);
    return clean;
  }
  ensureChatStore();
  const store = readJson(CHAT_STORE_PATH, {});
  store[key] = clean;
  writeJson(CHAT_STORE_PATH, store);
  return clean;
}

module.exports = {
  getMission,
  saveMission,
  listMissions,
  removeMission,
  findMissionByCallId,
  loadChatHistory,
  saveChatHistory,
  backend,
  STORE_PATH,
};
