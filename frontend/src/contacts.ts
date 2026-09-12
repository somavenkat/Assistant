export type Contact = {
  id: string;
  name: string;
  phone: string;
  notes?: string;
};

const KEY = 'apa.contacts.v1';

export function loadContacts(): Contact[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveContacts(contacts: Contact[]) {
  localStorage.setItem(KEY, JSON.stringify(contacts));
  return contacts;
}

export function upsertContact(contact: Omit<Contact, 'id'> & { id?: string }) {
  const list = loadContacts();
  const id = contact.id || crypto.randomUUID();
  const next: Contact = {
    id,
    name: contact.name.trim(),
    phone: contact.phone.trim(),
    notes: (contact.notes || '').trim(),
  };
  const idx = list.findIndex((c) => c.id === id);
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  saveContacts(list);
  return next;
}

export function deleteContact(id: string) {
  const list = loadContacts().filter((c) => c.id !== id);
  saveContacts(list);
  return list;
}
