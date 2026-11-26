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
import { reserveQuota, releaseQuota } from './quota.js';

export const RATELIMIT_POLICY = '60;w=60';
export const RATELIMIT_LIMIT = '60';

// Bearer-key lookup shared by the REST and MCP auth middleware. Returns
// { row, kind } on success or { error } with enough information for each
// surface to shape its own response (REST keeps revoked keys at 403; the MCP
// phase-2 endpoint presents every credential failure as 401).
export async function authenticateBearer(env, headerValue) {
    const header = headerValue || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
        return {
            error: {
                status: 401,
                code: 'unauthorized',
                detail: 'Missing bearer API key.',
                headers: { 'WWW-Authenticate': 'Bearer' },
                reason: 'missing',
            },
        };
    }
    const presented = m[1].trim();
    const kind = keyKind(presented);
    if (!kind) {
        return {
            error: {
                status: 401,
                code: 'unauthorized',
                detail: 'Malformed API key.',
                headers: { 'WWW-Authenticate': 'Bearer' },
                reason: 'malformed',
            },
        };
    }

    let row = null;
    try {
        row = await lookupKey(env.DB, presented);
    } catch (e) {
        console.error('key lookup failed:', e);
        return {
            error: {
                status: 500,
                code: 'internal_error',
                detail: 'Key store unavailable.',
                headers: {},
                reason: 'store',
            },
        };
    }
    if (!row) {
        return {
            error: {
                status: 401,
                code: 'unauthorized',
                detail: 'Unknown API key.',
                headers: { 'WWW-Authenticate': 'Bearer' },
                reason: 'unknown',
            },
        };
    }
    if (row.revoked_at) {
        return {
            error: {
                status: 403,
                code: 'forbidden',
                detail: 'This API key has been revoked.',
                headers: {},
                reason: 'revoked',
            },
        };
    }

    return { row, kind };
}

// Optional bearer auth for endpoints that serve both authenticated and
// anonymous callers (billing checkout). A presented key is fully validated —
// a bad key is still a 401/403, only ABSENCE is anonymous.
export async function optionalAuthMw(c, next) {
    if (!c.req.header('authorization')) {
        await next();
        return;
    }
    return await authMw(c, next);
}

export async function authMw(c, next) {
    const auth = await authenticateBearer(c.env, c.req.header('authorization'));
    if (auth.error) {
        return problem(auth.error.status, auth.error.code, {
            detail: auth.error.detail,
            headers: auth.error.headers,
        });
    }
    const { row, kind } = auth;

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
//
// checkRateLimit returns null when
// the request may proceed, otherwise a response-independent error object that
// both Hono middleware and MCP tool dispatch can shape appropriately.
export async function checkRateLimit(env, keyRow) {
    if (!env.RATELIMIT) {
        console.error('RATELIMIT binding missing — worker misconfigured');
        return { status: 500, code: 'internal_error', detail: 'Rate limiting is not configured.', headers: {} };
    }
    let outcome;
    try {
        outcome = await env.RATELIMIT.limit({ key: keyRow.id });
    } catch (e) {
        console.error('RATELIMIT.limit failed:', e);
        return { status: 500, code: 'internal_error', detail: 'Rate limiting unavailable.', headers: {} };
    }
    if (!outcome.success) {
        return {
            status: 429,
            code: 'rate_limited',
            detail: 'Rate limit exceeded — 60 requests per minute per key.',
            headers: {
                'Retry-After': '30',
                'RateLimit-Policy': RATELIMIT_POLICY,
                'RateLimit-Limit': RATELIMIT_LIMIT,
            },
        };
    }
    return null;
}

export async function rateLimitMw(c, next) {
    const failure = await checkRateLimit(c.env, c.get('keyRow'));
    if (failure) {
        return problem(failure.status, failure.code, {
            detail: failure.detail,
            headers: failure.headers,
        });
    }
    await next();
}

// Monthly quota enforcement via the QuotaCounter Durable Object. Admission
// reserves a slot (a pending token, never touching consumed); success commits
// inside runVerification before the response completes, so the finally-release
// below is a no-op for committed tokens and the exact release path for every
// failure shape (shaped 4xx, thrown error, downstream abort). Token expiry in
// the DO covers the worker-crash case.
export async function quotaMw(c, next) {
    const keyRow = c.get('keyRow');
    let reservation;
    try {
        reservation = await reserveQuota(c.env, keyRow);
    } catch (e) {
        console.error('quota reserve failed:', e);
        return problem(500, 'internal_error', { detail: 'Usage store unavailable.' });
    }
    if (!reservation) {
        return problem(429, 'quota_exceeded', {
            detail: `Monthly quota of ${keyRow.quota_monthly} verifications exhausted.`,
            headers: {
                'RateLimit-Policy': RATELIMIT_POLICY,
                'RateLimit-Limit': RATELIMIT_LIMIT,
            },
        });
    }
    c.set('quotaToken', reservation.token);
    try {
        await next();
    } finally {
        await releaseQuota(c.env, keyRow, reservation.token);
    }
}
