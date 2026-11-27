// Billing adapter + Stripe implementation (Phase 4). The adapter boundary is
// deliberately thin — the commercial model is flat-tier subscriptions with
// hard quota caps, so the provider surface is exactly: checkout sessions,
// customer portal sessions, and inbound webhook events.
//
// Flows:
//   upgrade   — POST /v1/billing/checkout with key auth: metadata.key_id
//               links the session; the webhook upgrades THAT key in place
//               (the plaintext never changes).
//   new-paid  — POST /v1/billing/checkout without auth: the webhook creates
//               a fresh key stamped with checkout_session_id; the success
//               page reveals it exactly once via GET /v1/billing/reveal.
//   lifecycle — subscription.updated syncs the tier from the price;
//               subscription.deleted downgrades to free;
//               invoice.payment_failed marks past_due (keys keep working —
//               hard-cutting on a soft failure is customer-hostile).
//
// Everything degrades to a clean 503 billing_not_configured when the Stripe
// secrets are absent, so the API deploys and passes contract tests with or
// without a Stripe account attached.

import { problem } from './errors.js';
import { generateKey, sha256HexText } from './keys-mw.js';

// Tier model (2026-11 restructure): free is flat; the paid tiers sell in
// MULTIPLES of a unit quota — quota_monthly = subscription quantity x unit.
// sync_only forbids async jobs entirely (async verification costs an order
// of magnitude more per unit — see the pricing analysis); sync_async is the
// mixed tier. Annual and monthly are separate Stripe prices of the same tier.
const TIER_UNIT_QUOTAS = { sync_only: 10000, sync_async: 25000 };
const FREE_QUOTA = 500;
const TIER_QUOTAS = { free: FREE_QUOTA, sync_only: TIER_UNIT_QUOTAS.sync_only, sync_async: TIER_UNIT_QUOTAS.sync_async };
const PAID_TIERS = ['sync_only', 'sync_async'];
const MAX_UNITS = 100;
const PRICE_ENVS = {
    sync_only: { month: 'STRIPE_PRICE_SYNC_MONTHLY', year: 'STRIPE_PRICE_SYNC_ANNUAL' },
    sync_async: { month: 'STRIPE_PRICE_ASYNC_MONTHLY', year: 'STRIPE_PRICE_ASYNC_ANNUAL' },
};
const STRIPE_API = 'https://api.stripe.com/v1';

function quotaFor(tier, units) {
    if (tier === 'free') return FREE_QUOTA;
    const unit = TIER_UNIT_QUOTAS[tier];
    if (!unit) return FREE_QUOTA;
    const u = Math.max(1, Math.min(MAX_UNITS, Math.floor(units) || 1));
    return unit * u;
}

function nowIso() { return new Date().toISOString(); }

export function billingConfigured(env) {
    if (!env.STRIPE_SECRET_KEY) return false;
    for (const tier of PAID_TIERS) {
        if (!env[PRICE_ENVS[tier].month] || !env[PRICE_ENVS[tier].year]) return false;
    }
    return true;
}

function notConfigured() {
    return problem(503, 'billing_not_configured', { detail: 'billing is not configured on this deployment' });
}

async function stripe(env, method, path, params) {
    const headers = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
    let body;
    if (params) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = encodeParams(params);
    }
    const resp = await fetch(`${STRIPE_API}${path}`, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const msg = json && json.error && json.error.message ? json.error.message : `HTTP ${resp.status}`;
        throw new Error(`stripe ${method} ${path}: ${msg}`);
    }
    return json;
}

// Stripe form-encoding: nested objects as parent[child]=value, no arrays
// needed for our parameter shapes.
function encodeParams(params, prefix) {
    const parts = [];
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        const key = prefix ? `${prefix}[${k}]` : k;
        if (typeof v === 'object') parts.push(encodeParams(v, key));
        else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
    return parts.filter(Boolean).join('&');
}

function priceForTier(env, tier, period) {
    const envs = PRICE_ENVS[tier];
    if (!envs) return null;
    return env[period === 'year' ? envs.year : envs.month] || null;
}

function tierForPrice(env, priceId) {
    for (const tier of PAID_TIERS) {
        if (priceId === env[PRICE_ENVS[tier].month] || priceId === env[PRICE_ENVS[tier].year]) return tier;
    }
    return null;
}

// ------------------------------------------------------------- checkout ----

