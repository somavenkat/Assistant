/**
 * Build a strong location context from the user profile.
 * Lat/lng + area are required for nearby business search — never ignore them.
 */
function buildLocationContext(profile = {}) {
  const area = String(profile.area || '').trim();
  const lat = Number(profile.latitude);
  const lng = Number(profile.longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);

  const parts = [];
  if (area) parts.push(area);
  if (hasCoords) parts.push(`coordinates ${lat.toFixed(5)},${lng.toFixed(5)}`);

  return {
    area,
    latitude: hasCoords ? lat : null,
    longitude: hasCoords ? lng : null,
    hasCoords,
    /** Short phrase for search queries */
    nearPhrase: parts.length
      ? `near ${parts.join(' · ')}`
      : '',
    /** Strict instructions for LLM web search */
    searchRules: [
      'CRITICAL LOCATION RULES:',
      `- User is in: ${area || 'unknown area'}${hasCoords ? ` (${lat.toFixed(5)}, ${lng.toFixed(5)})` : ''}.`,
      '- You MUST return the nearest matching business to the user — ideally within ~20–25 miles / ~30–40 minutes drive.',
      '- NEVER return a location that is hours away (e.g. another metro) when a closer branch exists.',
      '- If multiple branches exist (chains), pick the closest one to the user coordinates/area.',
      '- If you cannot find a location within ~40 miles, return confidence "low" and say so in notes — do NOT invent a far franchise as the answer.',
      '- Include the full street address so distance can be verified.',
    ].join('\n'),
  };
}

/**
 * Rough rejection: if user area names a TX city and address is clearly another far city.
 * Soft heuristic only — LLM should already prefer nearby.
 */
function looksFarFromUser(address = '', location) {
  if (!address || !location?.area) return false;
  const addr = String(address).toLowerCase();
  const area = String(location.area).toLowerCase();

  // If address contains a token from the user's area city, treat as local-ish
  const areaCity = area.split(',')[0].trim();
  if (areaCity.length >= 4 && addr.includes(areaCity)) return false;

  // Known far metros relative to Central Texas / Liberty Hill corridor
  const farMarkers = [
    'prosper, tx',
    'plano, tx',
    'frisco, tx',
    'mckinney, tx',
    'dallas, tx',
    'houston, tx',
    'san antonio, tx',
    'fort worth, tx',
  ];
  const localMarkers = [
    'liberty hill',
    'leander',
    'cedar park',
    'round rock',
    'georgetown',
    'austin',
    'jarrell',
    'florence',
    'hutto',
    'pflugerville',
  ];

  const mentionsLocal = localMarkers.some((m) => area.includes(m) || addr.includes(m));
  const mentionsFar = farMarkers.some((m) => addr.includes(m));

  // User is in Central TX corridor but result is DFW / Houston / SA
  if (mentionsLocal && mentionsFar && !localMarkers.some((m) => addr.includes(m))) {
    return true;
  }
  return false;
}

/**
 * Cities we can safely recognize by name inside a free-form request.
 * Central Texas corridor first, then the far metros we must never silently pick.
 */
const KNOWN_CITIES = [
  'liberty hill',
  'leander',
  'cedar park',
  'round rock',
  'georgetown',
  'austin',
  'jarrell',
  'florence',
  'hutto',
  'pflugerville',
  'lago vista',
  'bertram',
  'burnet',
  'marble falls',
  'manor',
  'kyle',
  'buda',
  'san marcos',
  'temple',
  'killeen',
  'prosper',
  'plano',
  'frisco',
  'mckinney',
  'dallas',
  'houston',
  'san antonio',
  'fort worth',
];

function titleCase(value = '') {
  return String(value)
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * A location the user names IN the request always beats their saved profile area.
 * "Call Chowrasta, ronald reagan, Leander" must search Leander even when Settings says Round Rock.
 * Returns '' when they did not say where — then the profile area is the right fallback.
 */
function extractRequestedLocation(request = '') {
  const text = String(request);

  // Curated names first — longest wins so "cedar park" beats a bare "park".
  const hit = KNOWN_CITIES.filter((city) =>
    new RegExp(`\\b${city.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text)
  ).sort((a, b) => b.length - a.length)[0];
  if (hit) return `${titleCase(hit)}, Texas`;

  // Otherwise "Wimberley, TX" — the state qualifier makes it unambiguous. Skip connecting
  // words so "from Tarka in Georgetown, TX" yields the city, not the business phrase.
  const word = '(?!(?:in|at|near|from|to|and|the|for)\\b)[A-Za-z][a-z]+';
  const qualified = text.match(
    new RegExp(`\\b(${word}(?:\\s+${word}){0,2}),\\s*(?:TX|Texas)\\b`, 'i')
  );
  return qualified ? `${titleCase(qualified[1].trim())}, Texas` : '';
}

module.exports = {
  buildLocationContext,
  looksFarFromUser,
  extractRequestedLocation,
};
