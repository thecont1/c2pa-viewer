// Queue consumer for asynchronous verification jobs. One consumer handles
// three message families on c2pa-verify-jobs:
//   {type:'job'}                    — URL-input job accepted by POST /jobs
//   {type:'webhook'}                — terminal callback delivery attempt
//   R2 object-create event object   — direct upload completed in uploads/

import { toApiResult } from '../../packages/core/src/index.js';
import { resolveMime } from './verify.js';
import { MAX_JOB_BYTES, problemPayload, jobPayload, getJobRow } from './jobs.js';
import { TRUST_ANCHORS } from './trust-info.js';
import { isBlockedHost } from '../../packages/core/src/ssrf.js';
import { SANDBOX_SHA256 } from './sandbox-hashes.js';

const ENGINE_INFO = { name: 'c2pa-node', version: '0.12.1' };
const PART_BYTES = 8 * 1024 * 1024;
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};
const WEBHOOK_DELAYS = [60, 300, 1800];

function nowIso() { return new Date().toISOString(); }

class TerminalJobError extends Error {
    constructor(status, code, detail, extra = {}) {
        super(detail);
        this.problem = problemPayload(status, code, detail, extra);
    }
}

function terminalFromApiError(e) {
    const msg = e && e.message ? e.message : String(e);
    if (e && e.kind === 'too_large') return new TerminalJobError(413, 'payload_too_large', msg, { max_job_bytes: MAX_JOB_BYTES });
    if (e && e.kind === 'upstream') return new TerminalJobError(502, 'upstream_fetch_failed', msg);
    if (e && e.kind === 'unsupported') return new TerminalJobError(415, 'unsupported_media_type', msg);
    return new TerminalJobError(422, 'invalid_request', msg);
}

// ------------------------------------------------------------- upstream --

async function openUpstream(urlString, env) {
    let current;
    try { current = new URL(urlString); } catch {
        throw new TerminalJobError(422, 'invalid_request', 'url is not a valid URL');
    }
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new TerminalJobError(422, 'invalid_request', 'only http(s) urls are allowed');
    }

    const allowLocal = env.ALLOW_LOCAL_UPSTREAM === '1';
    for (let hop = 0; hop <= 5; hop++) {
        if (!allowLocal && isBlockedHost(current.hostname)) {
            throw new TerminalJobError(422, 'invalid_request', `host not allowed: ${current.hostname}`);
        }
        let resp;
        try {
            resp = await fetch(current.toString(), {
                headers: { ...BROWSER_HEADERS, Referer: `${current.protocol}//${current.host}/` },
                redirect: 'manual',
                signal: AbortSignal.timeout(5 * 60 * 1000),
            });
        } catch (e) {
            throw new TerminalJobError(502, 'upstream_fetch_failed', `upstream fetch failed: ${e && e.message ? e.message : String(e)}`);
        }
        if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
            try { current = new URL(resp.headers.get('location'), current); } catch {
                throw new TerminalJobError(502, 'upstream_fetch_failed', 'upstream redirect target is not a valid URL');
            }
            if (current.protocol !== 'http:' && current.protocol !== 'https:') {
                throw new TerminalJobError(502, 'upstream_fetch_failed', 'upstream redirected to a non-http(s) URL');
            }
            if (hop === 5) break;
            continue;
        }
        if (resp.status < 200 || resp.status >= 300) {
            throw new TerminalJobError(502, 'upstream_fetch_failed', `upstream returned HTTP ${resp.status}`);
        }
        return { resp, finalUrl: current.toString() };
    }
    throw new TerminalJobError(502, 'upstream_fetch_failed', 'too many redirects (max 5)');
}

