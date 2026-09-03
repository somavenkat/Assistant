export type UserProfile = {
  name: string;
  phone: string;
  area: string;
  latitude: number | null;
  longitude: number | null;
  updatedAt?: string;
};

const KEY = 'apa.profile.v1';

export const emptyProfile = (): UserProfile => ({
  name: '',
  phone: '',
  area: '',
  latitude: null,
  longitude: null,
});

export function loadProfile(): UserProfile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyProfile();
    return { ...emptyProfile(), ...JSON.parse(raw) };
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(profile: UserProfile) {
  const next = { ...profile, updatedAt: new Date().toISOString() };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function profileIsReady(profile: UserProfile) {
  return Boolean(profile.name.trim() && profile.phone.trim());
}

export async function detectAreaFromGeolocation(): Promise<
  Pick<UserProfile, 'area' | 'latitude' | 'longitude'>
> {
  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not available in this browser'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
    });
  });

  const { latitude, longitude } = position.coords;
  const area = await reverseGeocode(latitude, longitude);
  return { area, latitude, longitude };
}

async function reverseGeocode(latitude: number, longitude: number): Promise<string> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error('Could not reverse-geocode your location');
  const data = await res.json();
  const a = data.address || {};
  const city = a.city || a.town || a.village || a.suburb || a.county || '';
  const state = a.state || '';
  const parts = [city, state].filter(Boolean);
  return parts.join(', ') || data.display_name || `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`;
}