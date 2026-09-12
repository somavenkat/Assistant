import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { deleteMission, listMissions, type MissionRecord } from '../api';
import { loadCachedMissions } from '../missionCache';
import { Button, Card, Content, ErrorText, Hero, Page, Pill, TopBar } from '../ui';

function formatWhen(iso?: string) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function targetSummary(mission: MissionRecord) {
  const names = (mission.targets || []).map((t) => t.name || t.phone).filter(Boolean);
  if (!names.length) return 'No targets';
  return names.join(' · ');
}

export default function History() {
  const navigate = useNavigate();
  const [items, setItems] = useState<MissionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fromDeviceCache, setFromDeviceCache] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError('');
    setFromDeviceCache(false);
    const cached = loadCachedMissions();
    if (cached.length) setItems(cached);
    try {
      const list = await listMissions();
      setItems(list);
    } catch (e: any) {
      if (cached.length) {
        setFromDeviceCache(true);
      } else {
        setError(e.message || 'Could not load history');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onDelete(id: string, e: React.MouseEvent) {
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
    <Page>
      <TopBar
        title="History"
        back="/home"
        right={
          <Button variant="ghost" size="sm" onClick={load}>
            Refresh
          </Button>
        }
      />
      <Content>
        <Hero badge="Call history" title="Every call, in one place">
          Every mission and outbound call you've run, newest first.
          {fromDeviceCache && ' Showing saved history from this browser (server was unreachable).'}
        </Hero>

        {loading && items.length === 0 && (
          <>
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </>
        )}

        {error && <ErrorText>{error}</ErrorText>}

        {!loading && items.length === 0 && !error && (
          <Card>
            <div className="empty">
              <h3>No history yet</h3>
              <p>Place a call from Home and it will show up here.</p>
              <Button to="/home">New request</Button>
            </div>
          </Card>
        )}

        {items.map((m) => {
          const failed = m.status === 'failed' || Boolean(m.error);
          return (
            <div
              key={m.id}
              className="history-card"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/missions/${m.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') navigate(`/missions/${m.id}`);
              }}
            >
              <div className="history-top">
                <Pill tone={failed ? 'bad' : 'default'}>{m.status}</Pill>
                <span className="history-when">{formatWhen(m.createdAt)}</span>
              </div>
              <h3>{m.plan?.title || 'Mission'}</h3>
              <p>{m.request}</p>
              <p>{targetSummary(m)}</p>
              {m.recommendation?.bestOffer?.headline && (
                <p className="history-outcome">{m.recommendation.bestOffer.headline}</p>
              )}
              <div className="history-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busyId === m.id}
                  onClick={(e) => onDelete(m.id, e)}
                >
                  {busyId === m.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          );
        })}
      </Content>
    </Page>
  );
}
