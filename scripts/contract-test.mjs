#!/usr/bin/env bun
// contract-test.mjs — contract-completeness test for c2pa-verify-api.
//
//   bun scripts/contract-test.mjs
//
// Unlike the smoke matrix (a hand-written behavior matrix), this test starts
// from api/openapi.yaml and walks the documented operations programmatically:
//
//   1. verifies the worker's implemented /v1 surface is exactly the documented
//      operation set (including the Phase 3 jobs control plane);
//   2. produces every documented success response for those operations and
//      validates it against the operation's response schema with ajv;
//   3. reproduces every reproducible documented error status for those
//      operations, validating HTTP status, application/problem+json shape,
//      the Problem schema, the `code` enum, and the exact example `code`;
//   4. proves undocumented methods do not succeed. Async job execution itself
//      is covered by scripts/smoke-jobs.mjs because containers/queues cannot be
//      fully validated in local dev; this test covers the jobs HTTP contract.
//
// Documented-but-impossible errors are listed in WAIVED with justification.
// An empty WAIVED list is the goal; a non-empty list is acceptable only when
// every entry explains why the implementation genuinely cannot produce it.
//
// The wrangler dev process and fixture upstream are killed in finally paths.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { writeContainerlessWranglerConfig } from './containerless-config.mjs';
import { applyLocalMigrations } from './migrate-local.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'api');
const FIXTURES = join(ROOT, 'fixtures');
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');
const MAX_SYNC_BYTES = 20 * 1024 * 1024;

// These operationIds define the implemented HTTP surface. Job execution is
// asynchronous and container-backed, but creation/polling are normal Worker
// routes and are schema-checked here using the local control plane.
const PHASE1_OPERATION_IDS = ['verifyAsset', 'verifyMini', 'createJob', 'getJob', 'getTrustLists', 'getOpenApi'];

// Task scope explicitly covers these documented error statuses. 400/500 are
// documented generically on /verify but are outside the requested matrix.
const TARGET_ERROR_STATUSES = new Set([401, 403, 413, 415, 422, 429, 502]);

// Waivers are keyed operationId:status. Keep these precise: a blanket waiver
// would defeat the purpose of the contract-completeness walk.
const WAIVED = [
    {
        operationId: 'getTrustLists',
        status: 401,
        justification: 'GET /v1/trust-lists is explicitly security: [] in the spec and is implemented as a public metadata route with no authentication middleware; bearer credentials are ignored, so no request can produce an authentication failure without violating the documented public access contract.',
    },
    {
        operationId: 'getTrustLists',
        status: 403,
        justification: 'GET /v1/trust-lists is explicitly security: [] in the spec and is implemented as a public metadata route with no key lookup or authorization decision; there is no authenticated principal whose permissions can be denied.',
    },
    {
        operationId: 'getTrustLists',
        status: 429,
        justification: 'GET /v1/trust-lists is explicitly security: [] and the phase-1 implementation intentionally does not run the key-scoped RATELIMIT middleware on public metadata; no key-scoped rate-limit rejection path exists on this route.',
    },
];
const waiverFor = (operationId, status) => WAIVED.find((w) => w.operationId === operationId && w.status === status);

// ------------------------------------------------------------------ spec --

const doc = parseYaml(readFileSync(join(ROOT, 'api/openapi.yaml'), 'utf8'));
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function resolveRef(node) {
    if (!node || typeof node !== 'object' || !node.$ref) return node;
    const m = node.$ref.match(/^#\/components\/responses\/(\w+)$/);
    if (!m) return node;
    return doc.components.responses[m[1]];
}

function operations() {
    const out = [];
    for (const [path, pathItem] of Object.entries(doc.paths || {})) {
        for (const [method, op] of Object.entries(pathItem || {})) {
            if (!HTTP_METHODS.has(method)) continue;
            out.push({ specPath: path, method, operation: op, operationId: op.operationId });
        }
    }
    return out;
}

const ALL_OPERATIONS = operations();
const PHASE1_OPERATIONS = PHASE1_OPERATION_IDS.map((id) => {
    const found = ALL_OPERATIONS.find((op) => op.operationId === id);
    if (!found) throw new Error(`OpenAPI document does not define operationId ${id}`);
    return found;
});

// ------------------------------------------------------------- ajv setup --

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ components: { schemas: doc.components.schemas } }, 'spec');

