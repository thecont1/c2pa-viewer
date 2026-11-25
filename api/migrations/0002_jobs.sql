-- c2pa-verify-api — async verification jobs (Phase 3).
--
-- jobs: one row per asynchronous verification. source is a JSON object with
-- the caller-visible input facts ({url? , filename?, mime?, size_bytes?});
-- object_key is the canonical R2 input object (uploads/{job_id}). processing_token
-- is internal queue idempotency state: it ties the processing status to the exact
-- queue message that may be retried, so duplicate R2 event deliveries do not start
-- parallel verification work.
CREATE TABLE IF NOT EXISTS jobs (
    job_id           TEXT PRIMARY KEY,
    key_id           TEXT NOT NULL,
    status           TEXT NOT NULL CHECK(status IN ('queued','awaiting_upload','processing','succeeded','failed')),
    idempotency_key  TEXT,
    source           TEXT NOT NULL DEFAULT '{}',
    webhook_url      TEXT,
    include          TEXT,
    trust            TEXT,
    strip_gps        INTEGER NOT NULL DEFAULT 1,
    error            TEXT,
    object_key       TEXT,
    size_bytes       INTEGER,
    processing_token TEXT,
    webhook_enqueued_at TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    completed_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_key_idempotency_unique
    ON jobs (key_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_key_created_idx ON jobs (key_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_object_key_idx ON jobs (object_key);
