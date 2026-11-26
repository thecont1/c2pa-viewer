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

    // One-use enforcement: Cloudflare validates the same token repeatedly
    // within its validity window, so a solved challenge could otherwise mint
    // keys until the IP throttle bites. The token hash is claimed before the
    // key insert; a failed insert releases the claim so legitimate retries
    // after a transient error are not locked out.
    const tokenHash = await sha256HexText(token);
    try {
        await c.env.DB.batch([
            c.env.DB.prepare(
                `INSERT INTO turnstile_tokens (token_hash, created_at) VALUES (?, ?)`
            ).bind(tokenHash, nowIso()),
            c.env.DB.prepare(
                `DELETE FROM turnstile_tokens WHERE created_at < ?`
            ).bind(new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
        ]);
    } catch (e) {
        if (String(e).includes('UNIQUE')) {
            return problem(403, 'forbidden', { detail: 'this verification was already used — complete the challenge again.' });
        }
        console.error('turnstile token claim failed:', e);
        return problem(500, 'internal_error', { detail: 'signup unavailable — retry' });
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
        try {
            await c.env.DB.prepare('DELETE FROM turnstile_tokens WHERE token_hash = ?').bind(tokenHash).run();
        } catch (cleanupErr) {
            console.error('turnstile token release failed:', cleanupErr);
        }
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
    // Rotation must not launder quota: the QuotaCounter keys usage by key id,
    // so a fresh id would restart the month at zero. Carry the predecessor's
    // current-month usage into the successor's ledger row — the QuotaCounter
    // seeds first-touch state from exactly this row, so the allowance follows
    // the customer rather than the secret.
    const month = now.slice(0, 7);
    // Seed from the predecessor's live QuotaCounter, not the bare ledger:
    // finalize flushes every accepted verification synchronously and reports
    // consumed plus still-active reservations. Pre-counting the in-flight
    // reservations means no commit that lands after the rotation can slip
    // past the successor's counter — the handoff is closed rather than
    // best-effort. Uncontended rotations carry exactly the existing count.
    let carriedUsage = 0;
    let carriedBytes = 0;
    let seedSource = 'none';
    let finalized = false;
    const unfinalize = async () => {
        // Recovery when the rotation batch fails after finalizing: lift the
        // predecessor's admission block immediately rather than leaving the
        // key wedged until the handoff deadline expires.
        if (!finalized || !c.env.QUOTA_COUNTER) return;
        try {
            const stub = c.env.QUOTA_COUNTER.get(c.env.QUOTA_COUNTER.idFromName(row.id));
            await stub.fetch('https://quota-counter/', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ key_id: row.id, month, op: 'unfinalize' }),
            });
        } catch (e) {
            console.error('unfinalize failed (handoff self-expires in 2 min):', e);
        }
    };
    if (c.env.QUOTA_COUNTER) {
        try {
            const stub = c.env.QUOTA_COUNTER.get(c.env.QUOTA_COUNTER.idFromName(row.id));
            const resp = await stub.fetch('https://quota-counter/', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ key_id: row.id, month, op: 'finalize' }),
            });
            if (resp.ok) {
                const fin = await resp.json();
                if (fin.month === month) {
                    // Verifications still in flight would force a choice
                    // between over-counting the successor (pre-counted slots
                    // that later release) and double-counting (slots that
                    // commit on the predecessor). Neither is acceptable, so
                    // rotation waits: finalize already stopped new admissions
                    // on the predecessor, the in-flight set drains in seconds,
                    // and the customer retries. Uncontended rotations carry
                    // exactly the consumed count.
                    if ((fin.active || 0) > 0) {
                        await unfinalize();
                        return problem(409, 'conflict', { detail: 'verifications are in flight on this key — retry rotation in a few seconds' });
                    }
                    finalized = true;
                    carriedUsage = fin.consumed || 0;
                    seedSource = 'finalize';
                }
            }
        } catch (e) {
            console.error('rotation finalize read failed, falling back to ledger:', e);
        }
    }
    if (seedSource === 'none') {
        try {
            const usageRow = await c.env.DB.prepare(
                'SELECT verify_count, bytes_total FROM usage WHERE key_id = ? AND month = ?'
            ).bind(row.id, month).first();
            if (usageRow) {
                carriedUsage = usageRow.verify_count || 0;
                carriedBytes = usageRow.bytes_total || 0;
            }
        } catch (e) {
            console.error('rotation usage carry read failed:', e);
            return problem(500, 'internal_error', { detail: 'usage store unavailable' });
        }
    }
    // Billing fields derive from the predecessor AT WRITE TIME inside the
    // same transaction, not from the state read before key creation. A
    // subscription.deleted committed before this batch is visible to the
    // SELECT (successor starts free+canceled rather than inheriting a stale
    // paid entitlement); one committed after matches the successor by
    // subscription id and corrects it directly. SQLite serializes the two
    // transactions, so no interleaving can slip between them.
    const statements = [
        c.env.DB.prepare(
            `INSERT INTO keys (id, key_hash, display_prefix, name, type, tier, scopes, quota_monthly, allowed_origins, created_at, rotated_at, stripe_customer_id, stripe_subscription_id, billing_status)
             SELECT ?, ?, ?, name, type, tier, scopes, quota_monthly, allowed_origins, ?, ?,
                    stripe_customer_id, stripe_subscription_id, COALESCE(billing_status, 'none')
             FROM keys WHERE id = ?`
        ).bind(id, hash, displayPrefix, now, now, row.id),
        // Conditional revoke: a concurrent rotation that already revoked this
        // key changes zero rows here, which we detect below — the loser must
        // not leave a second live successor behind.
        c.env.DB.prepare('UPDATE keys SET revoked_at = ?, stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = ? AND revoked_at IS NULL').bind(now, row.id),
    ];
    if (carriedUsage > 0) {
        statements.push(c.env.DB.prepare(
            `INSERT INTO usage (key_id, month, verify_count, bytes_total, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (key_id, month) DO UPDATE SET
               verify_count = MAX(verify_count, excluded.verify_count),
               bytes_total  = bytes_total + excluded.bytes_total,
               updated_at   = excluded.updated_at`
        ).bind(id, month, carriedUsage, carriedBytes, now));
    }
    try {
        const results = await c.env.DB.batch(statements);
        const revokeResult = results[1];
        if (!revokeResult || (revokeResult.meta && revokeResult.meta.changes === 0)) {
            // Lost the race — the original key was already revoked by a
            // concurrent rotation. Remove the successor we just inserted so
            // exactly one live successor exists, and fail the request.
            try {
                await c.env.DB.prepare('DELETE FROM keys WHERE id = ?').bind(id).run();
                await c.env.DB.prepare('DELETE FROM usage WHERE key_id = ? AND month = ?').bind(id, month).run();
            } catch (cleanupErr) {
                console.error('rotation race cleanup failed:', cleanupErr);
            }
            await unfinalize();
            return problem(409, 'conflict', { detail: 'key was already rotated — use the successor issued by the first rotation' });
        }
    } catch (e) {
        console.error('key rotation failed:', e);
        await unfinalize();
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
