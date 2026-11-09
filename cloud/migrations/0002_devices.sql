-- Hardware pagers (T5AI-Core boards and other firmware clients). Each belongs to a user and rings for the
-- incidents that user is paged for. The device token is stored as a SHA-256 hex digest and only grants /v1/device/*.
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  last_seen_at  INTEGER,
  last_ip       TEXT,
  firmware      TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX devices_user ON devices (user_id);
