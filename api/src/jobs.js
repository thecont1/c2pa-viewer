// Async verification job API — POST /v1/jobs and GET /v1/jobs/{job_id}.
// The heavy pipeline itself lives in jobs-consumer.js; this module owns the
// request/response contract, validation, persistence and idempotency.

import { AwsClient } from 'aws4fetch';
import { ApiError, problem, buildProblemPayload } from './errors.js';
import { parseInclude, parseTrust, parseStripGps, apiErrorResponse, displayNameFromUrl } from './verify.js';
import { validateAssetUrl } from './urlfetch.js';
import { isBlockedHost } from '../../packages/core/src/ssrf.js';
import { chargeQuota } from './quota.js';

export const MAX_JOB_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const JOB_BUCKET = 'c2pa-verify-jobs';
const UPLOAD_EXPIRY_SECONDS = 3600;
const JOB_CREATE_FIELDS = new Set(['url', 'filename', 'mime', 'size_bytes', 'webhook_url', 'include', 'trust', 'strip_gps']);

function nowIso() { return new Date().toISOString(); }

// Stored job errors are problem+json payloads (not Responses); the factory is
// shared with errors.js so a title/type change reaches both polling and REST
// error responses.
export function problemPayload(status, code, detail, extra = {}) {
    return buildProblemPayload(status, code, detail, extra);
}