function rewriteSchemaRefs(node) {
    if (Array.isArray(node)) return node.map(rewriteSchemaRefs);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) {
            out[k] = `spec${v}`;
        } else {
            out[k] = rewriteSchemaRefs(v);
        }
    }
    return out;
}

const validatorCache = new Map();
function validatorForSchema(schema, label) {
    if (!schema) return null;
    const key = JSON.stringify(schema);
    if (validatorCache.has(key)) return validatorCache.get(key);
    let validator = null;
    try {
        validator = ajv.compile(rewriteSchemaRefs(schema));
    } catch (e) {
        throw new Error(`cannot compile schema at ${label}: ${e.message}`);
    }
    validatorCache.set(key, validator);
    return validator;
}

function schemaErrors(validator) {
    return JSON.stringify((validator && validator.errors) || []).slice(0, 500);
}

function responseSchema(response, status) {
    const resolved = resolveRef(response);
    const content = resolved && resolved.content;
    if (!content) return { resolved, schema: null, mediaType: null };
    const mediaType = content['application/problem+json'] ? 'application/problem+json'
        : content['application/json'] ? 'application/json'
            : Object.keys(content)[0];
    return { resolved, schema: content[mediaType] && content[mediaType].schema, mediaType };
}

function expectedProblemCode(response) {
    const resolved = resolveRef(response);
    const media = resolved && resolved.content && resolved.content['application/problem+json'];
    if (!media) return null;
    if (media.example && typeof media.example.code === 'string') return media.example.code;
    if (media.examples) {
        for (const ex of Object.values(media.examples)) {
            const value = ex && typeof ex === 'object' && 'value' in ex ? ex.value : ex;
            if (value && typeof value.code === 'string') return value.code;
        }
    }
    return null;
}

// -------------------------------------------------------------- reporting --

let failures = 0;
const rows = [];
function row(name, pass, detail = '') {
    rows.push({ name, pass, detail });
    console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!pass) failures++;
}

// -------------------------------------------------------------- processes --

async function freePort() {
    return new Promise((res, rej) => {
        const srv = net.createServer();
        srv.once('error', rej);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => res(port));
        });
    });
}

