-- 0006: pricing model change — tiers are now free/sync_only/sync_async.
-- SQLite cannot alter a CHECK constraint; rebuild the keys table with the
-- new constraint, copy all rows, and restore the billing unique index.
-- Free rows carry over unchanged; no pro/scale rows exist (billing never
-- went live), but any would fail the new CHECK — coerce them to free.

CREATE TABLE keys_new (
    id              TEXT PRIMARY KEY,
    key_hash        TEXT UNIQUE NOT NULL,
    display_prefix  TEXT NOT NULL,
    name            TEXT,
    type            TEXT CHECK(type IN ('server','browser')) DEFAULT 'server',
    tier            TEXT CHECK(tier IN ('free','sync_only','sync_async')) DEFAULT 'free',
    scopes          TEXT NOT NULL DEFAULT '["verify"]',
    quota_monthly   INTEGER,
    allowed_origins TEXT,
    created_at      TEXT NOT NULL,
    rotated_at      TEXT,
    revoked_at      TEXT,
    notes           TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    billing_status  TEXT NOT NULL DEFAULT 'none',
    checkout_session_id TEXT,
    checkout_revealed_at TEXT
);

INSERT INTO keys_new
SELECT id, key_hash, display_prefix, name, type,
       CASE WHEN tier IN ('free','sync_only','sync_async') THEN tier ELSE 'free' END,
       scopes, quota_monthly, allowed_origins, created_at, rotated_at, revoked_at, notes,
       stripe_customer_id, stripe_subscription_id, billing_status, checkout_session_id, checkout_revealed_at
FROM keys;

DROP TABLE keys;
ALTER TABLE keys_new RENAME TO keys;

CREATE UNIQUE INDEX IF NOT EXISTS keys_checkout_session_unique
ON keys(checkout_session_id) WHERE checkout_session_id IS NOT NULL;