function validateHttpCallback(urlString, field, env) {
    let url;
    try { url = new URL(urlString); } catch {
        throw new ApiError('invalid', `${field} is not a valid URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ApiError('invalid', `${field} must be an http(s) URL`);
    }
    if (env.ALLOW_LOCAL_UPSTREAM !== '1' && isBlockedHost(url.hostname)) {
        throw new ApiError('ssrf', `${field} host not allowed: ${url.hostname}`);
    }
    return url.toString();
}

// Validate and normalize the JobCreate body. Throws ApiError with the same
// kind mapping used by /v1/verify so REST errors stay consistent.
export function validateJobCreate(body, env) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError('invalid', 'JSON body must be an object');
    }
    for (const key of Object.keys(body)) {
        if (!JOB_CREATE_FIELDS.has(key)) throw new ApiError('invalid', `unknown field: ${key}`);
    }

    let url = null;
    if (body.url !== undefined && body.url !== null) {
        if (typeof body.url !== 'string') throw new ApiError('invalid', 'url must be a string');
        url = validateAssetUrl(body.url, env).toString();
    }
    if (body.filename !== undefined && typeof body.filename !== 'string') {
        throw new ApiError('invalid', 'filename must be a string');
    }
    if (body.mime !== undefined && typeof body.mime !== 'string') {
        throw new ApiError('invalid', 'mime must be a string');
    }

    const mime = typeof body.mime === 'string' && body.mime.trim()
        ? body.mime.trim().toLowerCase()
        : null;
    if (mime && !mime.startsWith('image/') && mime !== 'application/octet-stream') {
        throw new ApiError('unsupported', `declared content-type is not an image type: ${mime}`);
    }

    let sizeBytes = null;
    if (body.size_bytes !== undefined && body.size_bytes !== null) {
        if (!Number.isInteger(body.size_bytes) || body.size_bytes < 0) {
            throw new ApiError('invalid', 'size_bytes must be a non-negative integer');
        }
        sizeBytes = body.size_bytes;
        if (sizeBytes > MAX_JOB_BYTES) {
            throw new ApiError('too_large', 'asset exceeds the 1 GiB asynchronous verification cap');
        }
    }

    let webhookUrl = null;
    if (body.webhook_url !== undefined && body.webhook_url !== null) {
        if (typeof body.webhook_url !== 'string') throw new ApiError('invalid', 'webhook_url must be a string');
        webhookUrl = validateHttpCallback(body.webhook_url, 'webhook_url', env);
    }

    const include = parseInclude(body.include).join(',');
    const trust = parseTrust(body.trust);
    const stripGps = parseStripGps(body.strip_gps);

    const filename = body.filename || (url ? displayNameFromUrl(url) : 'image');
    return {
        url,
        filename,
        mime,
        size_bytes: sizeBytes,
        webhook_url: webhookUrl,
        include,
        trust,
        strip_gps: stripGps,
        source: {
            ...(url ? { url } : {}),
            filename,
            ...(mime ? { mime } : {}),
            ...(sizeBytes !== null ? { size_bytes: sizeBytes } : {}),
        },
    };
}

export async function getJobRow(db, jobId) {
    return db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first();
}

async function jobRowByIdempotency(db, keyId, idempotencyKey) {
    if (!idempotencyKey) return null;
    return db.prepare('SELECT * FROM jobs WHERE key_id = ? AND idempotency_key = ? ORDER BY created_at LIMIT 1')
        .bind(keyId, idempotencyKey).first();
}

function r2SigningClient(env) {
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return null;
    // Lazily construct the signer only on the direct-upload path. No signing
    // client is needed for URL jobs or for any container/consumer operation.
    if (!r2SigningClient.cache) {
        r2SigningClient.cache = new AwsClient({
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            service: 's3',
            region: 'auto',
        });
    }
    return r2SigningClient.cache;
}

async function createUploadUrl(env, jobId, mime) {
    const client = r2SigningClient(env);
    const accountId = env.R2_ACCOUNT_ID;
    if (!client || !accountId) {
        throw new ApiError('not_configured', 'direct upload not yet configured');
    }
    const contentType = mime || 'application/octet-stream';
    const endpoint = new URL(`https://${accountId}.r2.cloudflarestorage.com/${JOB_BUCKET}/uploads/${encodeURIComponent(jobId)}`);
    endpoint.searchParams.set('X-Amz-Expires', String(UPLOAD_EXPIRY_SECONDS));
    const signed = await client.sign(endpoint.toString(), {
        method: 'PUT',
        headers: { 'content-type': contentType },
        aws: { signQuery: true, allHeaders: true },
    });
    return {
        url: String(signed.url),
        method: 'PUT',
        headers: { 'content-type': contentType },
        expires_at: new Date(Date.now() + UPLOAD_EXPIRY_SECONDS * 1000).toISOString(),
    };
}

async function jobCreatedPayload(env, row) {
    const source = JSON.parse(row.source || '{}');
    const upload = source.url ? null : await createUploadUrl(env, row.job_id, source.mime);
    return {
        job_id: row.job_id,
        status: source.url ? 'queued' : 'awaiting_upload',
        upload,
    };
}

// Shared REST/MCP creation path. Returns { statusCode, payload, row }.
export async function createJobRecord(env, keyRow, keyKind, body, idempotencyKey) {
    const input = validateJobCreate(body, env);
    const idem = idempotencyKey && idempotencyKey.trim() ? idempotencyKey.trim().slice(0, 255) : null;

    if (idem) {
        const existing = await jobRowByIdempotency(env.DB, keyRow.id, idem);
        if (existing) {
            return { statusCode: 200, payload: await jobCreatedPayload(env, existing), row: existing, idempotentReplay: true };
        }
    }

    // Fail fast before persisting an upload job when the optional R2 signing
    // credentials have not been configured yet.
    if (!input.url) await createUploadUrl(env, 'probe', input.mime);

    // Quota is enforced here — after the idempotent replay check above, never
    // in middleware: a replayed creation must recover the original job even
    // when the key has since reached its quota. New submissions still cannot
    // start once the quota is exhausted.
    let charged = true;
    if (keyKind !== 'test') {
        try {
            charged = await chargeQuota(env, keyRow, 0);
        } catch (e) {
            console.error('quota charge failed:', e);
            throw new ApiError('internal', 'Usage store unavailable.');
        }
    }
    if (!charged) throw new ApiError('quota', `Monthly quota of ${keyRow.quota_monthly} verifications exhausted.`);

    const jobId = `job_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const objectKey = `uploads/${jobId}`;
    const now = nowIso();
    const status = input.url ? 'queued' : 'awaiting_upload';

    // The submission charge was already counted atomically by the QuotaCounter
    // DO above (which also writes the usage ledger); the job row insert stands
    // alone. A batch failure here means an orphaned charge without a job —
    // under-counting in the customer's favor, accepted over the reverse.
    // Bytes are added when the real object size is known; refund-on-failure
    // does not exist yet. Test keys are never charged.
    const insertStmt = env.DB.prepare(
        `INSERT INTO jobs (job_id,key_id,status,idempotency_key,source,webhook_url,include,trust,strip_gps,error,object_key,size_bytes,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
        jobId, keyRow.id, status, idem, JSON.stringify(input.source), input.webhook_url,
        input.include, input.trust, input.strip_gps ? 1 : 0, null, objectKey, input.size_bytes, now, now
    );
    let row;
    try {
        await env.DB.batch([insertStmt]);
    } catch (e) {
        if (idem) {
            const existing = await jobRowByIdempotency(env.DB, keyRow.id, idem);
            if (existing) {
                return { statusCode: 200, payload: await jobCreatedPayload(env, existing), row: existing, idempotentReplay: true };
            }
        }
        throw e;
    }

    row = await getJobRow(env.DB, jobId);
    if (input.url) {
        try {
            await env.JOBS_QUEUE.send({ type: 'job', job_id: jobId });
        } catch (e) {
            // Never delete the row after creation: a concurrent idempotent
            // replay may already have acknowledged it, and deleting would leave
            // that caller polling a 404. Mark it terminally failed instead.
            try {
                await env.DB.prepare(
                    `UPDATE jobs SET status='failed', error=?, updated_at=?, completed_at=? WHERE job_id=? AND status='queued'`
                ).bind(
                    JSON.stringify(problemPayload(500, 'internal_error', 'job dispatch failed')),
                    nowIso(), nowIso(), jobId
                ).run();
            } catch { }
            throw e;
        }
    }

    return { statusCode: 202, payload: await jobCreatedPayload(env, row), row, idempotentReplay: false };
}

export async function createJobHandler(c) {
    const ct = (c.req.header('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') {
        return problem(415, 'unsupported_media_type', { detail: `unsupported request content-type: ${ct || '(none)'} — use application/json` });
    }
    let body;
    try { body = await c.req.json(); } catch {
        return problem(422, 'invalid_request', { detail: 'malformed JSON body' });
    }
    try {
        const created = await createJobRecord(
            c.env, c.get('keyRow'), c.get('keyKind'), body, c.req.header('idempotency-key')
        );
        return Response.json(created.payload, { status: created.statusCode });
    } catch (e) {
        if (e instanceof ApiError) {
            if (e.kind === 'not_configured') {
                return problem(503, 'internal_error', { detail: 'direct upload not yet configured' });
            }
            if (e.kind === 'too_large') {
                return problem(413, 'payload_too_large', {
                    detail: 'The asset exceeds the 1 GiB asynchronous verification cap.',
                    max_job_bytes: MAX_JOB_BYTES,
                });
            }
            return apiErrorResponse(e);
        }
        throw e;
    }
}

// Assemble the public Job object. Reads the stored VerifyResult only for a
// succeeded job; error is the stored problem+json object for a failed job.
export async function jobPayload(env, row) {
    const out = {
        job_id: row.job_id,
        status: row.status,
        created_at: row.created_at,
        completed_at: row.completed_at || null,
    };
    if (row.status === 'succeeded') {
        const obj = await env.JOBS_BUCKET.get(`results/${row.job_id}.json`);
        if (!obj) throw new Error(`missing result object for job ${row.job_id}`);
        out.result = await obj.json();
    }
    if (row.status === 'failed' && row.error) {
        try { out.error = JSON.parse(row.error); } catch {
            out.error = problemPayload(500, 'internal_error', 'job failed');
        }
    }
    return out;
}

export async function getJobHandler(c) {
    const jobId = c.req.param('job_id');
    const row = await getJobRow(c.env.DB, jobId);
    if (!row || row.key_id !== c.get('keyRow').id) {
        return problem(404, 'job_not_found', { detail: 'Job not found.' });
    }
    return Response.json(await jobPayload(c.env, row));
}
