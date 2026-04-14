CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channel_ts ON messages (channel_hash, timestamp);

CREATE TABLE IF NOT EXISTS members (
  channel_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (channel_hash, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_members_channel ON members (channel_hash);

CREATE TABLE IF NOT EXISTS registry (
  channel_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  readme TEXT,
  tags TEXT,
  owner_fingerprint TEXT NOT NULL,
  owner_name TEXT,
  invite_token TEXT,
  member_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_registry_name ON registry (name);

CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  key TEXT NOT NULL,
  subchannel TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
