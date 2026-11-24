-- c2pa-verify-api — initial schema (Phase 1 sync MVP).
--
-- keys: API key metadata. The plaintext secret is NEVER stored — only
-- key_hash (sha256 hex of the full key). Lookup at auth time is
-- sha256(presented key) -> row.
--
-- usage: monthly metering per key. month is 'YYYY-MM' (UTC).
-- verify_count/bytes_total are incremented only after successful
-- verifications; test keys are never metered.

CREATE TABLE IF NOT EXISTS keys (
    id              TEXT PRIMARY KEY,               -- uuid
    key_hash        TEXT UNIQUE NOT NULL,           -- sha256 hex of the full key
    display_prefix  TEXT NOT NULL,                  -- e.g. "c2pa_live_ab12cd34" — safe to display
    name            TEXT,
    type            TEXT CHECK(type IN ('server','browser')) DEFAULT 'server',
    tier            TEXT CHECK(tier IN ('free','pro','scale')) DEFAULT 'free',
    scopes          TEXT NOT NULL DEFAULT '["verify"]',   -- JSON array
    quota_monthly   INTEGER,                        -- NULL = unlimited; default 500 for free
    allowed_origins TEXT,                           -- JSON array; NULL/empty = server-to-server only (no CORS)
    created_at      TEXT NOT NULL,
    rotated_at      TEXT,
    revoked_at      TEXT,
    notes           TEXT
);

CREATE TABLE IF NOT EXISTS usage (
    key_id       TEXT NOT NULL,
    month        TEXT NOT NULL,                     -- 'YYYY-MM'
    verify_count INTEGER NOT NULL DEFAULT 0,
    bytes_total  INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT,
    PRIMARY KEY (key_id, month)
);