// Stream an upstream response into R2 through multipart upload. R2 requires
// known-length streams; buffering one uniform 8 MiB part at a time keeps the
// Worker's memory bounded while supporting chunked/no-content-length upstreams.
async function streamUpstreamToR2(env, key, resp, contentType, capBytes = MAX_JOB_BYTES) {
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > capBytes) {
        try { await resp.body.cancel(); } catch { }
        throw new TerminalJobError(413, 'payload_too_large', `upstream asset exceeds the asynchronous verification cap (content-length ${declared})`, { max_job_bytes: MAX_JOB_BYTES });
    }
    if (!resp.body) throw new TerminalJobError(502, 'upstream_fetch_failed', 'upstream response had no body');

    const upload = await env.JOBS_BUCKET.createMultipartUpload(key, {
        httpMetadata: { contentType: contentType || 'application/octet-stream' },
    });
    const parts = [];
    const reader = resp.body.getReader();
    const buf = new Uint8Array(PART_BYTES);
    let off = 0, total = 0, partNumber = 1;
    const head = new Uint8Array(12);
    let headLen = 0;

    async function flushPart() {
        if (off === 0) return;
        const bytes = buf.slice(0, off);
        parts.push(await upload.uploadPart(partNumber++, bytes));
        off = 0;
    }

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            let pos = 0;
            total += value.byteLength;
            if (total > capBytes) {
                try { await reader.cancel(); } catch { }
                throw new TerminalJobError(413, 'payload_too_large', 'asset exceeds the 1 GiB asynchronous verification cap', { max_job_bytes: MAX_JOB_BYTES });
            }
            const headNeed = Math.min(12 - headLen, value.byteLength);
            if (headNeed > 0) { head.set(value.subarray(0, headNeed), headLen); headLen += headNeed; }
            while (pos < value.byteLength) {
                const n = Math.min(PART_BYTES - off, value.byteLength - pos);
                buf.set(value.subarray(pos, pos + n), off);
                off += n; pos += n;
                if (off === PART_BYTES) await flushPart();
            }
        }
        await flushPart();
        if (total === 0) throw new TerminalJobError(422, 'invalid_request', 'asset is empty');
        await upload.complete(parts);
        return { size: total, head: head.slice(0, headLen) };
    } catch (e) {
        try { await upload.abort(); } catch { }
        throw e;
    }
}

// --------------------------------------------------------------- state --

async function claimProcessing(env, row, token) {
    if (row.status === 'processing' && row.processing_token === token) return true;
    if (row.status !== 'queued' && row.status !== 'awaiting_upload') return false;
    const now = nowIso();
    const r = await env.DB.prepare(
        `UPDATE jobs SET status='processing', processing_token=?, updated_at=? WHERE job_id=? AND status=?`
    ).bind(token, now, row.job_id, row.status).run();
    return (r.meta && r.meta.changes) === 1;
}

async function incrementUsageBytes(env, keyId, bytes) {
    if (!bytes) return;
    try {
        await env.DB.prepare('UPDATE usage SET bytes_total = bytes_total + ?, updated_at = ? WHERE key_id = ? AND month = ?')
            .bind(bytes, nowIso(), keyId, new Date().toISOString().slice(0, 7)).run();
    } catch (e) { console.error('usage byte increment failed:', e); }
}

async function maybeEnqueueWebhook(env, row) {
    if (!row.webhook_url || row.webhook_enqueued_at) return;
    if (row.status !== 'succeeded' && row.status !== 'failed') return;
    await env.JOBS_QUEUE.send({ type: 'webhook', job_id: row.job_id, attempt: 1 });
    await env.DB.prepare('UPDATE jobs SET webhook_enqueued_at=?, updated_at=? WHERE job_id=?')
        .bind(nowIso(), nowIso(), row.job_id).run();
    row.webhook_enqueued_at = nowIso();
}

async function finishJob(env, row, terminal, resultOrError, sizeBytes) {
    const now = nowIso();
    if (terminal === 'succeeded') {
        await env.JOBS_BUCKET.put(`results/${row.job_id}.json`, JSON.stringify(resultOrError), {
            httpMetadata: { contentType: 'application/json' },
        });
        await env.DB.prepare(
            `UPDATE jobs SET status='succeeded', error=NULL, size_bytes=?, processing_token=NULL, updated_at=?, completed_at=? WHERE job_id=?`
        ).bind(sizeBytes ?? row.size_bytes ?? null, now, now, row.job_id).run();
    } else {
        await env.DB.prepare(
            `UPDATE jobs SET status='failed', error=?, size_bytes=?, processing_token=NULL, updated_at=?, completed_at=? WHERE job_id=?`
        ).bind(JSON.stringify(resultOrError), sizeBytes ?? row.size_bytes ?? null, now, now, row.job_id).run();
    }
    row.status = terminal;
    row.completed_at = now;
    row.size_bytes = sizeBytes ?? row.size_bytes ?? null;
    await maybeEnqueueWebhook(env, row);
}

async function objectHeadBytes(env, key) {
    const obj = await env.JOBS_BUCKET.get(key, { range: { length: 12 } });
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
}

