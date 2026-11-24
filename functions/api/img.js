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

// Basic SSRF guard: refuse loopback, private and link-local targets.
const BLOCKED_HOST = /^(localhost|.*\.localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata\.google\.internal|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i;

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
    if (BLOCKED_HOST.test(upstream.hostname)) {
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

    const outHeaders = new Headers();
    const contentType = upstreamResp.headers.get('content-type');
    if (contentType) outHeaders.set('content-type', contentType);
    outHeaders.set('access-control-allow-origin', '*');
    outHeaders.set('cache-control', 'public, max-age=3600');

    return new Response(upstreamResp.body, { status: 200, headers: outHeaders });
}

export function onRequest() {
    return json({ error: 'method not allowed' }, 405);
}
