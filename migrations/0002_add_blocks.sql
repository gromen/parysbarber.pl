CREATE TABLE blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_at TEXT NOT NULL, -- ISO 8601 UTC
  end_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_blocks_start_at ON blocks(start_at);
