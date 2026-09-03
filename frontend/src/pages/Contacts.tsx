import { useEffect, useState } from 'react';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonTitle,
  IonToolbar,
  IonNote,
} from '@ionic/react';
import {
  deleteContact,
  loadContacts,
  upsertContact,
  type Contact,
} from '../contacts';

export default function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setContacts(loadContacts());
  }, []);

  function resetForm() {
    setName('');
    setPhone('');
    setNotes('');
    setEditingId(null);
  }

  function onSave() {
    setError('');
    setMessage('');
    if (!name.trim() || !phone.trim()) {
      setError('Name and phone are required.');
      return;
    }
    upsertContact({ id: editingId || undefined, name, phone, notes });
    setContacts(loadContacts());
    setMessage(editingId ? 'Contact updated.' : 'Contact saved.');
    resetForm();
  }

  function onEdit(c: Contact) {
    setEditingId(c.id);
    setName(c.name);
    setPhone(c.phone);
    setNotes(c.notes || '');
    setMessage('');
    setError('');
  }

  function onDelete(id: string) {
    deleteContact(id);
    setContacts(loadContacts());
    if (editingId === id) resetForm();
    setMessage('Contact removed.');
  }

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/home" />
          </IonButtons>
          <IonTitle>Contacts</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <div className="page-wrap">
          <h1 className="brand">Contacts</h1>
          <p className="lede">
            Save people you call often. Then say things like “Call Mom and tell her I’ll be late” —
            we’ll look up their number and deliver your message.
          </p>

          <div className="panel">
            <IonList lines="full">
              <IonItem>
                <IonLabel position="stacked">Name</IonLabel>
                <IonInput
                  value={name}
                  placeholder="Mom / Rahul / Dr. Patel"
                  onIonInput={(e) => setName(String(e.detail.value || ''))}
                />
              </IonItem>
              <IonItem>
                <IonLabel position="stacked">Phone</IonLabel>
                <IonInput
                  type="tel"
                  value={phone}
                  placeholder="+14793404542"
                  onIonInput={(e) => setPhone(String(e.detail.value || ''))}
                />
              </IonItem>
              <IonItem>
                <IonLabel position="stacked">Notes (optional)</IonLabel>
                <IonInput
                  value={notes}
                  placeholder="Sister, prefers evenings…"
                  onIonInput={(e) => setNotes(String(e.detail.value || ''))}
                />
              </IonItem>
            </IonList>
            <div className="actions">
              {editingId && (
                <IonButton fill="outline" onClick={resetForm}>
                  Cancel
                </IonButton>
              )}
              <IonButton onClick={onSave}>{editingId ? 'Update' : 'Save contact'}</IonButton>
            </div>
            <IonNote style={{ display: 'block', margin: '0 0 1rem 0.25rem' }}>
              Use the same name you’ll say in requests (e.g. “Mom”, “Venkat”).
            </IonNote>
          </div>

          {contacts.length === 0 ? (
            <div className="meta-block">
              <h3>No contacts yet</h3>
              <p>Add someone above to get started.</p>
            </div>
          ) : (
            <div className="meta-block">
              <h3>Saved ({contacts.length})</h3>
              {contacts.map((c) => (
                <div key={c.id} className="target-row">
                  <p>
                    <strong>{c.name}</strong>
                  </p>
                  <p>{c.phone}</p>
                  {c.notes && <p>{c.notes}</p>}
                  <div className="actions">
                    <IonButton size="small" fill="outline" onClick={() => onEdit(c)}>
                      Edit
                    </IonButton>
                    <IonButton size="small" fill="clear" color="danger" onClick={() => onDelete(c.id)}>
                      Delete
                    </IonButton>
                  </div>
                </div>
              ))}
            </div>
          )}

          {message && <p className="ok-text">{message}</p>}
          {error && <p className="error-text">{error}</p>}
        </div>
      </IonContent>
    </IonPage>
  );
}