function keyctl(args) {
    const res = spawnSync('bun', ['scripts/keyctl.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`keyctl ${args[0]} failed: ${res.stdout}\n${res.stderr}`);
    const key = (res.stdout.match(/^KEY=(.+)$/m) || [])[1];
    const id = (res.stdout.match(/^KEY_ID=(.+)$/m) || [])[1];
    return { key, id, out: res.stdout };
}

function d1(args) {
    const res = spawnSync(WRANGLER, ['d1', 'execute', 'c2pa-verify-api', '--local', ...args], {
        cwd: API_DIR,
        encoding: 'utf8',
    });
    if (res.status !== 0) throw new Error(`d1 execute failed: ${res.stdout}\n${res.stderr}`);
}

function startWrangler(port, configPath) {
    const child = spawn(WRANGLER, ['dev', '--local', '-c', configPath, '--port', String(port), '--var', 'ALLOW_LOCAL_UPSTREAM:1', '--var', 'R2_ACCESS_KEY_ID:contract-test-only', '--var', 'R2_SECRET_ACCESS_KEY:contract-test-only'], {
        cwd: API_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    child.log = '';
    child.stdout.on('data', (d) => { child.log += d; });
    child.stderr.on('data', (d) => { child.log += d; });
    return child;
}

function killProcessGroup(child, signal) {
    try {
        process.kill(-child.pid, signal);
    } catch {
        try { child.kill(signal); } catch { }
    }
}

function stopChild(child) {
    return new Promise((res) => {
        if (!child || child.exitCode !== null || child.killed) return res();
        const t = setTimeout(() => { killProcessGroup(child, 'SIGKILL'); res(); }, 8000);
        child.once('exit', () => { clearTimeout(t); res(); });
        killProcessGroup(child, 'SIGTERM');
    });
}

async function waitHealth(child, base, timeoutMs = 90000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (child.exitCode !== null) throw new Error(`wrangler exited early (code ${child.exitCode})\n${child.log.slice(-2000)}`);
        try {
            const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
            if (r.ok) return;
        } catch { }
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('wrangler dev did not become healthy in time');
}

function startFixtureServer(port) {
    return Bun.serve({
        port,
        hostname: '127.0.0.1',
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === '/fail500') {
                return new Response('fixture upstream failure', { status: 500 });
            }
            if (url.pathname === '/too-big.jpg') {
                // 20 MiB + 1 of JPEG-headed bytes: over the sync cap, so the
                // gateway must reject with payload_too_large. Cached in the
                // server closure so the buffer is built once per test run.
                if (!startFixtureServer.tooBig) {
                    const c = readFileSync(join(FIXTURES, 'C.jpg'));
                    startFixtureServer.tooBig = Buffer.concat([c, Buffer.alloc(20 * 1024 * 1024 + 1 - c.length)]);
                }
                return new Response(startFixtureServer.tooBig, { headers: { 'content-type': 'image/jpeg' } });
            }
            if (url.pathname === '/not-image') {
                // Neither a supported content type nor image evidence in the bytes.
                return new Response('this is plain text, not an image', { headers: { 'content-type': 'text/plain' } });
            }
            const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
            if (!/^[A-Za-z0-9_.-]+$/.test(name)) return new Response('nope', { status: 404 });
            try {
                const data = readFileSync(join(FIXTURES, name));
                return new Response(data, { headers: { 'content-type': 'image/jpeg' } });
            } catch {
                return new Response('not found', { status: 404 });
            }
        },
    });
}

// --------------------------------------------------------------- requests --

async function req(method, url, { key, body, headers = {}, form } = {}) {
    const h = { ...headers };
    if (key) h.authorization = `Bearer ${key}`;
    const resp = await fetch(url, { method, headers: h, body: form || body });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { }
    return { status: resp.status, json, text, headers: resp.headers };
}

function multipart(fileBytes, filename, partType, fields = {}) {
    const form = new FormData();
    form.append('file', new Blob([fileBytes], { type: partType }), filename);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return form;
}

function isProblemJsonContentType(headers) {
    return (headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'application/problem+json';
}

function basicProblemShape(json, code, status) {
    return json && typeof json === 'object'
        && typeof json.type === 'string' && json.type.endsWith(`/problems/${code}`)
        && typeof json.title === 'string'
        && json.status === status
        && json.code === code;
}

// ------------------------------------------------------- surface checking --

function implementedV1Routes() {
    const src = readFileSync(join(API_DIR, 'src/index.js'), 'utf8');
    const routes = [];
    for (const m of src.matchAll(/app\.(get|post|put|patch|delete|options)\(\s*['"]([^'"]+)['"]/g)) {
        const method = m[1];
        const path = m[2];
        if (!path.startsWith('/v1/')) continue;
        if (method === 'options' && path === '/v1/*') continue; // CORS preflight helper, not an API operation
        routes.push({ method, path: path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}') });
    }
    return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

function checkSurface() {
    console.log('== implemented surface vs OpenAPI surface ==');
    const expected = ALL_OPERATIONS
        .map(({ specPath, method }) => ({ method, path: `/v1${specPath}` }))
        .sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
    const actual = implementedV1Routes();
    const fmt = (list) => list.map((r) => `${r.method.toUpperCase()} ${r.path}`).join(', ');
    row('implemented /v1 routes exactly match the documented operation set',
        JSON.stringify(actual) === JSON.stringify(expected),
        `expected=[${fmt(expected)}] actual=[${fmt(actual)}]`);

    const jobsInSpec = ALL_OPERATIONS.filter((op) => op.specPath.startsWith('/jobs'));
    const jobsRoutesImplemented = ['get /v1/jobs', 'post /v1/jobs', 'get /v1/jobs/{job_id}']
        .every((want) => actual.some((r) => `${r.method} ${r.path}` === want));
    row('OpenAPI jobs operations are present in the implemented operation set',
        jobsInSpec.length === 3 && jobsRoutesImplemented,
        `${jobsInSpec.length} jobs operations documented`);
}

// ------------------------------------------------------------ test bodies --

let contractJobId = null;

async function validateSuccessResponses(base, keys, upstreamPort) {
    console.log('\n== documented success responses ==');
    const C = readFileSync(join(FIXTURES, 'C.jpg'));
    const upstreamC = `http://127.0.0.1:${upstreamPort}/C.jpg`;

    const producers = {
        verifyAsset: () => req('POST', `${base}/v1/verify`, {
            key: keys.server.key,
            form: multipart(C, 'C.jpg', 'image/jpeg'),
        }),
        verifyMini: () => req('GET', `${base}/v1/verify/mini?url=${encodeURIComponent(upstreamC)}`, {
            key: keys.server.key,
        }),
        createJob: async () => {
            // Integer-like object keys iterate numerically, so the success walk
            // picks the documented 200 (same-key replay) before the 202. Drive
            // both: create once with a fresh idempotency key, then repeat the
            // exact request — the second response is the replay the walk
            // validates — and assert the first creation really was 202.
            const idem = `contract-${Date.now()}`;
            const init = {
                key: keys.server.key,
                headers: { 'content-type': 'application/json', 'idempotency-key': idem },
                body: JSON.stringify({ filename: 'contract-upload.jpg', mime: 'image/jpeg', size_bytes: 3 }),
            };
            const first = await req('POST', `${base}/v1/jobs`, init);
            row('createJob: first submission with fresh idempotency key → 202',
                first.status === 202, `status=${first.status}`);
            if (first.json && first.json.job_id) contractJobId = first.json.job_id;
            const replayInit = { ...init, headers: { ...init.headers } };
            return req('POST', `${base}/v1/jobs`, replayInit);
        },
        getJob: () => req('GET', `${base}/v1/jobs/${contractJobId || 'job_missing'}`, { key: keys.server.key }),
        getTrustLists: () => req('GET', `${base}/v1/trust-lists`),
        getOpenApi: () => req('GET', `${base}/v1/openapi.json`),
    };

    for (const { operationId, operation } of PHASE1_OPERATIONS) {
        const successEntry = Object.entries(operation.responses || {}).find(([status]) => /^2\d\d$/.test(status));
        if (!successEntry) {
            row(`${operationId}: documented success response exists`, false);
            continue;
        }
        const [statusText, response] = successEntry;
        const expectedStatus = Number(statusText);
        const producer = producers[operationId];
        if (!producer) {
            row(`${operationId}: success producer implemented in test`, false);
            continue;
        }
        const r = await producer();
        const { schema, mediaType } = responseSchema(response, expectedStatus);
        const validator = schema ? validatorForSchema(schema, `${operationId} response ${expectedStatus}`) : null;
        const schemaPass = !validator || (r.json && validator(r.json) === true);
        row(`${operationId}: ${expectedStatus} success produced and matches schema`,
            r.status === expectedStatus && !!r.json && schemaPass,
            `status=${r.status} media=${mediaType}${r.json && validator && !validator(r.json) ? ` schema=${schemaErrors(validator)}` : ''}`);

        if (operationId === 'verifyAsset' || operationId === 'verifyMini') {
            row(`${operationId}: RateLimit-Policy/RateLimit-Limit present on success`,
                r.headers.get('ratelimit-policy') === '60;w=60' && r.headers.get('ratelimit-limit') === '60',
                `policy=${r.headers.get('ratelimit-policy')} limit=${r.headers.get('ratelimit-limit')}`);
        }
    }
}

async function reproduceErrors(base, keys, upstreamPort) {
    console.log('\n== reproducing documented errors ==');
    const C = readFileSync(join(FIXTURES, 'C.jpg'));
    const failUrl = `http://127.0.0.1:${upstreamPort}/fail500`;
    const reproductions = new Map();
    const put = (operationId, status, value) => reproductions.set(`${operationId}:${status}`, value);

    // 401 unauthorized — missing bearer key on both protected operations.
    put('verifyAsset', 401, await req('POST', `${base}/v1/verify`));
    put('verifyMini', 401, await req('GET', `${base}/v1/verify/mini`));
    put('createJob', 401, await req('POST', `${base}/v1/jobs`, { headers: { 'content-type': 'application/json' }, body: '{}' }));
    put('getJob', 401, await req('GET', `${base}/v1/jobs/job_missing`));

    // 403 forbidden — a syntactically valid but revoked key on both operations.
    put('verifyAsset', 403, await req('POST', `${base}/v1/verify`, { key: keys.revoked.key }));
    put('verifyMini', 403, await req('GET', `${base}/v1/verify/mini?url=${encodeURIComponent(`http://127.0.0.1:${upstreamPort}/C.jpg`)}`, { key: keys.revoked.key }));
    put('createJob', 403, await req('POST', `${base}/v1/jobs`, { key: keys.revoked.key, headers: { 'content-type': 'application/json' }, body: '{}' }));
    put('getJob', 403, await req('GET', `${base}/v1/jobs/job_missing`, { key: keys.revoked.key }));

    // 413 payload_too_large — decoded multipart asset is exactly 20 MiB + 1.
    const tooBig = Buffer.concat([C, Buffer.alloc(MAX_SYNC_BYTES + 1 - C.length)]);
    put('verifyAsset', 413, await req('POST', `${base}/v1/verify`, {
        key: keys.server.key,
        form: multipart(tooBig, 'too-big.jpg', 'image/jpeg'),
    }));
    put('createJob', 413, await req('POST', `${base}/v1/jobs`, {
        key: keys.server.key,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'too-big.jpg', size_bytes: 1024 * 1024 * 1024 + 1 }),
    }));

    // 415 unsupported_media_type — neither a supported request content type
    // nor image evidence. This is the exact operation-level media-type failure.
    put('verifyAsset', 415, await req('POST', `${base}/v1/verify`, {
        key: keys.server.key,
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
    }));
    put('createJob', 415, await req('POST', `${base}/v1/jobs`, {
        key: keys.server.key,
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
    }));

    // mini 413/415 — same endpoint input failures through the url input path:
    // an upstream asset over the sync cap, and one that is not an image at all.
    put('verifyMini', 413, await req('GET', `${base}/v1/verify/mini?url=${encodeURIComponent(`http://127.0.0.1:${upstreamPort}/too-big.jpg`)}`, { key: keys.server.key }));
    put('verifyMini', 415, await req('GET', `${base}/v1/verify/mini?url=${encodeURIComponent(`http://127.0.0.1:${upstreamPort}/not-image`)}`, { key: keys.server.key }));

    // 422 invalid_request — well-formed requests that cannot be processed.
    put('verifyAsset', 422, await req('POST', `${base}/v1/verify?include=exif,bogus`, {
        key: keys.server.key,
        form: multipart(C, 'C.jpg', 'image/jpeg'),
    }));
    put('verifyMini', 422, await req('GET', `${base}/v1/verify/mini`, { key: keys.server.key }));
    put('createJob', 422, await req('POST', `${base}/v1/jobs`, {
        key: keys.server.key,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'bad.jpg', unexpected: true }),
    }));

    // 502 upstream_fetch_failed — the local fixture upstream is fetchable but
    // deliberately returns HTTP 500, which the gateway maps to a 502 problem.
    put('verifyAsset', 502, await req('POST', `${base}/v1/verify`, {
        key: keys.server.key,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: failUrl }),
    }));
    put('verifyMini', 502, await req('GET', `${base}/v1/verify/mini?url=${encodeURIComponent(failUrl)}`, { key: keys.server.key }));

    // 429 rate_limited — use a fresh unlimited-quota key and consume the full
    // 60/minute key-scoped allowance with cheap mini requests that fail input
    // validation only after rate middleware has run. Request 61 on mini and the
    // next request on verify must both be rejected by the same key-scoped limit.
    const warmupStatuses = [];
    for (let i = 0; i < 60; i++) {
        const r = await req('GET', `${base}/v1/verify/mini`, { key: keys.rate.key });
        warmupStatuses.push(r.status);
    }
    const counts = warmupStatuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] || 0) + 1 }), {});
    row('rate-limit warmup consumed 60 key-scoped requests before limiter rejection',
        warmupStatuses.every((s) => s === 422),
        `status distribution=${JSON.stringify(counts)}`);

    put('verifyMini', 429, await req('GET', `${base}/v1/verify/mini`, { key: keys.rate.key }));
    put('verifyAsset', 429, await req('POST', `${base}/v1/verify`, { key: keys.rate.key }));
    put('createJob', 429, await req('POST', `${base}/v1/jobs`, { key: keys.rate.key, headers: { 'content-type': 'application/json' }, body: '{}' }));
    put('getJob', 429, await req('GET', `${base}/v1/jobs/job_missing`, { key: keys.rate.key }));

    return reproductions;
}

async function validateErrorContract(reproductions) {
    console.log('\n== documented error contract walk ==');
    const problemValidator = validatorForSchema({ $ref: '#/components/schemas/Problem' }, 'Problem');
    const enumValues = (((doc.components.schemas.Problem || {}).properties || {}).code || {}).enum || [];

    for (const { operationId, operation } of PHASE1_OPERATIONS) {
        const documented = Object.entries(operation.responses || {})
            .map(([status, response]) => ({ status: Number(status), response }))
            .filter(({ status }) => TARGET_ERROR_STATUSES.has(status))
            .sort((a, b) => a.status - b.status);

        for (const { status, response } of documented) {
            const label = `${operationId} ${status}`;
            const expectedCode = expectedProblemCode(response);
            if (!expectedCode) {
                row(`${label}: spec carries a problem example code`, false);
                continue;
            }

            const actual = reproductions.get(`${operationId}:${status}`);
            if (!actual) {
                const waiver = waiverFor(operationId, status);
                if (waiver && waiver.justification) {
                    row(`${label}: WAIVED — ${waiver.justification}`, true);
                } else {
                    row(`${label}: no reproduction and no justified waiver`, false, `expected code=${expectedCode}`);
                }
                continue;
            }

            const schemaPass = actual.json && problemValidator(actual.json) === true;
            const enumPass = enumValues.includes(actual.json && actual.json.code);
            const exactCodePass = actual.json && actual.json.code === expectedCode;
            const shapePass = actual.json && basicProblemShape(actual.json, expectedCode, status);
            const pass = actual.status === status
                && isProblemJsonContentType(actual.headers)
                && !!actual.json
                && schemaPass
                && enumPass
                && exactCodePass
                && shapePass;

            row(`${label}: reproduced as ${expectedCode} with valid problem+json`,
                pass,
                `http=${actual.status} ct=${actual.headers.get('content-type')} code=${actual.json && actual.json.code} expected=${expectedCode}` +
                `${!schemaPass ? ` schema=${schemaErrors(problemValidator)}` : ''}`);

            if (status === 429 && expectedCode === 'rate_limited') {
                row(`${label}: Retry-After present on rate_limited reproduction`,
                    !!actual.headers.get('retry-after'),
                    `retry-after=${actual.headers.get('retry-after')}`);
            }
        }
    }
}

async function checkUndocumentedRoutes(base, key) {
    console.log('\n== undocumented methods ==');
    const methodChecks = [
        ['GET', '/v1/verify'],
        ['PUT', '/v1/verify'],
        ['DELETE', '/v1/verify'],
        ['POST', '/v1/verify/mini'],
        ['PUT', '/v1/verify/mini'],
        ['POST', '/v1/trust-lists'],
        ['PUT', '/v1/openapi.json'],
        ['PUT', '/v1/jobs'],
        ['DELETE', '/v1/jobs'],
        ['POST', '/v1/jobs/job_01JZX4K8Q2MNBVCXZ'],
        ['PUT', '/v1/jobs/job_01JZX4K8Q2MNBVCXZ'],
    ];
    for (const [method, path] of methodChecks) {
        const r = await req(method, `${base}${path}`, { key });
        row(`${method} ${path} (undocumented method) does not return 200`,
            r.status !== 200,
            `status=${r.status}`);
    }
}

// ------------------------------------------------------------------- main --

async function main() {
    checkSurface();

    console.log('\n== seeding local D1 ==');
    applyLocalMigrations(API_DIR);
    const server = keyctl(['create', '--name', 'contract-server', '--type', 'server', '--tier', 'sync_async']);
    const revoked = keyctl(['create', '--name', 'contract-revoked', '--type', 'server', '--tier', 'free']);
    spawnSync('bun', ['scripts/keyctl.mjs', 'revoke', '--id', revoked.id], { cwd: ROOT, encoding: 'utf8' });
    const rate = keyctl(['create', '--name', 'contract-rate', '--type', 'server', '--tier', 'sync_async']);
    const keys = { server, revoked, rate };
    console.log('  keys seeded (server/revoked/rate)');

    const apiPort = await freePort();
    const upstreamPort = await freePort();
    const base = `http://localhost:${apiPort}`;
    const upstream = startFixtureServer(upstreamPort);
    console.log(`\n== fixture upstream on 127.0.0.1:${upstreamPort} ==`);
    console.log(`== wrangler dev --local on port ${apiPort} (ALLOW_LOCAL_UPSTREAM=1) ==`);
    const child = startWrangler(apiPort, await writeContainerlessWranglerConfig(API_DIR));

    const cleanup = async () => {
        await stopChild(child);
        upstream.stop(true);
    };
    process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
    process.on('SIGTERM', async () => { await cleanup(); process.exit(130); });

    try {
        await waitHealth(child, base);
        await validateSuccessResponses(base, keys, upstreamPort);
        const reproductions = await reproduceErrors(base, keys, upstreamPort);
        await validateErrorContract(reproductions);
        await checkUndocumentedRoutes(base, server.key);
    } catch (e) {
        row(`contract harness error: ${e.message}`, false);
        if (child.log) console.log('--- wrangler output (tail) ---\n' + child.log.split('\n').slice(-30).join('\n'));
    } finally {
        await cleanup();
        await new Promise((r) => setTimeout(r, 700));
    }

    console.log('\n== WAIVED documented errors ==');
    if (!WAIVED.length) {
        console.log('(none)');
    } else {
        for (const w of WAIVED) {
            console.log(`- ${w.operationId} ${w.status}: ${w.justification || 'MISSING JUSTIFICATION'}`);
            if (!w.justification) failures++;
        }
    }

    console.log('\n== contract summary ==');
    const width = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
    console.log(failures ? `\n${failures} contract failure(s)` : '\ncontract: all checks pass');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
