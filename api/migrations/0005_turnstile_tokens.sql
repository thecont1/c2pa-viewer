-- One-use enforcement for Turnstile signup tokens. Cloudflare validates the
-- same token repeatedly within its validity window, so without dedupe one
-- solved challenge could mint unlimited free keys. Rows are pruned past the
-- token validity window at insert time.
CREATE TABLE IF NOT EXISTS turnstile_tokens (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
