CREATE TABLE services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

INSERT INTO services (name, duration_minutes, active) VALUES
  ('Strzyżenie', 30, 1),
  ('Strzyżenie + broda', 45, 1);

CREATE TABLE appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id),
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  client_email TEXT NOT NULL,
  start_at TEXT NOT NULL, -- ISO 8601 UTC
  end_at TEXT NOT NULL,   -- ISO 8601 UTC
  status TEXT NOT NULL DEFAULT 'confirmed', -- 'confirmed' | 'cancelled'
  cancel_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);

CREATE INDEX idx_appointments_start_at ON appointments(start_at);
CREATE INDEX idx_appointments_status ON appointments(status);
CREATE INDEX idx_appointments_cancel_token ON appointments(cancel_token);
