#!/usr/bin/env bun
// smoke-jobs.mjs — production Phase 3 async-jobs verification.
//
// Environment:
//   C2PA_SMOKE_KEY_A / C2PA_SMOKE_KEY_B  optional existing live keys
//   C2PA_API_BASE                        default production workers.dev URL
//
// If keys are not supplied, the script creates two temporary remote pro keys
// with keyctl and revokes them in cleanup. It rotates WEBHOOK_SIGNING_SECRET
// to a random test value so the webhook HMAC can be verified independently.
// The r2.dev public window is always closed in cleanup, even on failure.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID, createHmac } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'api');
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');
const BASE = (process.env.C2PA_API_BASE || 'https://c2pa-verify-api.thecontrarian.workers.dev').replace(/\/$/, '');
const BUCKET = 'c2pa-verify-jobs';
// The large fixture is served from a DEDICATED bucket whose only contents are
// test artifacts. Enabling r2.dev on the production jobs bucket (the old flow)
// exposes uploaded user assets and verification results to anyone with the URL.
const FIXTURE_BUCKET = 'c2pa-verify-smoke-fixtures';
const LARGE = join(ROOT, 'fixtures/big/large-signed.jpg');
const SMALL_URL = 'https://thecontrarian.in/library/originals/GHANA/DSCF9243.jpg';
const NOT_FOUND_URL = 'https://thecontrarian.in/library/originals/GHANA/NO-SUCH-PHASE3-SMOKE.jpg';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

let failures = 0;
const rows = [];
const timings = {};
const createdKeyIds = [];
const cleanupFailures = [];
let publicWasEnabled = false;
let webhookSecret = null;
let webhookToken = null;

function row(name, pass, detail = '') {
    rows.push({ name, pass, detail, at: new Date().toISOString() });
    console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!pass) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

// OpenAPI validators, with local component refs rewritten exactly like the
// phase-1 contract test.
const doc = parseYaml(readFileSync(join(ROOT, 'api/openapi.yaml'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ components: { schemas: doc.components.schemas } }, 'spec');
const validateJobCreated = ajv.getSchema('spec#/components/schemas/JobCreated');
const validateJob = ajv.getSchema('spec#/components/schemas/Job');
const validateVerifyResult = ajv.getSchema('spec#/components/schemas/VerifyResult');
function schemaErrors(v) { return JSON.stringify((v.errors || []).slice(0, 4)).slice(0, 500); }

function wrangler(args, { input, cwd = API_DIR } = {}) {
    const res = spawnSync(WRANGLER, args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed:\n${res.stdout}\n${res.stderr}`);
    return res.stdout;
}
function keyctl(args) {
    const res = spawnSync('bun', ['scripts/keyctl.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`keyctl ${args[0]} failed: ${res.stdout}\n${res.stderr}`);
    return {
        key: (res.stdout.match(/^KEY=(.+)$/m) || [])[1],
        id: (res.stdout.match(/^KEY_ID=(.+)$/m) || [])[1],
        out: res.stdout,
    };
}
async function request(method, pathOrUrl, { key, body, headers = {}, timeout = 40000 } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`;
    const h = { 'user-agent': UA, ...headers };
    if (key) h.authorization = `Bearer ${key}`;
    let data;
    if (body !== undefined) {
        if (body instanceof Uint8Array || Buffer.isBuffer(body)) data = body;
        else { data = JSON.stringify(body); h['content-type'] = h['content-type'] || 'application/json'; }
    }
    const resp = await fetch(url, { method, headers: h, body: data, signal: AbortSignal.timeout(timeout) });
    const buf = Buffer.from(await resp.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { }
    return { status: resp.status, headers: resp.headers, json, text: buf.toString('utf8'), bytes: buf };
}
async function createJob(key, body, idempotencyKey = null) {
    return request('POST', '/v1/jobs', {
        key, body,
        headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    });
}
async function getJob(key, jobId) { return request('GET', `/v1/jobs/${jobId}`, { key }); }

async function waitTerminal(key, jobId, timeoutMs, label) {
    const t0 = Date.now();
    const transitions = [];
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
        const r = await getJob(key, jobId);
        const status = r.json && r.json.status;
        if (status !== last) {
            transitions.push({ after_seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), status, http: r.status });
            last = status;
        }
        if (status === 'succeeded' || status === 'failed') {
            return { response: r, transitions, elapsed_seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) };
        }
        await sleep(status === 'processing' ? 4000 : 2000);
    }
    throw new Error(`${label} did not reach a terminal state in ${timeoutMs}ms`);
}

