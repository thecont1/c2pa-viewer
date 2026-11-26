-- Phase 4 commercial layer: billing linkage on keys.
--
-- stripe_customer_id / stripe_subscription_id link a key to its Stripe
-- billing identity (NULL for free keys and pre-Phase-4 keys).
-- billing_status: 'none' | 'active' | 'past_due' | 'canceled' — denormalized
-- from Stripe webhook events so the dashboard never needs a live Stripe call.
-- checkout_reveal_* implement the keyless paid-signup flow: the checkout
-- session id is the bearer secret that reveals the newly created key exactly
-- once (revealed_at set on first read).

ALTER TABLE keys ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE keys ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE keys ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE keys ADD COLUMN checkout_session_id TEXT;
ALTER TABLE keys ADD COLUMN checkout_revealed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS keys_checkout_session_unique
    ON keys (checkout_session_id)
    WHERE checkout_session_id IS NOT NULL;
