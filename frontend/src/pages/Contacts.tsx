import { useEffect, useState } from 'react';
import { deleteContact, loadContacts, upsertContact, type Contact } from '../contacts';
import { Button, Card, Content, ErrorText, Field, Hero, Note, OkText, Page, TopBar } from '../ui';

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
    <Page>
      <TopBar title="Contacts" back="/home" />
      <Content>
        <Hero badge="Contacts" title="People you call">
          Save people you call often. Then say things like “Call Mom and tell her I'll be late” — we'll look up
          their number and deliver your message.
        </Hero>

        <Card>
          <Field label="Name" value={name} placeholder="Mom / Rahul / Dr. Patel" onChange={setName} />
          <Field label="Phone" type="tel" value={phone} placeholder="+14793404542" onChange={setPhone} />
          <Field
            label="Notes (optional)"
            value={notes}
            placeholder="Sister, prefers evenings…"
            onChange={setNotes}
          />
          <div className="actions">
            {editingId && (
              <Button variant="outline" onClick={resetForm}>
                Cancel
              </Button>
            )}
            <Button onClick={onSave}>{editingId ? 'Update' : 'Save contact'}</Button>
          </div>
          <Note>Use the same name you'll say in requests (e.g. “Mom”, “Venkat”).</Note>
        </Card>

        {contacts.length === 0 ? (
          <Card>
            <div className="empty">
              <h3>No contacts yet</h3>
              <p>Add someone above to get started.</p>
            </div>
          </Card>
        ) : (
          <Card>
            <h3>Saved ({contacts.length})</h3>
            {contacts.map((c) => (
              <div key={c.id} className="row">
                <p className="row-title">{c.name}</p>
                <p>{c.phone}</p>
                {c.notes && <p>{c.notes}</p>}
                <div className="actions">
                  <Button variant="outline" size="sm" onClick={() => onEdit(c)}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onDelete(c.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </Card>
        )}

        {message && <OkText>{message}</OkText>}
        {error && <ErrorText>{error}</ErrorText>}
      </Content>
    </Page>
  );
}
