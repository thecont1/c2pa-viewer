// Self-service key management (Phase 4). Two surfaces:
//
//   POST /v1/signup/free   — PUBLIC, Turnstile-verified creation of a
//                            free-tier live key. The plaintext is returned
//                            exactly once; only the hash is stored.
//   /v1/key*               — authenticated by the key itself: metadata,
//                            usage history, rotation, self-revocation.
//   GET /v1/jobs           — paginated job history for the calling key.
//
// There is deliberately no account/email layer: the key IS the credential.
// Rotation preserves billing linkage (stripe customer/subscription ids) so a
// rotated paid key never loses its subscription.

import { problem } from './errors.js';
import { generateKey, sha256HexText, parseJsonArray } from './keys-mw.js';
import { getUsage, currentMonth } from './db.js';

const TIER_QUOTAS = { free: 1000, pro: 25000, scale: 250000 };

function nowIso() { return new Date().toISOString(); }

// ------------------------------------------------------------ signup ----

async function verifyTurnstile(env, token, ip) {
    if (!env.TURNSTILE_SECRET) return { error: 'not_configured' };
    const form = new URLSearchParams();
    form.set('secret', env.TURNSTILE_SECRET);
    form.set('response', token);
    if (ip) form.set('remoteip', ip);
    let resp;
    try {
        resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            signal: AbortSignal.timeout(10000),
        });
    } catch (e) {
        console.error('turnstile siteverify failed:', e);
        return { error: 'unavailable' };
    }
    const body = await resp.json().catch(() => ({}));
    return { ok: body.success === true };
}

