// The Durable Object's SQLite schema. Append a new entry to change it; entries that have run never run again.
export const MIGRATIONS: string[] = [
  `
  -- API tokens are stored as SHA-256 hex digests.
  CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'responder' CHECK (role IN ('admin', 'responder')),
    token_hash  TEXT NOT NULL UNIQUE,
    timezone    TEXT NOT NULL DEFAULT 'UTC',
    created_at  INTEGER NOT NULL
  );

  -- rotation is JSON: { "start": epoch_ms, "shift_hours": n, "users": [user_id, ...] }.
  CREATE TABLE schedules (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    rotation    TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE schedule_overrides (
    id           TEXT PRIMARY KEY,
    schedule_id  TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    starts_at    INTEGER NOT NULL,
    ends_at      INTEGER NOT NULL
  );
  CREATE INDEX schedule_overrides_window ON schedule_overrides (schedule_id, starts_at, ends_at);

  -- steps is JSON: [{ "delay_min": n, "targets": [{ "type": "user" | "schedule", "id": "..." }] }].
  CREATE TABLE escalation_policies (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    steps       TEXT NOT NULL,
    repeat      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE services (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    description           TEXT NOT NULL DEFAULT '',
    escalation_policy_id  TEXT NOT NULL REFERENCES escalation_policies(id),
    integration_key       TEXT NOT NULL UNIQUE,
    created_at            INTEGER NOT NULL
  );

  CREATE TABLE incidents (
    id               TEXT PRIMARY KEY,
    number           INTEGER NOT NULL UNIQUE,
    service_id       TEXT NOT NULL REFERENCES services(id),
    dedup_key        TEXT NOT NULL,
    title            TEXT NOT NULL,
    severity         TEXT NOT NULL DEFAULT 'critical' CHECK (severity IN ('critical', 'error', 'warning', 'info')),
    status           TEXT NOT NULL DEFAULT 'triggered' CHECK (status IN ('triggered', 'acknowledged', 'resolved')),
    source           TEXT NOT NULL DEFAULT '',
    details          TEXT NOT NULL DEFAULT '{}',
    alert_count      INTEGER NOT NULL DEFAULT 1,
    escalation_step  INTEGER NOT NULL DEFAULT 0,
    assignees        TEXT NOT NULL DEFAULT '[]',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    acknowledged_at  INTEGER,
    acknowledged_by  TEXT,
    resolved_at      INTEGER,
    resolved_by      TEXT
  );
  -- At most one open incident per (service, dedup_key): repeats of a firing alert fold into it.
  CREATE UNIQUE INDEX incidents_open_dedup ON incidents (service_id, dedup_key) WHERE status != 'resolved';
  CREATE INDEX incidents_status ON incidents (status, created_at DESC);
  -- Rows read are billed: hardware pagers ask for the open incidents all day, so that must not walk the history.
  CREATE INDEX incidents_open ON incidents (created_at DESC) WHERE status != 'resolved';

  CREATE TABLE incident_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id  TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    at           INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    actor        TEXT,
    message      TEXT NOT NULL DEFAULT '',
    data         TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX incident_events_incident ON incident_events (incident_id, at);
  CREATE INDEX incident_events_receipts ON incident_events (at) WHERE kind IN ('notify_sent', 'alert_repeated');

  -- type: tuya | ntfy | webhook | slack | webpush. config is JSON, its shape per type (src/notify/*).
  CREATE TABLE contact_methods (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type          TEXT NOT NULL,
    label         TEXT NOT NULL DEFAULT '',
    config        TEXT NOT NULL,
    min_severity  TEXT NOT NULL DEFAULT 'info',
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX contact_methods_user ON contact_methods (user_id);

  -- Hardware pagers. The token only grants /v1/device/*.
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

  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT INTO counters (name, value) VALUES ('incident_number', 0);

  -- Where each incident stands in its policy. next_at is NULL once nothing more is scheduled.
  CREATE TABLE escalations (
    incident_id  TEXT PRIMARY KEY REFERENCES incidents(id) ON DELETE CASCADE,
    step         INTEGER NOT NULL DEFAULT -1,
    next_at      INTEGER,
    stopped      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX escalations_due ON escalations (next_at) WHERE next_at IS NOT NULL;

  -- Pages not delivered yet: one row per (incident, contact method, event), retried on its own.
  CREATE TABLE outbox (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id        TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    contact_method_id  TEXT NOT NULL,
    event              TEXT NOT NULL,
    due_at             INTEGER NOT NULL,
    attempts           INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX outbox_due ON outbox (due_at);
  `,
  `
  -- A snoozed incident is acknowledged until this time, then pages from the first step again.
  ALTER TABLE incidents ADD COLUMN snoozed_until INTEGER;
  -- Minutes after a page before this method is used: push first, the siren if nobody has answered.
  ALTER TABLE contact_methods ADD COLUMN delay_min INTEGER NOT NULL DEFAULT 0;
  `,
];
