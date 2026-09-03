import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
  useIonViewWillEnter,
} from '@ionic/react';
import { deleteMission, listMissions, type MissionRecord } from '../api';

function formatWhen(iso?: string) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function targetSummary(mission: MissionRecord) {
  const names = (mission.targets || [])
    .map((t) => t.name || t.phone)
    .filter(Boolean);
  if (!names.length) return 'No targets';
  return names.join(' · ');
}

export default function History() {
  const navigate = useNavigate();
  const [items, setItems] = useState<MissionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const list = await listMissions();
      setItems(list);
    } catch (e: any) {
      setError(e.message || 'Could not load history');
    } finally {
      setLoading(false);
    }
  }

  useIonViewWillEnter(() => {
    load();
  });

  async function onDelete(id: string, e: { stopPropagation: () => void }) {
    e.stopPropagation();
    setBusyId(id);
    try {
      await deleteMission(id);
      setItems((prev) => prev.filter((m) => m.id !== id));
    } catch (err: any) {
      setError(err.message || 'Delete failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/home" />
          </IonButtons>
          <IonTitle>History</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={load}>Refresh</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <div className="page-wrap">
          <h1 className="brand">Call history</h1>
          <p className="lede">Every mission and outbound call you’ve run, newest first.</p>

          {loading && <IonSpinner name="crescent" />}
          {error && <p className="error-text">{error}</p>}

          {!loading && items.length === 0 && (
            <div className="meta-block">
              <h3>No history yet</h3>
              <p>Place a call from Home and it will show up here.</p>
              <div className="actions">
                <IonButton onClick={() => navigate('/home')}>New request</IonButton>
              </div>
            </div>
          )}

          {items.map((m) => {
            const failed = m.status === 'failed' || Boolean(m.error);
            return (
              <button
                key={m.id}
                type="button"
                className="history-card"
                onClick={() => navigate(`/missions/${m.id}`)}
              >
                <div className="history-card-top">
                  <span className={`status-pill ${failed ? 'failed' : ''}`}>{m.status}</span>
                  <span className="history-when">{formatWhen(m.createdAt)}</span>
                </div>
                <h3>{m.plan?.title || 'Mission'}</h3>
                <p className="history-request">{m.request}</p>
                <p className="history-targets">{targetSummary(m)}</p>
                {m.recommendation?.bestOffer?.headline && (
                  <p className="history-outcome">{m.recommendation.bestOffer.headline}</p>
                )}
                <div className="history-actions">
                  <IonButton
                    size="small"
                    fill="clear"
                    color="danger"
                    disabled={busyId === m.id}
                    onClick={(e) => onDelete(m.id, e)}
                  >
                    {busyId === m.id ? '…' : 'Delete'}
                  </IonButton>
                </div>
              </button>
            );
          })}
        </div>
      </IonContent>
    </IonPage>
  );
}
