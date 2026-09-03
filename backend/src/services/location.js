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

module.exports = {
  buildLocationContext,
  looksFarFromUser,
};
