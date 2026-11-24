// Request authorization middleware: bearer auth, per-key rate limiting and
// monthly quota. Runs (in this order) on POST /v1/verify and
// GET /v1/verify/mini before any body parsing or verification:
//
//   1. authMw        — bearer key lookup + scope enforcement
//   2. rateLimitMw   — env.RATELIMIT.limit({key: keyRow.id})
//   3. quotaMw       — monthly verify_count vs keys.quota_monthly
//
// Enforcement (Phase 1):
//   missing/malformed/unknown key -> 401 unauthorized (+ WWW-Authenticate)
//   revoked key                   -> 403 forbidden
//   type 'browser' keys           -> may ONLY call GET /v1/verify/mini;
//                                    anything else is 403 forbidden
//   rate limited                  -> 429 rate_limited  (+ Retry-After,
//                                    RateLimit-Policy, RateLimit-Limit)
//   quota exceeded                -> 429 quota_exceeded
//
// c2pa_test_ keys: asset sha256 must be in the fixture corpus — enforced in
// verify.js where the hash is computed — and usage is never metered.

import { problem } from './errors.js';
import { keyKind, lookupKey } from './keys-mw.js';
import { getUsage, currentMonth } from './db.js';

export const RATELIMIT_POLICY = '60;w=60';
export const RATELIMIT_LIMIT = '60';

export async function authMw(c, next) {
    const header = c.req.header('authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
        return problem(401, 'unauthorized', {
            detail: 'Missing bearer API key.',
            headers: { 'WWW-Authenticate': 'Bearer' },
        });
    }
    const presented = m[1].trim();
    const kind = keyKind(presented);
    if (!kind) {
        return problem(401, 'unauthorized', {
            detail: 'Malformed API key.',
            headers: { 'WWW-Authenticate': 'Bearer' },
        });
    }

    let row = null;
    try {
        row = await lookupKey(c.env.DB, presented);
    } catch (e) {
        console.error('key lookup failed:', e);
        return problem(500, 'internal_error', { detail: 'Key store unavailable.' });
    }
    if (!row) {
        return problem(401, 'unauthorized', {
            detail: 'Unknown API key.',
            headers: { 'WWW-Authenticate': 'Bearer' },
        });
    }
    if (row.revoked_at) {
        return problem(403, 'forbidden', { detail: 'This API key has been revoked.' });
    }

    // Scope check: browser keys may only call GET /v1/verify/mini.
    const path = new URL(c.req.url).pathname;
    if (row.type === 'browser' && !(c.req.method === 'GET' && path === '/v1/verify/mini')) {
        return problem(403, 'forbidden', {
            detail: 'Browser keys may only call GET /v1/verify/mini.',
        });
    }

    c.set('keyRow', row);
    c.set('keyKind', kind);
    await next();
}

// Cloudflare rate-limiting binding. Verified working under
// `wrangler dev --local` (wrangler 4.168.0): limit() meters and returns
// { success:false } once the simple limit is exhausted. The binding is
// REQUIRED — its absence means the worker is misconfigured, so we fail
// closed with internal_error rather than silently not limiting.
export async function rateLimitMw(c, next) {
    const keyRow = c.get('keyRow');
    if (!c.env.RATELIMIT) {
        console.error('RATELIMIT binding missing — worker misconfigured');
        return problem(500, 'internal_error', { detail: 'Rate limiting is not configured.' });
    }
    let outcome;
    try {
        outcome = await c.env.RATELIMIT.limit({ key: keyRow.id });
    } catch (e) {
        console.error('RATELIMIT.limit failed:', e);
        return problem(500, 'internal_error', { detail: 'Rate limiting unavailable.' });
    }
    if (!outcome.success) {
        return problem(429, 'rate_limited', {
            detail: 'Rate limit exceeded — 60 requests per minute per key.',
            headers: {
                'Retry-After': '30',
                'RateLimit-Policy': RATELIMIT_POLICY,
                'RateLimit-Limit': RATELIMIT_LIMIT,
            },
        });
    }
    await next();
}

// Monthly quota check. Reads the usage row for (key_id, current YYYY-MM);
// when keys.quota_monthly is not null and the count has reached it, the
// request is rejected before any verification work. The increment happens
// after a successful verification, off the response path (ctx.waitUntil).
export async function quotaMw(c, next) {
    const keyRow = c.get('keyRow');
    if (keyRow.quota_monthly === null || keyRow.quota_monthly === undefined) {
        await next();
        return;
    }
    let usage;
    try {
        usage = await getUsage(c.env.DB, keyRow.id, currentMonth());
    } catch (e) {
        console.error('usage read failed:', e);
        return problem(500, 'internal_error', { detail: 'Usage store unavailable.' });
    }
    if (usage.verify_count >= keyRow.quota_monthly) {
        return problem(429, 'quota_exceeded', {
            detail: `Monthly quota of ${keyRow.quota_monthly} verifications exhausted.`,
            headers: {
                'RateLimit-Policy': RATELIMIT_POLICY,
                'RateLimit-Limit': RATELIMIT_LIMIT,
            },
        });
    }
    await next();
}
