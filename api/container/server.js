// Plain Node HTTP verification server for the Cloudflare job container.

import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { analyzeBytes } from './core/src/index.js';
import { nodeEngine } from './engine-node.js';

const MAX_BYTES = 1024 * 1024 * 1024;
const ANALYZE_TIMEOUT_MS = 8 * 60 * 1000;

function json(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

function countingTransform(limit, onCount) {
    let count = 0;
    return new Transform({
        transform(chunk, encoding, callback) {
            count += chunk.length;
            onCount(count);
            if (count > limit) callback(new Error('asset exceeds the 1 GiB asynchronous verification cap'));
            else callback(null, chunk);
        },
    });
}

function trustAnchorsFromHeader(raw) {
    if (!raw) return null;
    const transfer = JSON.parse(raw);
    const trust = transfer.trust || {};
    return {
        c2pa: trust.c2pa_anchors || '',
        itl: trust.itl_anchors || '',
        config: trust.trust_config || '',
        meta: transfer.trust_meta || {},
    };
}

async function analyzeWithTimeout(args) {
    return Promise.race([
        analyzeBytes(args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('analysis timed out')), ANALYZE_TIMEOUT_MS)),
    ]);
}

async function verify(req, res) {
    const mime = req.headers['x-mime'] || 'image/jpeg';
    const filename = decodeURIComponent(req.headers['x-filename'] || 'image');
    const trustProfile = req.headers['x-trust-profile'] || 'c2pa_and_itl';
    let anchors = null;
    try { anchors = trustAnchorsFromHeader(req.headers['x-c2pa-settings'] || ''); }
    catch { return json(res, 400, { error: 'invalid x-c2pa-settings JSON' }); }
    if (!anchors) return json(res, 400, { error: 'missing x-c2pa-settings' });

    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BYTES) return json(res, 413, { error: 'asset exceeds the 1 GiB asynchronous verification cap' });

    const tmp = `/tmp/c2pa-asset-${randomUUID()}`;
    let size = 0;
    try {
        // Spool and read failures are container-local I/O problems, not asset
        // problems — a 422 would terminally fail the job with no retry. They
        // surface as 500 so the consumer treats the attempt as retryable.
        try {
            await pipeline(req, countingTransform(MAX_BYTES, (n) => { size = n; }), createWriteStream(tmp));
        } catch (e) {
            if (e && /1 GiB/.test(e.message || '')) throw e;
            console.error('spool failed:', e && e.stack ? e.stack : e);
            return json(res, 500, { error: 'temporary file spool failed' });
        }
        if (size === 0) return json(res, 422, { error: 'asset is empty' });
        // Required shape: ephemeral-disk spool first, then one full in-memory read.
        // standard-1 (4 GiB) leaves headroom for this buffer plus c2pa/exifr copies.
        let bytes;
        try {
            bytes = await readFile(tmp);
        } catch (e) {
            console.error('spool read failed:', e && e.stack ? e.stack : e);
            return json(res, 500, { error: 'temporary file read failed' });
        }
        const analysis = await analyzeWithTimeout({
            bytes,
            mime,
            filename,
            contentType: mime,
            engine: nodeEngine,
            trust: { anchors },
            trustProfile,
            include: { exif: true, c2pa: true },
            strict: true,
        });
        return json(res, 200, analysis);
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (/1 GiB/.test(msg)) return json(res, 413, { error: 'asset exceeds the 1 GiB asynchronous verification cap' });
        if (/timed out/.test(msg)) return json(res, 500, { error: 'analysis timed out' });
        // Reader failures are deliberately clean 422s; internal details stay in logs.
        console.error('verify failed:', e && e.stack ? e.stack : e);
        return json(res, 422, { error: 'the asset could not be read — corrupt or unparseable input' });
    } finally {
        try { await rm(tmp, { force: true }); } catch { }
    }
}

const server = http.createServer({ maxHeaderSize: 512 * 1024 }, (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && req.url === '/verify') {
        verify(req, res).catch((e) => {
            console.error('unhandled verify error:', e && e.stack ? e.stack : e);
            if (!res.headersSent) json(res, 500, { error: 'internal verification error' });
            else res.end();
        });
        return;
    }
    json(res, 404, { error: 'not found' });
});
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.listen(8080, '0.0.0.0', () => console.log('c2pa verify container listening on 8080'));
