-- Idempotency receipts for the QuotaCounter D1 ledger. The DO retries failed
-- ledger writes; without a receipt a retry that follows an unacknowledged
-- success would double-count the verification. One row per committed
-- verification token.
CREATE TABLE IF NOT EXISTS quota_receipts (
    receipt_id TEXT PRIMARY KEY,
    key_id TEXT NOT NULL,
    month TEXT NOT NULL,
    created_at TEXT NOT NULL
);
