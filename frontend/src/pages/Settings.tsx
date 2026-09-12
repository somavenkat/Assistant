import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { detectAreaFromGeolocation, emptyProfile, loadProfile, saveProfile, type UserProfile } from '../profile';
import {
  notifyPermission,
  requestNotifyPermission,
  showNotification,
  type NotifyPermission,
} from '../notifications';
import { Button, Card, Content, ErrorText, Field, Hero, Note, OkText, Page, Pill, TopBar } from '../ui';

export default function Settings() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfile>(emptyProfile());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [notify, setNotify] = useState<NotifyPermission>('default');

  useEffect(() => {
    setProfile(loadProfile());
    setNotify(notifyPermission());
  }, []);

  async function onEnableNotifications() {
    const result = await requestNotifyPermission();
    setNotify(result);
    if (result === 'granted') {
      showNotification('Notifications on', "You'll get a summary here when a call finishes.");
      setMessage('Call notifications enabled.');
    } else if (result === 'denied') {
      setError('Notifications are blocked. Enable them for this site in your browser settings.');
    }
  }

  function update<K extends keyof UserProfile>(key: K, value: UserProfile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
  }

  function onSave() {
    setError('');
    if (!profile.name.trim() || !profile.phone.trim()) {
      setError('Name and phone are required.');
      return;
    }
    saveProfile(profile);
    setMessage('Profile saved.');
    setTimeout(() => navigate('/home'), 350);
  }

  async function onUseLocation() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const geo = await detectAreaFromGeolocation();
      setProfile((p) => ({ ...p, ...geo }));
      setMessage(`Location set to ${geo.area || geo.address}`);
    } catch (e: any) {
      setError(e?.message || 'Could not get your location. You can type your city manually.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <TopBar title="Settings" back="/home" />
      <Content>
        <Hero badge="Profile" title="Your profile">
          Saved once and reused for every mission — restaurant pickups, insurance shopping, and anything else you
          ask for.
        </Hero>

        <Card>
          <Field
            label="Name"
            value={profile.name}
            placeholder="Alex Rivera"
            onChange={(v) => update('name', v)}
          />
          <Field
            label="Phone"
            type="tel"
            value={profile.phone}
            placeholder="+15551234567"
            onChange={(v) => update('phone', v)}
          />
          <Field
            label="Current area"
            value={profile.area}
            placeholder="Austin, TX"
            onChange={(v) => update('area', v)}
          />
          <Field
            label="Current address (optional)"
            value={profile.address || ''}
            placeholder="Street, city, state"
            onChange={(v) => update('address', v)}
          />

          <div className="actions">
            <Button variant="outline" loading={busy} onClick={onUseLocation}>
              Use my location
            </Button>
            <Button variant="outline" to="/contacts">
              Manage contacts
            </Button>
            <Button onClick={onSave}>Save profile</Button>
          </div>
          <Note>
            Location uses your browser GPS and OpenStreetMap to fill your city and address. You can edit it anytime.
          </Note>
        </Card>

        <Card>
          <h3>Call notifications</h3>
          <p>
            Get a browser notification with what was said as soon as a call wraps up — even if this tab is in the
            background.
          </p>
          <div className="actions">
            {notify === 'granted' ? (
              <Pill>Enabled</Pill>
            ) : notify === 'unsupported' ? (
              <Pill tone="bad">Not supported in this browser</Pill>
            ) : notify === 'denied' ? (
              <Pill tone="bad">Blocked in browser settings</Pill>
            ) : (
              <Button variant="outline" onClick={onEnableNotifications}>
                Enable notifications
              </Button>
            )}
            {notify === 'granted' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  showNotification('Test notification', 'This is how call summaries will look.')
                }
              >
                Send test
              </Button>
            )}
          </div>
        </Card>

        {(profile.address || (profile.latitude != null && profile.longitude != null)) && (
          <Card>
            <h3>Location</h3>
            {profile.address && <p>{profile.address}</p>}
            {profile.latitude != null && profile.longitude != null && (
              <p className="clarify-why">
                Coordinates: {profile.latitude.toFixed(5)}, {profile.longitude.toFixed(5)}
              </p>
            )}
          </Card>
        )}

        {message && <OkText>{message}</OkText>}
        {error && <ErrorText>{error}</ErrorText>}
      </Content>
    </Page>
  );
}
