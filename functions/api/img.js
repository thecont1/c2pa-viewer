// Image proxy for cross-origin C2PA/EXIF fetches.
// The browser cannot read arbitrary image URLs without CORS, so the client
// falls back to this function which fetches upstream with browser-like
// headers (mirroring the old ImagePathContext behaviour in server.py).

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

const MAX_BYTES = 80 * 1024 * 1024; // 80 MB — covers large RAW/DNG files
const FETCH_TIMEOUT_MS = 30000;

// Raster types safe to label as images; anything else is downgraded to
// octet-stream so HTML/SVG/scriptable content can't execute same-origin.
const SAFE_IMAGE_TYPE = /^image\/(jpeg|jpg|png|webp|gif|tiff?|bmp|avif)$/i;

// SSRF guard: canonical implementation lives in packages/core/src/ssrf.js
// (shared with the c2pa-verify-api Worker). Pages Functions bundle relative
// imports with esbuild — verified with `wrangler pages dev` — and
// scripts/stage-site.sh stages packages/core/src/ssrf.js into the deploy tree
// so this exact relative path resolves there too. Do NOT inline a copy here;
// the two must never diverge.
import { isBlockedHost } from '../../packages/core/src/ssrf.js';

function json(data, status) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
        },
    });
}

export async function onRequestGet(context) {
    const target = new URL(context.request.url).searchParams.get('url');
    if (!target) return json({ error: 'missing url parameter' }, 400);

    let upstream;
    try {
        upstream = new URL(target);
    } catch {
        return json({ error: 'invalid url' }, 400);
    }
    if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
        return json({ error: 'only http(s) urls are allowed' }, 400);
    }
    if (isBlockedHost(upstream.hostname)) {
        return json({ error: 'host not allowed' }, 403);
    }

    const headers = { ...BROWSER_HEADERS };
    headers['Referer'] = `${upstream.protocol}//${upstream.host}/`;

    let upstreamResp;
    try {
        upstreamResp = await fetch(upstream.toString(), {
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
    } catch (e) {
        return json({ error: `upstream fetch failed: ${e.message}` }, 502);
    }

    if (!upstreamResp.ok) {
        return json({ error: `upstream returned HTTP ${upstreamResp.status}` }, 502);
    }

    const contentLength = Number(upstreamResp.headers.get('content-length') || 0);
    if (contentLength > MAX_BYTES) {
        return json({ error: 'image exceeds size limit' }, 413);
    }

    // content-length may be absent or wrong (chunked responses), so also
    // count bytes as they stream and abort once the cap is exceeded.
    let received = 0;
    const limiter = new TransformStream({
        transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > MAX_BYTES) {
                controller.error(new Error('image exceeds size limit'));
                return;
            }
            controller.enqueue(chunk);
        },
    });

    const rawType = (upstreamResp.headers.get('content-type') || '')
        .split(';')[0].trim().toLowerCase();
    const safeType = SAFE_IMAGE_TYPE.test(rawType) ? rawType : 'application/octet-stream';

    const outHeaders = new Headers();
    outHeaders.set('content-type', safeType);
    outHeaders.set('access-control-allow-origin', '*');
    outHeaders.set('cache-control', 'public, max-age=3600');
    outHeaders.set('x-content-type-options', 'nosniff');
    outHeaders.set('content-disposition', 'attachment');
    outHeaders.set('content-security-policy', 'sandbox');

    const body = upstreamResp.body
        ? upstreamResp.body.pipeThrough(limiter)
        : null;
    return new Response(body, { status: 200, headers: outHeaders });
}

export function onRequest() {
    return json({ error: 'method not allowed' }, 405);
}
