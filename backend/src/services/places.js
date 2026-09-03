const axios = require('axios');
const config = require('../config');
const { findBusinessWithOpenAI } = require('./openai');

function toE164US(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(phone).startsWith('+')) return String(phone).replace(/\s/g, '');
  return String(phone);
}

/**
 * Lookup any business phone/address.
 * Prefer Google Places when key is present; otherwise OpenAI web search.
 */
async function lookupBusiness({ name, searchQuery, locationHint, manualPhone, placeType }) {
  if (manualPhone) {
    return {
      name,
      phone: toE164US(manualPhone),
      address: locationHint || '',
      website: '',
      source: 'manual',
      confidence: 'high',
      notes: 'Phone provided by user',
    };
  }

  if (config.googlePlacesApiKey) {
    const fromPlaces = await lookupWithGooglePlaces({
      name,
      searchQuery,
      locationHint,
      placeType,
    });
    if (fromPlaces?.phone) return fromPlaces;
  }

  const fromAi = await findBusinessWithOpenAI({
    name,
    searchQuery: searchQuery || name,
    locationHint,
  });
  if (fromAi?.phone) {
    return {
      name: fromAi.name || name,
      phone: toE164US(fromAi.phone),
      address: fromAi.address || '',
      website: fromAi.website || '',
      source: 'openai_web_search',
      confidence: fromAi.confidence || 'medium',
      notes: fromAi.notes || '',
    };
  }

  return null;
}

async function lookupRestaurant({ restaurantName, locationHint, manualPhone }) {
  return lookupBusiness({
    name: restaurantName,
    searchQuery: restaurantName,
    locationHint,
    manualPhone,
    placeType: 'restaurant',
  });
}

async function lookupWithGooglePlaces({ name, searchQuery, locationHint, placeType }) {
  const textQuery = [searchQuery || name, locationHint].filter(Boolean).join(' ');
  try {
    const body = {
      textQuery,
      pageSize: 3,
    };
    if (placeType) body.includedType = placeType;

    const { data } = await axios.post('https://places.googleapis.com/v1/places:searchText', body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.googlePlacesApiKey,
        'X-Goog-FieldMask':
          'places.displayName,places.nationalPhoneNumber,places.internationalPhoneNumber,places.formattedAddress,places.websiteUri',
      },
      timeout: 15000,
    });

    const place = data.places?.[0];
    if (!place) return null;

    const phone = place.internationalPhoneNumber || place.nationalPhoneNumber;
    return {
      name: place.displayName?.text || name,
      phone: toE164US(phone),
      address: place.formattedAddress || '',
      website: place.websiteUri || '',
      source: 'google_places',
      confidence: 'high',
      notes: '',
    };
  } catch (err) {
    console.warn('[places] Google Places lookup failed:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  lookupBusiness,
  lookupRestaurant,
  toE164US,
};