export async function signupFreeHandler(c) {
    if (!c.env.TURNSTILE_SECRET) {
        return problem(503, 'internal_error', { detail: 'signup is not configured' });
    }
    let body;
    try { body = await c.req.json(); } catch {
        return problem(422, 'invalid_request', { detail: 'request body must be JSON' });
    }
    const token = body && body.turnstile_token;
    if (!token || typeof token !== 'string') {
        return problem(422, 'invalid_request', { detail: 'turnstile_token is required' });
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : null;

    // Per-IP throttle on top of Turnstile — signup is the one unauthenticated
    // write surface, so both layers apply.
    const ip = c.req.header('cf-connecting-ip') || 'unknown';
    if (c.env.SIGNUP_RATELIMIT) {
        try {
            const outcome = await c.env.SIGNUP_RATELIMIT.limit({ key: `signup:${ip}` });
            if (!outcome.success) {
                return problem(429, 'rate_limited', { detail: 'Too many signups from this network — try again shortly.' });
            }
        } catch (e) {
            console.error('signup rate limit failed:', e);
        }
    }

    const check = await verifyTurnstile(c.env, token, ip);
    if (check.error === 'unavailable') {
        return problem(503, 'internal_error', { detail: 'signup verification unavailable — retry' });
    }
    if (!check.ok) {
        return problem(403, 'forbidden', { detail: 'Turnstile verification failed.' });
    }

    const { plaintext, displayPrefix } = generateKey('live');
    const hash = await sha256HexText(plaintext);
    const id = crypto.randomUUID();
    const now = nowIso();
    try {
        await c.env.DB.prepare(
            `INSERT INTO keys (id, key_hash, display_prefix, name, type, tier, scopes, quota_monthly, created_at)
             VALUES (?, ?, ?, ?, 'server', 'free', '["verify"]', ?, ?)`
        ).bind(id, hash, displayPrefix, name, TIER_QUOTAS.free, now).run();
    } catch (e) {
        console.error('signup key insert failed:', e);
        return problem(500, 'internal_error', { detail: 'key creation failed' });
    }

    return Response.json({
        key: plaintext,
        display_prefix: displayPrefix,
        tier: 'free',
        quota_monthly: TIER_QUOTAS.free,
        created_at: now,
        notice: 'Store this key now — it is shown exactly once and cannot be recovered.',
    }, { status: 201 });
}

// -------------------------------------------------------- key self-service ----

export async function getKeyHandler(c) {
    const row = c.get('keyRow');
    const month = currentMonth();
    let usage = { verify_count: 0, bytes_total: 0 };
    try {
        usage = await getUsage(c.env.DB, row.id, month);
    } catch (e) {
        console.error('usage read failed:', e);
    }
    return Response.json({
        display_prefix: row.display_prefix,
        name: row.name,
        type: row.type,
        tier: row.tier,
        scopes: parseJsonArray(row.scopes),
        quota_monthly: row.quota_monthly,
        billing_status: row.billing_status || 'none',
        created_at: row.created_at,
        rotated_at: row.rotated_at,
        usage: { month, verify_count: usage.verify_count, bytes_total: usage.bytes_total },
    });
}

export async function getUsageHandler(c) {
    const row = c.get('keyRow');
    let res;
    try {
        res = await c.env.DB.prepare(
            'SELECT month, verify_count, bytes_total FROM usage WHERE key_id = ? ORDER BY month DESC LIMIT 12'
        ).bind(row.id).all();
    } catch (e) {
        console.error('usage history read failed:', e);
        return problem(500, 'internal_error', { detail: 'usage store unavailable' });
    }
    return Response.json({
        quota_monthly: row.quota_monthly,
        months: (res.results || []).map((r) => ({
            month: r.month,
            verify_count: r.verify_count,
            bytes_total: r.bytes_total,
        })),
    });
}

// Rotation: the successor inherits tier, quota, type, origins, scopes, name
// and the Stripe billing linkage. The old key is revoked in the same batch —
// there is no overlap window by design (callers must rotate onto the new key
// immediately), which keeps the number of live secrets per customer at one.
export async function rotateKeyHandler(c) {
    const row = c.get('keyRow');
    const kind = c.get('keyKind') || 'live';
    const { plaintext, displayPrefix } = generateKey(kind);
    const hash = await sha256HexText(plaintext);
    const id = crypto.randomUUID();
    const now = nowIso();
    try {
        await c.env.DB.batch([
            c.env.DB.prepare(
                `INSERT INTO keys (id, key_hash, display_prefix, name, type, tier, scopes, quota_monthly, allowed_origins, created_at, rotated_at, stripe_customer_id, stripe_subscription_id, billing_status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
                id, hash, displayPrefix, row.name, row.type, row.tier, row.scopes,
                row.quota_monthly, row.allowed_origins, now, now,
                row.stripe_customer_id || null, row.stripe_subscription_id || null,
                row.billing_status || 'none'
            ),
            c.env.DB.prepare('UPDATE keys SET revoked_at = ? WHERE id = ?').bind(now, row.id),
        ]);
    } catch (e) {
        console.error('key rotation failed:', e);
        return problem(500, 'internal_error', { detail: 'rotation failed' });
    }
    return Response.json({
        key: plaintext,
        display_prefix: displayPrefix,
        rotated_at: now,
        notice: 'The previous key is revoked. Store the new key now — it is shown exactly once.',
    });
}

export async function revokeKeyHandler(c) {
    const row = c.get('keyRow');
    const now = nowIso();
    try {
        await c.env.DB.prepare('UPDATE keys SET revoked_at = ? WHERE id = ?').bind(now, row.id).run();
    } catch (e) {
        console.error('key revocation failed:', e);
        return problem(500, 'internal_error', { detail: 'revocation failed' });
    }
    return Response.json({ revoked: true, display_prefix: row.display_prefix, revoked_at: now });
}

// ------------------------------------------------------------- jobs list ----

export async function listJobsHandler(c) {
    const row = c.get('keyRow');
    const url = new URL(c.req.url);
    let limit = parseInt(url.searchParams.get('limit') || '20', 10);
    if (!Number.isSafeInteger(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;
    const before = url.searchParams.get('before'); // created_at cursor

    let res;
    try {
        if (before) {
            res = await c.env.DB.prepare(
                `SELECT job_id, status, source, error, size_bytes, created_at, completed_at
                 FROM jobs WHERE key_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`
            ).bind(row.id, before, limit + 1).all();
        } else {
            res = await c.env.DB.prepare(
                `SELECT job_id, status, source, error, size_bytes, created_at, completed_at
                 FROM jobs WHERE key_id = ? ORDER BY created_at DESC LIMIT ?`
            ).bind(row.id, limit + 1).all();
        }
    } catch (e) {
        console.error('jobs list read failed:', e);
        return problem(500, 'internal_error', { detail: 'jobs store unavailable' });
    }

    const rows = res.results || [];
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit && page.length > 0 ? page[page.length - 1].created_at : null;
    return Response.json({
        jobs: page.map((j) => {
            let source = {};
            try { source = JSON.parse(j.source || '{}'); } catch { }
            return {
                job_id: j.job_id,
                status: j.status,
                filename: source.filename ?? null,
                size_bytes: j.size_bytes,
                error: j.error ? JSON.parse(j.error) : null,
                created_at: j.created_at,
                completed_at: j.completed_at,
            };
        }),
        next_cursor: nextCursor,
    });
}
