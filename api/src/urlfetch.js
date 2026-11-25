// Server-side asset fetch for `url` inputs, with the SSRF guard shared from
// packages/core (the same module the Pages image proxy imports).
//
// - http(s) only, browser-like headers, 30 s overall timeout
// - manual redirect loop, max 5 hops — the SSRF check is re-applied to every
//   redirect target (never `redirect: 'follow'` blindly)
// - 20 MiB streaming cap enforced by counting body chunks (content-length
//   may be absent or wrong)
// - ALLOW_LOCAL_UPSTREAM=1 (dev/test escape hatch, NEVER set in production)
//   skips the private-host block so `wrangler dev --local` can fetch from a
//   loopback fixture server.
//
// Throws ApiError: 'invalid' (unparseable/non-http url), 'ssrf' (blocked
// host), 'upstream' (network error, timeout, bad status, redirect overflow),
// 'too_large' (cap exceeded). The handler maps kinds to problem responses.

import { isBlockedHost } from '../../packages/core/src/ssrf.js';
import { ApiError, MAX_SYNC_BYTES } from './errors.js';

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

const FETCH_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

function allowLocal(env) {
    return env && env.ALLOW_LOCAL_UPSTREAM === '1';
}

function checkHost(url, env) {
    if (!allowLocal(env) && isBlockedHost(url.hostname)) {
        throw new ApiError('ssrf', `host not allowed: ${url.hostname}`);
    }
}

async function readBodyCapped(resp) {
    // content-length pre-check when present (may be absent or wrong).
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > MAX_SYNC_BYTES) {
        throw new ApiError('too_large', `upstream asset exceeds the 20 MiB sync cap (content-length ${declared})`);
    }
    if (!resp.body) return new Uint8Array(0);

    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_SYNC_BYTES) {
            try { await reader.cancel(); } catch { }
            throw new ApiError('too_large', 'upstream asset exceeds the 20 MiB sync cap');
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
}

// Validate the caller-supplied URL without fetching it. Async jobs use this
// at acceptance time; the redirect-hopping fetch path re-applies checkHost to
// every concrete upstream URL before bytes are fetched.
export function validateAssetUrl(urlString, env) {
    let url;
    try {
        url = new URL(urlString);
    } catch {
        throw new ApiError('invalid', 'url is not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ApiError('invalid', 'only http(s) urls are allowed');
    }
    checkHost(url, env);
    return url;
}

export async function fetchAsset(urlString, env) {
    const url = validateAssetUrl(urlString, env);

    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let current = url;
    let resp = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        checkHost(current, env);

        const headers = { ...BROWSER_HEADERS, Referer: `${current.protocol}//${current.host}/` };
        let r;
        try {
            r = await fetch(current.toString(), { headers, redirect: 'manual', signal });
        } catch (e) {
            const msg = e && e.name === 'TimeoutError' ? 'upstream fetch timed out'
                : `upstream fetch failed: ${e && e.message ? e.message : String(e)}`;
            throw new ApiError('upstream', msg);
        }

        if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
            let next;
            try {
                next = new URL(r.headers.get('location'), current);
            } catch {
                throw new ApiError('upstream', 'upstream redirect target is not a valid URL');
            }
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                throw new ApiError('upstream', 'upstream redirected to a non-http(s) URL');
            }
            if (hop === MAX_REDIRECTS) break; // falls through to the overflow error below
            current = next;
            continue;
        }

        resp = r;
        break;
    }

    if (!resp) {
        throw new ApiError('upstream', `too many redirects (max ${MAX_REDIRECTS})`);
    }
    if (resp.status < 200 || resp.status >= 300) {
        throw new ApiError('upstream', `upstream returned HTTP ${resp.status}`);
    }

    let bytes;
    try {
        bytes = await readBodyCapped(resp);
    } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError('upstream', `upstream body read failed: ${e && e.message ? e.message : String(e)}`);
    }

    return {
        bytes,
        contentType: (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
        finalUrl: current.toString(),
    };
}
