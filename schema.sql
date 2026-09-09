CREATE TABLE IF NOT EXISTS sync_rooms (
  room TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_history (
  room TEXT NOT NULL,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room, revision)
);
