CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  appointment_id INTEGER NULL REFERENCES appointments(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (role IN ('client', 'barber')),
  CHECK ((role = 'client' AND appointment_id IS NOT NULL) OR (role = 'barber' AND appointment_id IS NULL))
);

CREATE TABLE reminders_sent (
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (appointment_id, kind)
);