export async function checkoutHandler(c) {
    if (!billingConfigured(c.env)) return notConfigured();
    let body;
    try { body = await c.req.json(); } catch {
        return problem(422, 'invalid_request', { detail: 'request body must be JSON' });
    }
    const tier = body && body.tier;
    if (!PAID_TIERS.includes(tier)) {
        return problem(422, 'invalid_request', { detail: 'tier must be sync_only or sync_async' });
    }
    const period = body && body.period === 'year' ? 'year' : 'month';
    let units = body && body.units !== undefined ? Math.floor(Number(body.units)) : 1;
    if (!Number.isSafeInteger(units) || units < 1 || units > MAX_UNITS) {
        return problem(422, 'invalid_request', { detail: `units must be an integer between 1 and ${MAX_UNITS}` });
    }

    // Optional key auth: an authenticated caller upgrades in place; an
    // anonymous caller gets the keyless new-customer flow. The keyless flow
    // is unauthenticated spend-adjacent surface, so Turnstile is mandatory
    // when the secret is configured.
    const keyRow = c.get('keyRow') || null;
    if (!keyRow && c.env.TURNSTILE_SECRET) {
        const token = body.turnstile_token;
        if (!token || typeof token !== 'string') {
            return problem(422, 'invalid_request', { detail: 'turnstile_token is required' });
        }
        const form = new URLSearchParams();
        form.set('secret', c.env.TURNSTILE_SECRET);
        form.set('response', token);
        const ip = c.req.header('cf-connecting-ip');
        if (ip) form.set('remoteip', ip);
        let ok = false;
        try {
            const vr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: form.toString(),
                signal: AbortSignal.timeout(10000),
            });
            ok = (await vr.json()).success === true;
        } catch (e) {
            console.error('turnstile siteverify failed:', e);
        }
        if (!ok) return problem(403, 'forbidden', { detail: 'Turnstile verification failed.' });
    }

    const base = (c.env.DASHBOARD_BASE_URL || 'https://c2pa.creds.im').replace(/\/$/, '');
    const params = {
        mode: 'subscription',
        line_items: { 0: { price: priceForTier(c.env, tier, period), quantity: units } },
        success_url: `${base}/dashboard#/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/dashboard#/checkout/cancel`,
        'metadata[tier]': tier,
        'metadata[units]': String(units),
        'subscription_data[metadata][tier]': tier,
        'subscription_data[metadata][units]': String(units),
        allow_promotion_codes: 'true',
    };
    if (keyRow) {
        // One subscription per key: a key with a live billing relationship
        // (active, past_due or unpaid — anything the webhook lifecycle still
        // manages) checking out again would stack a second subscription the
        // customer cannot see or manage. Direct them to the portal instead.
        // canceled rows are terminal and MAY check out again.
        if (keyRow.stripe_subscription_id
            && (keyRow.billing_status === 'active' || keyRow.billing_status === 'past_due' || keyRow.billing_status === 'unpaid')) {
            return problem(409, 'conflict', { detail: 'this key already has a subscription — use the billing portal to manage it' });
        }
        params['metadata[key_id]'] = keyRow.id;
        params['subscription_data[metadata][key_id]'] = keyRow.id;
        if (keyRow.stripe_customer_id) params.customer = keyRow.stripe_customer_id;
    }

    let session;
    try {
        session = await stripe(c.env, 'POST', '/checkout/sessions', params);
    } catch (e) {
        console.error('checkout session creation failed:', e);
        return problem(502, 'billing_unavailable', { detail: 'billing provider error — retry shortly' });
    }
    return Response.json({ checkout_url: session.url, session_id: session.id }, { status: 201 });
}

