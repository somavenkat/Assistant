import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
  IonButtons,
  IonBackButton,
  IonNote,
} from '@ionic/react';
import {
  detectAreaFromGeolocation,
  emptyProfile,
  loadProfile,
  saveProfile,
  type UserProfile,
} from '../profile';

export default function Settings() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfile>(emptyProfile());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setProfile(loadProfile());
  }, []);

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
    setTimeout(() => navigate('/home'), 400);
  }

  async function onUseLocation() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const geo = await detectAreaFromGeolocation();
      setProfile((p) => ({ ...p, ...geo }));
      setMessage(`Area set to ${geo.area}`);
    } catch (e: any) {
      setError(e?.message || 'Could not get your location. You can type your city manually.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/home" />
          </IonButtons>
          <IonTitle>Settings</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <div className="page-wrap">
          <h1 className="brand">Your profile</h1>
          <p className="lede">
            Saved once and reused for every mission — restaurant pickups, insurance shopping, and
            anything else you ask for.
          </p>

          <div className="panel">
            <IonList lines="full">
              <IonItem>
                <IonLabel position="stacked">Name</IonLabel>
                <IonInput
                  value={profile.name}
                  placeholder="Alex Rivera"
                  onIonInput={(e) => update('name', String(e.detail.value || ''))}
                />
              </IonItem>
              <IonItem>
                <IonLabel position="stacked">Phone</IonLabel>
                <IonInput
                  type="tel"
                  value={profile.phone}
                  placeholder="+15551234567"
                  onIonInput={(e) => update('phone', String(e.detail.value || ''))}
                />
              </IonItem>
              <IonItem>
                <IonLabel position="stacked">Current area</IonLabel>
                <IonInput
                  value={profile.area}
                  placeholder="Austin, TX"
                  onIonInput={(e) => update('area', String(e.detail.value || ''))}
                />
              </IonItem>
            </IonList>

            <div className="actions">
              <IonButton fill="outline" disabled={busy} onClick={onUseLocation}>
                {busy ? <IonSpinner name="crescent" /> : 'Use my location'}
              </IonButton>
              <IonButton fill="outline" routerLink="/contacts">
                Manage contacts
              </IonButton>
              <IonButton onClick={onSave}>Save profile</IonButton>
            </div>
            <IonNote style={{ display: 'block', margin: '0 0 1rem 0.25rem' }}>
              Location uses your browser GPS and OpenStreetMap to fill city/area. You can edit it
              anytime.
            </IonNote>
          </div>

          {profile.latitude != null && profile.longitude != null && (
            <div className="meta-block">
              <h3>Coordinates</h3>
              <p>
                {profile.latitude.toFixed(5)}, {profile.longitude.toFixed(5)}
              </p>
            </div>
          )}

          {message && <p className="ok-text">{message}</p>}
          {error && <p className="error-text">{error}</p>}
        </div>
      </IonContent>
    </IonPage>
  );
}