async function createWebhookToken() {
    const r = await fetch('https://webhook.site/token', {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: '{}',
        signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`webhook.site token creation failed: HTTP ${r.status}`);
    const json = await r.json();
    return json.uuid;
}
async function webhookRequests(uuid) {
    const r = await fetch(`https://webhook.site/token/${uuid}/requests?sorting=newest&per_page=20`, {
        headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`webhook.site request listing failed: HTTP ${r.status}`);
    return (await r.json()).data || [];
}
function verifyHookSignature(hook, secret, expectedJobId) {
    const headers = hook.headers || {};
    const sigHeader = (headers['x-c2pa-signature'] || headers['X-C2PA-Signature'] || [])[0];
    if (!sigHeader) return { pass: false, detail: 'missing signature header' };
    const m = String(sigHeader).match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (!m) return { pass: false, detail: `bad signature format ${sigHeader}` };
    const body = hook.content || '';
    const expected = createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex');
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { }
    return {
        pass: expected === m[2]
            && parsed
            && parsed.event === 'job.completed'
            && parsed.job && parsed.job.job_id === expectedJobId
            && validateJob(parsed.job) === true,
        detail: `hmac=${expected === m[2]} event=${parsed && parsed.event} job=${parsed && parsed.job && parsed.job.job_id}`,
        parsed,
    };
}

function compareVerificationFields(syncResult, jobResult) {
    const checks = [
        ['status', syncResult.status, jobResult.status],
        ['validation.state', syncResult.validation && syncResult.validation.state, jobResult.validation && jobResult.validation.state],
        ['asset.sha256', syncResult.asset && syncResult.asset.sha256, jobResult.asset && jobResult.asset.sha256],
        ['asset.bytes', syncResult.asset && syncResult.asset.bytes, jobResult.asset && jobResult.asset.bytes],
        ['asset.width', syncResult.asset && syncResult.asset.width, jobResult.asset && jobResult.asset.width],
        ['asset.height', syncResult.asset && syncResult.asset.height, jobResult.asset && jobResult.asset.height],
        ['claim_generator', syncResult.active_manifest && syncResult.active_manifest.claim_generator, jobResult.active_manifest && jobResult.active_manifest.claim_generator],
    ];
    const bad = checks.filter(([, a, b]) => a !== b);
    return { pass: bad.length === 0, detail: bad.map(([k, a, b]) => `${k}:${a}!=${b}`).join('; ') || checks.map(([k, a]) => `${k}=${a}`).join('; ') };
}

async function connectMcp(key) {
    const client = new Client({ name: 'smoke-jobs-mcp', version: '0.1.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key}`, 'user-agent': UA } },
    });
    await client.connect(transport);
    return client;
}

async function cleanup({ keyA, keyB, largeObjectKey }) {
    // CRITICAL: close the temporary public R2 window no matter how the script exits.
    if (publicWasEnabled) {
        try { wrangler(['r2', 'bucket', 'dev-url', 'disable', FIXTURE_BUCKET]); } catch { }
    }
    if (largeObjectKey) {
        try { wrangler(['r2', 'object', 'delete', `${FIXTURE_BUCKET}/${largeObjectKey}`, '--remote']); } catch { }
    }
    for (const id of createdKeyIds.splice(0)) {
        try {
            const res = spawnSync('bun', ['scripts/keyctl.mjs', 'revoke', '--id', id, '--remote'], { cwd: ROOT, encoding: 'utf8' });
            if (res.status !== 0) {
                // A nonzero revoke leaves the temporary key active remotely:
                // keep it registered, report loudly, and fail the run.
                createdKeyIds.push(id);
                cleanupFailures.push(`keyctl revoke exited ${res.status} for ${id}: ${(res.stderr || res.stdout || '').slice(0, 200)}`);
                console.error(`CLEANUP FAILURE: revoke failed for ${id} — key may still be active`);
            }
        } catch (e) {
            createdKeyIds.push(id);
            cleanupFailures.push(`keyctl revoke threw for ${id}: ${e && e.message ? e.message : e}`);
            console.error(`CLEANUP FAILURE: revoke threw for ${id} — key may still be active`);
        }
    }
}

async function main() {
    if (!existsSync(LARGE)) throw new Error(`missing ${LARGE}; run bun scripts/make-large-fixture.mjs first`);
    let keyA = process.env.C2PA_SMOKE_KEY_A || null;
    let keyB = process.env.C2PA_SMOKE_KEY_B || null;
    if (!keyA || !keyB) {
        // Register each key for cleanup the moment it exists: if the second
        // creation fails, the first must not be left active remotely.
        const a = keyctl(['create', '--name', `phase3-smoke-${Date.now()}-a`, '--type', 'server', '--tier', 'pro', '--remote']);
        keyA = a.key; createdKeyIds.push(a.id);
        const b = keyctl(['create', '--name', `phase3-smoke-${Date.now()}-b`, '--type', 'server', '--tier', 'pro', '--remote']);
        keyB = b.key; createdKeyIds.push(b.id);
        console.log('created temporary remote smoke keys (will revoke in cleanup)');
    }

    // `wrangler secret put` deploys immediately and changes the secret for ALL
    // production jobs — receivers verifying with the previous secret break, and
    // cleanup cannot restore it (secrets are write-only). When the operator
    // supplies the currently-configured secret through C2PA_SMOKE_WEBHOOK_SECRET,
    // no rotation happens at all. Rotation remains the fallback for accounts
    // with no production webhook receivers yet.
    if (process.env.C2PA_SMOKE_WEBHOOK_SECRET) {
        webhookSecret = process.env.C2PA_SMOKE_WEBHOOK_SECRET;
        console.log('using C2PA_SMOKE_WEBHOOK_SECRET as the HMAC verifier (no production secret rotation)');
    } else {
        console.error('WARNING: rotating production WEBHOOK_SIGNING_SECRET for this smoke run —');
        console.error('in-flight production webhook receivers using the previous secret will fail');
        console.error('verification. Set C2PA_SMOKE_WEBHOOK_SECRET to the configured secret to avoid this.');
        webhookSecret = createHash('sha256').update(randomUUID() + Date.now()).digest('hex');
        wrangler(['secret', 'put', 'WEBHOOK_SIGNING_SECRET'], { input: `${webhookSecret}\n` });
        console.log('rotated WEBHOOK_SIGNING_SECRET for independently verifiable smoke delivery');
    }

    let largeObjectKey = null;
    const cleanupArgs = { largeObjectKey: null };
    const onSignal = async () => { await cleanup(cleanupArgs); process.exit(130); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    try {
        const health = await request('GET', '/health');
        row('production worker health', health.status === 200 && health.json && health.json.ok === true, `status=${health.status}`);

        // Optional direct-upload path. In the current account the S3 creds are
        // intentionally absent, so the specified clean 503 is the expected row.
        const direct = await createJob(keyA, { filename: 'DSCF9243.jpg', mime: 'image/jpeg' });
        if (direct.status === 503) {
            row('no-url job without R2 S3 creds → clean 503 direct-upload deferral',
                direct.json && direct.json.code === 'internal_error' && direct.json.detail === 'direct upload not yet configured',
                `status=${direct.status} detail=${direct.json && direct.json.detail}`);
        } else if (direct.status === 202) {
            row('no-url job with configured creds → schema-valid presigned PUT session',
                validateJobCreated(direct.json) === true && direct.json.status === 'awaiting_upload' && direct.json.upload,
                `status=${direct.status}${!validateJobCreated(direct.json) ? ` schema=${schemaErrors(validateJobCreated)}` : ''}`);
            const put = await fetch(direct.json.upload.url, {
                method: 'PUT', headers: direct.json.upload.headers, body: readFileSync(join(ROOT, 'fixtures/DSCF9243.jpg')),
            });
            row('presigned PUT upload accepted by R2 S3 API', put.status >= 200 && put.status < 300, `status=${put.status}`);
            const terminal = await waitTerminal(keyA, direct.json.job_id, 180000, 'direct-upload job');
            row('direct-upload job reaches succeeded through R2 event notification',
                terminal.response.json.status === 'succeeded' && terminal.response.json.result && terminal.response.json.result.status === 'trusted',
                `status=${terminal.response.json.status} elapsed=${terminal.elapsed_seconds}s`);
        } else {
            row('no-url job response is either clean 503 or schema-valid 202', false, `status=${direct.status} body=${direct.text.slice(0, 180)}`);
        }

        // Small library URL job + exact deep-field comparison with sync verify.
        const smallCreate = await createJob(keyA, { url: SMALL_URL, filename: 'DSCF9243.jpg' });
        row('small URL job accepted', smallCreate.status === 202 && validateJobCreated(smallCreate.json) === true && smallCreate.json.upload === null,
            `status=${smallCreate.status} job=${smallCreate.json && smallCreate.json.job_id}`);
        const smallJobId = smallCreate.json && smallCreate.json.job_id;
        const smallTerminal = await waitTerminal(keyA, smallJobId, 180000, 'small URL job');
        timings.small_job_seconds = smallTerminal.elapsed_seconds;
        const smallJob = smallTerminal.response.json;
        row('small URL job queued→processing→succeeded and Job schema-valid',
            smallJob.status === 'succeeded'
            && validateJob(smallJob) === true
            && smallJob.result && validateVerifyResult(smallJob.result) === true
            && smallJob.result.status === 'trusted',
            `transitions=${JSON.stringify(smallTerminal.transitions)} elapsed=${smallTerminal.elapsed_seconds}s${!validateJob(smallJob) ? ` schema=${schemaErrors(validateJob)}` : ''}`);

        const syncVerify = await request('POST', '/v1/verify', { key: keyA, body: { url: SMALL_URL }, timeout: 120000 });
        const cmp = compareVerificationFields(syncVerify.json || {}, (smallJob && smallJob.result) || {});
        row('small job result deep-compares with POST /v1/verify key fields',
            syncVerify.status === 200 && cmp.pass,
            cmp.detail);

        // Ownership isolation: key B must see exactly the same unknown-job 404.
        const foreign = await getJob(keyB, smallJobId);
        row('ownership isolation: second key cannot read first key job',
            foreign.status === 404 && foreign.json && foreign.json.code === 'job_not_found',
            `status=${foreign.status} code=${foreign.json && foreign.json.code}`);

        // Idempotency replay: same key/header/body returns 200 and same job_id.
        const idem = `phase3-smoke-${randomUUID()}`;
        const first = await createJob(keyA, { url: SMALL_URL, filename: 'DSCF9243.jpg' }, idem);
        const second = await createJob(keyA, { url: SMALL_URL, filename: 'DSCF9243.jpg' }, idem);
        row('Idempotency-Key replay returns 200 and same job_id',
            first.status === 202 && second.status === 200 && first.json && second.json && first.json.job_id === second.json.job_id,
            `first=${first.status}/${first.json && first.json.job_id} second=${second.status}/${second.json && second.json.job_id}`);

        // Failure path: a terminal upstream 404 is failed once, not retried forever.
        const badCreate = await createJob(keyA, { url: NOT_FOUND_URL, filename: 'missing.jpg' });
        const badTerminal = await waitTerminal(keyA, badCreate.json.job_id, 180000, '404 URL job');
        const badJob = badTerminal.response.json;
        row('404 URL job fails cleanly with upstream_fetch_failed problem',
            badJob.status === 'failed'
            && validateJob(badJob) === true
            && badJob.error && badJob.error.code === 'upstream_fetch_failed'
            && badJob.error.status === 502,
            `elapsed=${badTerminal.elapsed_seconds}s error=${badJob.error && badJob.error.code} transitions=${JSON.stringify(badTerminal.transitions)}`);

        // Webhook success delivery through webhook.site. The hook endpoint is
        // external by design; no test-only route exists in production code.
        webhookToken = await createWebhookToken();
        const hookUrl = `https://webhook.site/${webhookToken}`;
        const hookCreate = await createJob(keyA, { url: SMALL_URL, filename: 'DSCF9243.jpg', webhook_url: hookUrl });
        const hookTerminal = await waitTerminal(keyA, hookCreate.json.job_id, 180000, 'webhook job');
        row('webhook job itself succeeds', hookTerminal.response.json.status === 'succeeded', `job=${hookCreate.json.job_id} elapsed=${hookTerminal.elapsed_seconds}s`);
        let matchingHooks = [];
        const hookWaitStart = Date.now();
        while (Date.now() - hookWaitStart < 90000) {
            const all = await webhookRequests(webhookToken);
            matchingHooks = all.filter((h) => (h.content || '').includes(hookCreate.json.job_id));
            if (matchingHooks.length) break;
            await sleep(3000);
        }
        row('webhook.site received exactly one callback for terminal job',
            matchingHooks.length === 1,
            `count=${matchingHooks.length} wait=${((Date.now() - hookWaitStart) / 1000).toFixed(1)}s`);
        if (matchingHooks.length) {
            const sig = verifyHookSignature(matchingHooks[0], webhookSecret, hookCreate.json.job_id);
            row('webhook X-C2PA-Signature HMAC and job.completed body verify',
                sig.pass,
                sig.detail);
        }

        // Large-file production proof. Public r2.dev is enabled only around the
        // object write + URL job creation, then closed in cleanup/finally.
        largeObjectKey = 'public-test/large-signed.jpg';
        cleanupArgs.largeObjectKey = largeObjectKey;
        try {
            wrangler(['r2', 'bucket', 'create', FIXTURE_BUCKET]);
        } catch { /* already exists */ }
        wrangler(['r2', 'bucket', 'dev-url', 'enable', FIXTURE_BUCKET]);
        publicWasEnabled = true;
        wrangler(['r2', 'object', 'put', `${FIXTURE_BUCKET}/${largeObjectKey}`, '--file', LARGE, '--content-type', 'image/jpeg', '--remote'], { cwd: API_DIR });
        const devUrlOut = wrangler(['r2', 'bucket', 'dev-url', 'get', FIXTURE_BUCKET]);
        const publicBase = (devUrlOut.match(/https:\/\/[^\s'']+\.r2\.dev/) || [])[0];
        const largeUrl = `${publicBase}/${largeObjectKey}`;
        const expectedSha = sha256File(LARGE);
        const expectedBytes = readFileSync(LARGE).byteLength;
        const largeT0 = Date.now();
        const largeCreate = await createJob(keyA, { url: largeUrl, filename: 'large-signed.jpg' });
        row('large signed fixture URL job accepted', largeCreate.status === 202 && largeCreate.json && largeCreate.json.status === 'queued',
            `status=${largeCreate.status} job=${largeCreate.json && largeCreate.json.job_id}`);
        const largeTerminal = await waitTerminal(keyA, largeCreate.json.job_id, 600000, 'large URL job');
        timings.large_job_seconds = largeTerminal.elapsed_seconds;
        timings.large_create_to_terminal_seconds = Number(((Date.now() - largeT0) / 1000).toFixed(1));
        const largeJob = largeTerminal.response.json;
        const result = largeJob.result || {};
        row('220 MiB signed job succeeds with schema-valid VerifyResult',
            largeJob.status === 'succeeded'
            && validateJob(largeJob) === true
            && validateVerifyResult(result) === true
            && result.status === 'valid_untrusted'
            && result.validation && result.validation.state === 'Valid',
            `transitions=${JSON.stringify(largeTerminal.transitions)} elapsed=${largeTerminal.elapsed_seconds}s`);
        row('220 MiB asset hash/size match local signed fixture and no invalid verdict',
            result.asset && result.asset.sha256 === expectedSha
            && result.asset.bytes === expectedBytes
            && result.validation && result.validation.state !== 'Invalid',
            `bytes=${result.asset && result.asset.bytes}/${expectedBytes} sha=${String(result.asset && result.asset.sha256).slice(0, 12)} state=${result.validation && result.validation.state}`);

        // MCP production client proof using the exact Phase 3 tool names.
        const mcp = await connectMcp(keyA);
        try {
            const listed = await mcp.listTools();
            const names = listed.tools.map((t) => t.name);
            row('MCP exposes submit_verification_job and get_verification_job',
                names.includes('submit_verification_job') && names.includes('get_verification_job'),
                names.join(','));
            const submit = await mcp.callTool({ name: 'submit_verification_job', arguments: { url: SMALL_URL, filename: 'DSCF9243.jpg' } });
            const created = submit.structuredContent || {};
            row('MCP submit_verification_job creates a queued job',
                submit.isError !== true && created.status === 'queued' && typeof created.job_id === 'string',
                `job=${created.job_id} isError=${submit.isError || false}`);
            let mcpJob = null;
            const mt0 = Date.now();
            while (Date.now() - mt0 < 180000) {
                const got = await mcp.callTool({ name: 'get_verification_job', arguments: { job_id: created.job_id } });
                mcpJob = got.structuredContent || {};
                if (mcpJob.status === 'succeeded' || mcpJob.status === 'failed') break;
                await sleep(3000);
            }
            row('MCP get_verification_job polls to succeeded VerifyResult',
                mcpJob && mcpJob.status === 'succeeded' && mcpJob.result && mcpJob.result.status === 'trusted',
                `status=${mcpJob && mcpJob.status} elapsed=${((Date.now() - mt0) / 1000).toFixed(1)}s`);
        } finally {
            try { await mcp.close(); } catch { }
        }
    } catch (e) {
        row(`smoke-jobs harness error: ${e.message}`, false);
    } finally {
        await cleanup(cleanupArgs);
        const after = wrangler(['r2', 'bucket', 'dev-url', 'get', FIXTURE_BUCKET]);
        row('PUBLIC BUCKET EXPOSURE CLOSED: r2.dev disabled after smoke',
            /disabled/i.test(after),
            after.trim().split('\n').pop());
    }

    console.log('\n== smoke-jobs summary ==');
    console.log(JSON.stringify({ failures, timings, rows }, null, 2));
    for (const cf of cleanupFailures) console.log(`FAIL  cleanup — ${cf}`);
    process.exit((failures + cleanupFailures.length) ? 1 : 0);
}

main();
