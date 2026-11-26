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
            if (allowed.has(origin) || isDashboardOrigin(c.env, origin)) {
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

// ------------------------------------------------------- dashboard lane ----
//
// The self-service dashboard is a first-party browser client of the key
// management and signup/billing endpoints. These endpoints are keyed by the
// presented bearer token itself, so ACAO emission here is hygiene rather than
// a security boundary — but we still reflect only first-party origins:
//   - the production dashboard origin
//   - branch preview aliases of the Pages project (*.c2pa-viewer-d9g.pages.dev)
//   - loopback for local development
// Extend or override with DASHBOARD_ORIGINS (comma-separated; a trailing *
// entry such as https://*.example.com suffix-matches the host).
const DASHBOARD_ORIGINS_DEFAULT = [
    'https://c2pa.thecontrarian.in',
    'http://localhost:8788',
    'http://127.0.0.1:8788',
];
const DASHBOARD_PREVIEW_SUFFIX = '.c2pa-viewer-d9g.pages.dev';

export function isDashboardOrigin(env, origin) {
    let list = DASHBOARD_ORIGINS_DEFAULT;
    if (env && env.DASHBOARD_ORIGINS) {
        try { list = env.DASHBOARD_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean); } catch { }
    }
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    for (const entry of list) {
        if (entry.includes('*')) {
            // Wildcard entries match by HOST suffix, not string prefix —
            // prefix matching lets https://api.example.com* admit
            // https://api.example.com.evil.test. The host must equal the
            // suffix base or end with "." + base, and the scheme must match.
            const star = entry.indexOf('*');
            const scheme = entry.slice(0, entry.indexOf('://') + 3);
            if (!origin.startsWith(scheme)) continue;
            const base = entry.slice(star + 1).replace(/^\./, '');
            if (!base) continue;
            if (host === base || host.endsWith('.' + base)) return true;
        } else if (origin === entry) return true;
    }
    if (host.endsWith(DASHBOARD_PREVIEW_SUFFIX) || host === DASHBOARD_PREVIEW_SUFFIX.slice(1)) return true;
    if (host === 'localhost' || host.startsWith('localhost:') || host.startsWith('127.0.0.1')) return true;
    return false;
}

// Post-response middleware for the self-service surface: reflect the origin
// when it is a first-party dashboard origin, regardless of key type (the
// dashboard authenticates with the user's server key from the browser — that
// is its designed use).
export async function dashboardCorsMw(c, next) {
    await next();
    const origin = c.req.header('origin');
    if (!origin) return;
    if (isDashboardOrigin(c.env, origin)) {
        c.res.headers.set('Access-Control-Allow-Origin', origin);
        c.res.headers.set('Vary', 'Origin');
    }
}