function trustTransferJson() {
    // Transfer settings, not a baked image artifact: the container reconstructs
    // core's trust anchors from this JSON and core then builds the two c2pa-rs
    // settings objects needed for C2PA-only and C2PA+ITL reads.
    return JSON.stringify({
        version: 1,
        trust: {
            c2pa_anchors: TRUST_ANCHORS.c2pa,
            itl_anchors: TRUST_ANCHORS.itl,
            trust_config: TRUST_ANCHORS.config,
        },
        trust_meta: TRUST_ANCHORS.meta,
    });
}

async function invokeRunner(env, row, mime, filename, version = {}) {
    const id = env.JOB_RUNNER.idFromName(row.job_id);
    const stub = env.JOB_RUNNER.get(id);
    const payload = {
        job_id: row.job_id,
        object_key: row.object_key,
        mime,
        filename,
        trust_profile: row.trust || 'c2pa_and_itl',
        settings: trustTransferJson(),
        // Object-version evidence the metadata/sniff reads were taken from.
        // A presigned PUT can be reused, replacing the object between those
        // reads and the runner's later GET; the runner refuses to verify a
        // replaced object so the result never mixes versions.
        expected_size: version.size ?? null,
        expected_etag: version.etag ?? null,
    };
    return stub.fetch('https://job-runner/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

async function processJob(env, jobId, token) {
    let row = await getJobRow(env.DB, jobId);
    if (!row) return;
    if (row.status === 'succeeded' || row.status === 'failed') {
        await maybeEnqueueWebhook(env, row); // recovery when terminal commit succeeded but enqueue failed
        return;
    }
    if (!(await claimProcessing(env, row, token))) return;
    row = await getJobRow(env.DB, jobId);
    const source = JSON.parse(row.source || '{}');
    const filename = source.filename || 'image';

    let sizeBytes = row.size_bytes || 0;
    try {
        let head;
        let declaredMime = source.mime || '';
        // Object-version evidence for the runner binding. The direct-upload
        // object can be replaced by presigned-PUT reuse between these metadata
        // reads and the runner's GET, so its etag is captured here; the url
        // path object is written once by this consumer and cannot have
        // pre-existed, so the size check alone binds it.
        let objectEtag = null;
        if (source.url) {
            const upstream = await openUpstream(source.url, env);
            const upstreamType = (upstream.resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            if (!declaredMime) declaredMime = upstreamType;
            const stored = await streamUpstreamToR2(env, row.object_key, upstream.resp, upstreamType, row.cap_bytes || MAX_JOB_BYTES);
            sizeBytes = stored.size;
            head = stored.head;
        } else {
            const meta = await env.JOBS_BUCKET.head(row.object_key);
            if (!meta) throw new TerminalJobError(422, 'invalid_request', 'uploaded object is missing');
            objectEtag = meta.etag || null;
            sizeBytes = meta.size;
            if (sizeBytes > MAX_JOB_BYTES) {
                throw new TerminalJobError(413, 'payload_too_large', 'asset exceeds the 1 GiB asynchronous verification cap', { max_job_bytes: MAX_JOB_BYTES });
            }
            head = await objectHeadBytes(env, row.object_key);
            if (!declaredMime) declaredMime = (meta.httpMetadata && meta.httpMetadata.contentType) || '';
        }
        if (!sizeBytes) throw new TerminalJobError(422, 'invalid_request', 'asset is empty');

        // Test-key corpus boundary, checked BEFORE the expensive container run
        // (the sync path does the same at verify.js). Every corpus fixture is
        // far below 20 MiB, so anything larger can never match and fails fast;
        // small objects are hashed directly from R2. The post-analysis check
        // below stays as the belt-and-braces enforcement on the result path.
        const keyRowPre = await env.DB.prepare('SELECT display_prefix FROM keys WHERE id = ?').bind(row.key_id).first();
        const isTestKey = keyRowPre && typeof keyRowPre.display_prefix === 'string' && keyRowPre.display_prefix.startsWith('c2pa_test_');
        if (isTestKey) {
            const MAX_CORPUS_BYTES = 20 * 1024 * 1024;
            if (sizeBytes > MAX_CORPUS_BYTES) {
                throw new TerminalJobError(403, 'forbidden', 'test keys only accept the fixture corpus');
            }
            const obj = await env.JOBS_BUCKET.get(row.object_key);
            if (!obj) throw new TerminalJobError(422, 'invalid_request', 'uploaded object is missing');
            const digest = await crypto.subtle.digest('SHA-256', await obj.arrayBuffer());
            const hexDigest = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
            if (!SANDBOX_SHA256.has(hexDigest)) {
                throw new TerminalJobError(403, 'forbidden', 'test keys only accept the fixture corpus');
            }
        }

        let mime;
        try { mime = resolveMime(head || new Uint8Array(), declaredMime, filename); }
        catch (e) { throw terminalFromApiError(e); }

        const resp = await invokeRunner(env, row, mime, filename, { size: sizeBytes, etag: objectEtag });
        const text = await resp.text();
        let analysis = null;
        try { analysis = JSON.parse(text); } catch { }
        if (resp.status === 409) {
            // Object version changed underneath the job (presigned-PUT reuse).
            // Retryable: once the client stops rewriting, a later attempt binds
            // to the final version.
            throw new Error(`object version mismatch for ${row.object_key}: ${text.slice(0, 200)}`);
        }
        if (resp.status === 422) {
            throw new TerminalJobError(422, 'invalid_request', (analysis && analysis.error) || 'the asset could not be read — corrupt or unparseable input');
        }
        if (resp.status === 413) {
            throw new TerminalJobError(413, 'payload_too_large', (analysis && analysis.error) || 'asset exceeds the 1 GiB asynchronous verification cap', { max_job_bytes: MAX_JOB_BYTES });
        }
        if (!resp.ok || !analysis) {
            throw new Error(`container verification failed: HTTP ${resp.status} ${text.slice(0, 300)}`);
        }

        // Preserve the test-key corpus boundary on the async surface. The hash
        // only exists after analysis, so non-corpus input becomes a terminal
        // forbidden failure and the result is never stored or exposed.
        const keyRow = await env.DB.prepare('SELECT display_prefix FROM keys WHERE id = ?').bind(row.key_id).first();
        const isTest = keyRow && typeof keyRow.display_prefix === 'string' && keyRow.display_prefix.startsWith('c2pa_test_');
        if (isTest && !(analysis.asset && SANDBOX_SHA256.has(analysis.asset.sha256))) {
            throw new TerminalJobError(403, 'forbidden', 'test keys only accept the fixture corpus');
        }

        const result = toApiResult(analysis, {
            id: `ver_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
            engine: ENGINE_INFO,
            include: (row.include || 'exif,iptc').split(',').map((s) => s.trim()).filter(Boolean),
            strip_gps: row.strip_gps !== 0,
        });
        await finishJob(env, row, 'succeeded', result, sizeBytes);
        if (!isTest) await incrementUsageBytes(env, row.key_id, sizeBytes);
    } catch (e) {
        if (e instanceof TerminalJobError) {
            await finishJob(env, row, 'failed', e.problem, sizeBytes || null);
            return;
        }
        throw e;
    }
}

// -------------------------------------------------------------- webhook --

function hex(bytes) { return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join(''); }

async function signWebhook(secret, body, t) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`)));
}

async function postWebhook(urlString, body, signature) {
    let current = new URL(urlString);
    for (let hop = 0; hop <= 3; hop++) {
        if (isBlockedHost(current.hostname)) throw new Error(`webhook host not allowed: ${current.hostname}`);
        const resp = await fetch(current.toString(), {
            method: 'POST',
            redirect: 'manual',
            headers: { 'content-type': 'application/json', 'x-c2pa-signature': signature },
            body,
            signal: AbortSignal.timeout(30000),
        });
        if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
            // Release the body before following the redirect — an unconsumed
            // body holds the connection and resources open.
            try { await resp.body.cancel(); } catch { }
            current = new URL(resp.headers.get('location'), current);
            if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('webhook redirected to non-http(s) URL');
            continue;
        }
        // Only the status is used. Cancel rather than buffer: a receiver that
        // answers 2xx with a huge body must not be able to exhaust the Worker
        // memory limit after accepting the callback.
        try { await resp.body.cancel(); } catch { }
        return resp.status;
    }
    throw new Error('webhook redirected too many times');
}

async function processWebhook(env, message, body) {
    const row = await getJobRow(env.DB, body.job_id);
    if (!row || !row.webhook_url || (row.status !== 'succeeded' && row.status !== 'failed')) return;
    const payload = {
        // api/openapi.yaml is authoritative here: even terminal failures are
        // delivered as the single documented webhook event name job.completed.
        event: 'job.completed',
        job: await jobPayload(env, row),
    };
    const raw = JSON.stringify(payload);
    const t = Math.floor(Date.now() / 1000);
    if (!env.WEBHOOK_SIGNING_SECRET) throw new Error('WEBHOOK_SIGNING_SECRET is not configured');
    const sig = `t=${t},v1=${await signWebhook(env.WEBHOOK_SIGNING_SECRET, raw, t)}`;

    let status = 0, error = null;
    try { status = await postWebhook(row.webhook_url, raw, sig); }
    catch (e) { error = e && e.message ? e.message : String(e); }
    if (status >= 200 && status < 300) return;

    const attempt = Number(body.attempt || 1);
    const last = { status, error, at: nowIso() };
    if (attempt < 4) {
        await env.JOBS_QUEUE.send({ type: 'webhook', job_id: row.job_id, attempt: attempt + 1 }, {
            delaySeconds: WEBHOOK_DELAYS[attempt - 1] || 1800,
        });
    } else if (env.JOBS_DLQ) {
        await env.JOBS_DLQ.send({ type: 'webhook', job_id: row.job_id, attempt, last_error: last });
    }
}

async function handleMessage(env, message) {
    const body = message.body;
    if (body && body.type === 'job' && typeof body.job_id === 'string') {
        await processJob(env, body.job_id, message.id);
        return;
    }
    if (body && body.type === 'webhook' && typeof body.job_id === 'string') {
        await processWebhook(env, message, body);
        return;
    }
    // R2 event notification shape: {action,bucket,object:{key,size,...}}.
    if (body && body.object && typeof body.object.key === 'string') {
        const key = body.object.key;
        if (!key.startsWith('uploads/')) return;
        const jobId = key.slice('uploads/'.length).split('/')[0];
        if (!jobId) return;
        if (body.object.size > MAX_JOB_BYTES) {
            const row = await getJobRow(env.DB, jobId);
            if (row && (row.status === 'succeeded' || row.status === 'failed')) {
                // Recovery path: a previous delivery committed the terminal row
                // but failed before scheduling the webhook.
                await maybeEnqueueWebhook(env, row);
                return;
            }
            if (row && row.status === 'awaiting_upload') {
                // Conditional transition: a valid replacement upload may claim
                // and complete the job concurrently. Only fail the job when the
                // row is still awaiting_upload — never clobber a terminal state
                // — and schedule the webhook only when this update won.
                const problem413 = problemPayload(413, 'payload_too_large', 'asset exceeds the 1 GiB asynchronous verification cap', { max_job_bytes: MAX_JOB_BYTES });
                const now = nowIso();
                const r = await env.DB.prepare(
                    `UPDATE jobs SET status='failed', error=?, size_bytes=?, processing_token=NULL, updated_at=?, completed_at=? WHERE job_id=? AND status='awaiting_upload'`
                ).bind(JSON.stringify(problem413), body.object.size, now, now, row.job_id).run();
                if ((r.meta && r.meta.changes) === 1) {
                    row.status = 'failed';
                    row.completed_at = now;
                    row.size_bytes = body.object.size;
                    await maybeEnqueueWebhook(env, row);
                }
            }
            return;
        }
        await processJob(env, jobId, message.id);
    }
}

export async function jobsQueueHandler(batch, env) {
    for (const message of batch.messages) {
        try {
            await handleMessage(env, message);
            message.ack();
        } catch (e) {
            console.error('queue message failed:', e && e.stack ? e.stack : e);
            const body = message.body || {};
            // Resolve the job for both verification message families — the
            // direct-upload R2 notification carries object.key, not job_id —
            // while webhook deliveries stay out of this path entirely.
            let failedJobId = null;
            if (body.type === 'job' && typeof body.job_id === 'string') failedJobId = body.job_id;
            else if (body.object && typeof body.object.key === 'string' && body.object.key.startsWith('uploads/')) {
                failedJobId = body.object.key.slice('uploads/'.length).split('/')[0] || null;
            }
            if (failedJobId && message.attempts >= 4) {
                try {
                    const row = await getJobRow(env.DB, failedJobId);
                    // Conditional on this message still owning the processing
                    // token: without it, an exhausted redelivery could fail a
                    // job another delivery has since legitimately claimed.
                    if (row && row.status === 'processing' && row.processing_token === message.id) {
                        await finishJob(env, row, 'failed', problemPayload(500, 'internal_error', 'job processing failed after repeated attempts'), row.size_bytes || null);
                    }
                } catch (inner) { console.error('terminal failure update failed:', inner); }
            }
            message.retry({ delaySeconds: 30 });
        }
    }
}
