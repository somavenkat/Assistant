const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../../data');
const STORE_PATH = path.join(DATA_DIR, 'missions.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, '[]', 'utf8');
  }
}

function loadAll() {
  ensureStore();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn('[store] failed to read missions:', err.message);
    return [];
  }
}

function writeAll(list) {
  ensureStore();
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_PATH);
}

function createMemoryMap() {
  const map = new Map();
  for (const item of loadAll()) {
    if (item?.id) map.set(item.id, item);
  }
  return map;
}

function persistMission(mission) {
  if (!mission?.id) return;
  const list = loadAll();
  const idx = list.findIndex((m) => m.id === mission.id);
  const copy = JSON.parse(JSON.stringify(mission));
  if (idx >= 0) list[idx] = copy;
  else list.unshift(copy);
  // Keep a reasonable history size for v1
  writeAll(list.slice(0, 200));
}

function deleteMission(id) {
  const list = loadAll().filter((m) => m.id !== id);
  writeAll(list);
}

module.exports = {
  createMemoryMap,
  persistMission,
  deleteMission,
  loadAll,
  STORE_PATH,
};
