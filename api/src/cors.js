// Per-key CORS.
//
// Actual requests: when the authenticated key has a non-empty allowed_origins
// list and the request Origin matches an entry EXACTLY, the origin is
// reflected in Access-Control-Allow-Origin (with `Vary: Origin`). Server-type
// keys never emit ACAO, even when an Origin header is present.
//
// Preflights (OPTIONS) carry no credentials, so no key is available: the
// origin is matched against the union of allowed_origins across all
// non-revoked keys. The actual request still enforces the per-key rule, so a
// preflight pass can never widen access.

import { allAllowedOrigins } from './db.js';
import { parseJsonArray } from './keys-mw.js';

const PREFLIGHT_HEADERS = {
    'Access-Control-Allow-Methods': 'GET,POST',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Max-Age': '86400',
};

// OPTIONS handler for /v1/* — mounted before the auth middleware.
export async function preflightMw(c) {
    const origin = c.req.header('origin');
    const headers = { ...PREFLIGHT_HEADERS };
    if (origin) {
        try {
            const allowed = await allAllowedOrigins(c.env.DB);
            if (allowed.has(origin)) {
                headers['Access-Control-Allow-Origin'] = origin;
                headers['Vary'] = 'Origin';
            }
        } catch (e) {
            console.error('preflight origin scan failed:', e);
            // fail closed: no ACAO
        }
    }
    return new Response(null, { status: 204, headers });
}

// Post-response middleware: reflect the origin when the authenticated key
// allows it. Must run after auth (needs c.var.keyRow).
export async function corsMw(c, next) {
    await next();
    const keyRow = c.get('keyRow');
    if (!keyRow) return;
    if (keyRow.type !== 'browser') return; // server keys never emit ACAO
    const origin = c.req.header('origin');
    if (!origin) return;
    const allowed = parseJsonArray(keyRow.allowed_origins);
    if (allowed.length > 0 && allowed.includes(origin)) {
        c.res.headers.set('Access-Control-Allow-Origin', origin);
        c.res.headers.set('Vary', 'Origin');
    }
}
