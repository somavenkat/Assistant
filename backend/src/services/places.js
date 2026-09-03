const axios = require('axios');
const config = require('../config');
const { findBusinessWithOpenAI } = require('./openai');
const { buildLocationContext, looksFarFromUser } = require('./location');

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
 * ALWAYS bias to the user's profile location (area + lat/lng).
 */
async function lookupBusiness({
  name,
  searchQuery,
  locationHint,
  latitude,
  longitude,
  manualPhone,
  placeType,
}) {
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

  const location = buildLocationContext({
    area: locationHint || '',
    latitude,
    longitude,
  });

  if (config.googlePlacesApiKey) {
    const fromPlaces = await lookupWithGooglePlaces({
      name,
      searchQuery,
      location,
      placeType,
    });
    if (fromPlaces?.phone && !looksFarFromUser(fromPlaces.address, location)) {
      return fromPlaces;
    }
    // If Google returned something far away, keep searching with OpenAI rather than accepting it.
  }

  const fromAi = await findBusinessWithOpenAI({
    name,
    searchQuery: searchQuery || name,
    location,
  });
  if (fromAi?.phone) {
    if (looksFarFromUser(fromAi.address, location) && fromAi.confidence !== 'high') {
      console.warn(
        `[places] Rejecting far match for "${name}": ${fromAi.address} (user: ${location.area})`
      );
      // Still try once more with an even stricter query
      const retry = await findBusinessWithOpenAI({
        name,
        searchQuery: `${name} closest location to ${location.area || 'user'}`,
        location,
        strictNearbyOnly: true,
      });
      if (retry?.phone && !looksFarFromUser(retry.address, location)) {
        return {
          name: retry.name || name,
          phone: toE164US(retry.phone),
          address: retry.address || '',
          website: retry.website || '',
          source: 'openai_web_search',
          confidence: retry.confidence || 'medium',
          notes: retry.notes || 'Closest nearby match',
        };
      }
      // Do not return a known-far wrong restaurant for a pickup order
      return {
        name: fromAi.name || name,
        phone: '',
        address: fromAi.address || '',
        website: fromAi.website || '',
        source: 'openai_web_search',
        confidence: 'low',
        notes: `Found a location that appears too far from ${location.area}: ${fromAi.address}. Need a closer branch.`,
        error: `The closest "${name}" we found (${fromAi.address}) looks too far from your area (${location.area}). Update your area in Settings or name a closer location.`,
      };
    }

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

async function lookupRestaurant({ restaurantName, locationHint, latitude, longitude, manualPhone }) {
  return lookupBusiness({
    name: restaurantName,
    searchQuery: restaurantName,
    locationHint,
    latitude,
    longitude,
    manualPhone,
    placeType: 'restaurant',
  });
}

async function lookupWithGooglePlaces({ name, searchQuery, location, placeType }) {
  const textQuery = [searchQuery || name, location.nearPhrase || location.area]
    .filter(Boolean)
    .join(' ');
  try {
    const body = {
      textQuery,
      pageSize: 5,
    };
    if (placeType) body.includedType = placeType;
    if (location.hasCoords) {
      // Bias hard to user's GPS — ~25 mile / 40km radius
      body.locationBias = {
        circle: {
          center: { latitude: location.latitude, longitude: location.longitude },
          radius: 40000,
        },
      };
    }

    const { data } = await axios.post('https://places.googleapis.com/v1/places:searchText', body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.googlePlacesApiKey,
        'X-Goog-FieldMask':
          'places.displayName,places.nationalPhoneNumber,places.internationalPhoneNumber,places.formattedAddress,places.websiteUri,places.location',
      },
      timeout: 15000,
    });

    const places = Array.isArray(data.places) ? data.places : [];
    // Prefer first result that isn't absurdly far when we can tell
    const place =
      places.find((p) => !looksFarFromUser(p.formattedAddress || '', location)) || places[0];
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