// Provision-at-reveal for the keyless paid flow. No key exists until the
// customer lands on the success page: this endpoint verifies the checkout
// session directly with Stripe, creates the key in that instant, and returns
// the plaintext in the same response — so plaintext never rests anywhere, not
// even transiently. The unique index on checkout_session_id makes replays and
// races exactly-once: the first reveal wins, every later attempt is 410.
export async function revealHandler(c) {
    if (!billingConfigured(c.env)) return notConfigured();
    const sessionId = new URL(c.req.url).searchParams.get('session_id');
    if (!sessionId || typeof sessionId !== 'string') {
        return problem(422, 'invalid_request', { detail: 'session_id query parameter is required' });
    }

    const existing = await c.env.DB.prepare(
        'SELECT id FROM keys WHERE checkout_session_id = ?'
    ).bind(sessionId).first();
    if (existing) {
        return problem(410, 'gone', { detail: 'this key was already revealed; it cannot be shown again' });
    }

    let session;
    try {
        session = await stripe(c.env, 'GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
    } catch (e) {
        console.error('checkout session lookup failed:', e);
        return problem(404, 'not_found', { detail: 'unknown checkout session' });
    }
    if (session.payment_status !== 'paid' || !session.subscription) {
        return problem(402, 'payment_required', { detail: 'this checkout session is not yet paid' });
    }
    const tier = session.metadata && session.metadata.tier;
    if (!tier || !PAID_TIERS.includes(tier)) {
        console.error('reveal: session missing tier metadata', sessionId);
        return problem(500, 'internal_error', { detail: 'checkout session is malformed — contact support' });
    }
    // Upgrade sessions already have a key — they provision through the
    // webhook, not reveal. Provisioning here would hand out a second key.
    if (session.metadata && session.metadata.key_id) {
        return problem(422, 'invalid_request', { detail: 'this checkout was an upgrade of an existing key — the key tier updates automatically' });
    }
    // A subscription canceled before the first reveal must not provision a
    // key that silently bills/renews nothing — provision it free-tier with
    // canceled status so the customer still gets what they paid for
    // historically but no entitlement confusion arises.
    let billingStatus = 'active';
    let units = 1;
    try {
        const sub = await stripe(c.env, 'GET', `/subscriptions/${encodeURIComponent(session.subscription)}`);
        const item = sub && sub.items && sub.items.data && sub.items.data[0];
        if (item && item.quantity) units = item.quantity;
        if (sub && (sub.status === 'canceled' || sub.status === 'incomplete_expired')) {
            // Terminal: no entitlement beyond free, no restoration path.
            billingStatus = 'canceled';
        } else if (sub && sub.status === 'unpaid') {
            // unpaid is NOT terminal: Stripe restores the subscription when
            // the customer settles. Provision free-tier for now — the
            // subscription.updated webhook restores the paid tier because
            // only 'canceled' rows are terminal-skipped there.
            billingStatus = 'unpaid';
        } else if (sub && sub.status === 'past_due') {
            billingStatus = 'past_due';
        }
    } catch (e) {
        console.error('reveal subscription lookup failed:', e);
        return problem(502, 'billing_unavailable', { detail: 'billing provider error — retry shortly' });
    }

    const { plaintext, displayPrefix } = generateKey('live');
    const hash = await sha256HexText(plaintext);
    const id = crypto.randomUUID();
    const now = nowIso();
    try {
        const effectiveTier = (billingStatus === 'canceled' || billingStatus === 'unpaid') ? 'free' : tier;
        await c.env.DB.prepare(
            `INSERT INTO keys (id, key_hash, display_prefix, name, type, tier, scopes, quota_monthly, created_at,
                               stripe_customer_id, stripe_subscription_id, billing_status, checkout_session_id, checkout_revealed_at)
             VALUES (?, ?, ?, ?, 'server', ?, '["verify"]', ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, hash, displayPrefix, `stripe-${sessionId.slice(-8)}`, effectiveTier, effectiveTier === 'free' ? FREE_QUOTA : quotaFor(effectiveTier, units), now,
            session.customer || null, session.subscription, billingStatus, sessionId, now).run();
    } catch (e) {
        // Unique-index race: a concurrent reveal already provisioned it.
        if (String(e).includes('UNIQUE')) {
            return problem(410, 'gone', { detail: 'this key was already revealed; it cannot be shown again' });
        }
        console.error('reveal provisioning failed:', e);
        return problem(500, 'internal_error', { detail: 'key provisioning failed — contact support' });
    }

    // The subscription read above predates the insert commit; a cancellation
    // landing in that gap would already have fired its webhook against zero
    // rows, leaving this key with a stale paid entitlement. Re-read once
    // after insertion — a cancellation visible now corrects the row in the
    // same request.
    if (billingStatus === 'active' || billingStatus === 'past_due') {
        try {
            const subNow = await stripe(c.env, 'GET', `/subscriptions/${encodeURIComponent(session.subscription)}`);
            if (subNow && (subNow.status === 'canceled' || subNow.status === 'incomplete_expired')) {
                await c.env.DB.prepare(
                    `UPDATE keys SET tier = 'free', quota_monthly = ?, billing_status = 'canceled' WHERE id = ?`
                ).bind(TIER_QUOTAS.free, id).run();
            } else if (subNow && subNow.status === 'unpaid') {
                await c.env.DB.prepare(
                    `UPDATE keys SET tier = 'free', quota_monthly = ?, billing_status = 'unpaid' WHERE id = ?`
                ).bind(TIER_QUOTAS.free, id).run();
            }
        } catch (e) {
            // The webhook lifecycle still converges the row in the common
            // case — log and continue rather than failing the reveal.
            console.error('post-insert subscription re-read failed:', e);
        }
    }

    return Response.json({
        key: plaintext,
        display_prefix: displayPrefix,
        tier: (billingStatus === 'canceled' || billingStatus === 'unpaid') ? 'free' : tier,
        quota_monthly: (billingStatus === 'canceled' || billingStatus === 'unpaid') ? FREE_QUOTA : quotaFor(tier, units),
        created_at: now,
        notice: 'Store this key now — it is shown exactly once and cannot be recovered.',
    }, { status: 201 });
}

// Anonymous billing endpoints cost Stripe round-trips (reveal does two per
// call) or shape financial state (webhook). They carry no API key, so they
// rate-limit per client IP — generous enough for legitimate checkout polling
// and Stripe's retry cadence, tight enough to blunt scripted abuse.
export async function billingRateLimitMw(c, next) {
    if (!c.env.BILLING_RATELIMIT) {
        console.error('BILLING_RATELIMIT binding missing — worker misconfigured');
        return problem(500, 'internal_error', { detail: 'rate limiting is not configured' });
    }
    const ip = c.req.header('cf-connecting-ip') || 'unknown';
    let outcome;
    try {
        outcome = await c.env.BILLING_RATELIMIT.limit({ key: `billing:${ip}` });
    } catch (e) {
        console.error('BILLING_RATELIMIT failed:', e);
        return problem(500, 'internal_error', { detail: 'rate limiting unavailable' });
    }
    if (!outcome.success) {
        return problem(429, 'rate_limited', {
            detail: 'Rate limit exceeded — retry shortly.',
            headers: { 'Retry-After': '30' },
        });
    }
    await next();
}

export async function portalHandler(c) {
    if (!billingConfigured(c.env)) return notConfigured();
    const keyRow = c.get('keyRow');
    if (!keyRow.stripe_customer_id) {
        return problem(422, 'invalid_request', { detail: 'no billing account is linked to this key' });
    }
    const base = (c.env.DASHBOARD_BASE_URL || 'https://c2pa.creds.im').replace(/\/$/, '');
    let session;
    try {
        session = await stripe(c.env, 'POST', '/billing_portal/sessions', {
            customer: keyRow.stripe_customer_id,
            return_url: `${base}/dashboard`,
        });
    } catch (e) {
        console.error('portal session creation failed:', e);
        return problem(502, 'billing_unavailable', { detail: 'billing provider error — retry shortly' });
    }
    return Response.json({ portal_url: session.url });
}

// ------------------------------------------------------------- webhook ----

// Stripe-Signature: t=<unix>,v1=<hex-hmac-sha256 of "t.rawbody">. Verified
// with the webhook signing secret; 5-minute timestamp tolerance.
async function verifyStripeSignature(secret, header, rawBody) {
    if (!header) return false;
    // Stripe emits multiple v1 entries while webhook secrets rotate;
    // Object.fromEntries would collapse them to the last one. Collect all
    // and accept when any matches.
    const parts = {};
    const v1s = [];
    for (const p of header.split(',')) {
        const i = p.indexOf('=');
        const k = p.slice(0, i), v = p.slice(i + 1);
        if (k === 'v1') v1s.push(v);
        else parts[k] = v;
    }
    const t = parts.t;
    if (!t || !v1s.length) return false;
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    // Constant-time compare against every candidate signature.
    for (const v1 of v1s) {
        if (hex.length !== v1.length) continue;
        let diff = 0;
        for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
        if (diff === 0) return true;
    }
    return false;
}

async function provisionUpgrade(db, keyId, tier, customerId, subscriptionId, units) {
    // Provision whenever this checkout session carries a subscription the
    // row does not already point at. subscription.deleted NULLs the linkage,
    // so a canceled row satisfies the condition for a genuinely NEW
    // subscription — re-subscribing after cancellation must re-provision,
    // or the customer is billed for a key that stays free forever with no
    // webhook path able to repair it. The duplicate-delivery case is a
    // no-op by construction: a redelivered session for the subscription the
    // row ALREADY carries matches neither arm.
    // Residual race, accepted: a redelivered session for the SAME canceled
    // subscription arriving after deletion nulled the linkage also matches
    // — it requires webhook delivery failure inside Stripe's retry window
    // plus a same-window cancellation, and the redelivered
    // subscription.deleted following behind it re-cancels the row.
    await db.prepare(
        `UPDATE keys SET tier = ?, quota_monthly = ?, stripe_customer_id = ?, stripe_subscription_id = ?, billing_status = 'active'
         WHERE id = ? AND (stripe_subscription_id IS NULL OR stripe_subscription_id != ?)`
    ).bind(tier, quotaFor(tier, units), customerId, subscriptionId, keyId, subscriptionId).run();
}

export async function webhookHandler(c) {
    if (!c.env.STRIPE_WEBHOOK_SECRET) return notConfigured();
    const raw = await c.req.text();
    const valid = await verifyStripeSignature(
        c.env.STRIPE_WEBHOOK_SECRET,
        c.req.header('stripe-signature'),
        raw
    );
    if (!valid) return problem(401, 'unauthorized', { detail: 'invalid webhook signature' });

    let event;
    try { event = JSON.parse(raw); } catch {
        return problem(422, 'invalid_request', { detail: 'webhook body must be JSON' });
    }
    const type = event.type;
    const obj = event.data && event.data.object ? event.data.object : {};

    try {
        switch (type) {
            case 'checkout.session.completed': {
                const subId = obj.subscription;
                const customerId = obj.customer;
                const tier = (obj.metadata && obj.metadata.tier) || null;
                if (!subId || !tier || !PAID_TIERS.includes(tier)) break;
                // Only the upgrade path provisions here — keyless keys are
                // created at reveal time and never touch the webhook.
                const keyId = obj.metadata && obj.metadata.key_id;
                const units = obj.metadata && obj.metadata.units ? Number(obj.metadata.units) : 1;
                if (keyId) await provisionUpgrade(c.env.DB, keyId, tier, customerId, subId, units);
                break;
            }
            case 'customer.subscription.updated': {
                const item = obj.items && obj.items.data && obj.items.data[0];
                const priceId = item && item.price && item.price.id;
                const tier = priceId ? tierForPrice(c.env, priceId) : null;
                if (!tier) break;
                // Quantity is the subscription's own truth — customers can
                // change unit count in the portal, and the quota follows.
                const units = item && item.quantity ? item.quantity : 1;
                // unpaid is stored distinctly from canceled: it carries free
                // entitlement only, but a later active event restores the
                // paid tier because the row is not terminal-skipped.
                // Only active/past_due/unpaid carry the paid entitlement.
                // Every other Stripe status — incomplete, incomplete_expired,
                // paused, anything new — must fail CLOSED to free quota:
                // defaulting unknown statuses to active grants the paid tier
                // on a subscription that may never have collected a payment,
                // and incomplete_expired is terminal with no
                // subscription.deleted ever arriving to correct it. The raw
                // status is stored rather than collapsed to 'canceled' so a
                // later legitimate incomplete -> active transition still
                // restores the paid tier (the terminal-canceled guard would
                // otherwise ignore it).
                const status = obj.status === 'active' ? 'active'
                    : obj.status === 'past_due' ? 'past_due'
                    : obj.status === 'unpaid' ? 'unpaid'
                    : typeof obj.status === 'string' && obj.status ? obj.status.slice(0, 64) : 'inactive';
                const entitled = status === 'active' || status === 'past_due';
                const effectiveTier = entitled ? tier : 'free';
                const effectiveQuota = entitled ? quotaFor(tier, units) : FREE_QUOTA;
                // Stripe does not guarantee event ordering — an older
                // subscription.updated arriving after subscription.deleted
                // would resurrect the paid tier. Skip rows already terminally
                // canceled for this subscription.
                await c.env.DB.prepare(
                    `UPDATE keys SET tier = ?, quota_monthly = ?, billing_status = ? WHERE stripe_subscription_id = ? AND billing_status != 'canceled'`
                ).bind(effectiveTier, effectiveQuota, status, obj.id).run();
                break;
            }
            case 'customer.subscription.deleted': {
                await c.env.DB.prepare(
                    `UPDATE keys SET tier = 'free', quota_monthly = ?, billing_status = 'canceled', stripe_subscription_id = NULL
                     WHERE stripe_subscription_id = ?`
                ).bind(TIER_QUOTAS.free, obj.id).run();
                break;
            }
            case 'invoice.payment_failed': {
                if (obj.subscription) {
                    await c.env.DB.prepare(
                        `UPDATE keys SET billing_status = 'past_due' WHERE stripe_subscription_id = ?`
                    ).bind(obj.subscription).run();
                }
                break;
            }
            default:
                break; // uninteresting events ack'd silently
        }
    } catch (e) {
        console.error(`webhook ${type} processing failed:`, e);
        // 500 makes Stripe retry — correct for transient D1 failures.
        return problem(500, 'internal_error', { detail: 'webhook processing failed' });
    }

    return Response.json({ received: true });
}
