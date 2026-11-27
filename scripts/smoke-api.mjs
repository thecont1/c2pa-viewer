#!/usr/bin/env bun
// smoke-api.mjs — Phase 1 contract smoke matrix for c2pa-verify-api.
//
//   bun scripts/smoke-api.mjs
//
// Boots `wrangler dev --local` for api/ on a free port TWICE:
//   boot A — with ALLOW_LOCAL_UPSTREAM=1 (dev/test escape hatch) so `url`
//            inputs can fetch from a loopback fixture server. This var is
//            NEVER set in production config.
//   boot B — without it, to assert the SSRF guard rejects loopback/private
//            targets before any fetch happens.
//
// Seeds local D1 (migration + server/browser/test/quota/revoked keys via
// scripts/keyctl.mjs), then exercises every row of the Phase 1 matrix,
// printing pass/fail per row and exiting nonzero on any failure.

import { spawn, spawnSync } from 'node:child_process';
import { redactGpsDeep } from '../packages/core/src/api-result.js';
import { readFileSync } from 'node:fs';
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
const GOLDEN = join(FIXTURES, 'golden');
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');

const PORT_A = 8871;      // api, ALLOW_LOCAL_UPSTREAM=1
const PORT_B = 8881;      // api, SSRF guard fully active
const PORT_UPSTREAM = 8872; // fixture static server
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_B = `http://localhost:${PORT_B}`;

const MAX_SYNC_BYTES = 20 * 1024 * 1024;

// Contract validators — the same ajv setup scripts/openapi-check.mjs uses.
const SPEC_DOC = parseYaml(readFileSync(join(ROOT, 'api/openapi.yaml'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ components: { schemas: SPEC_DOC.components.schemas } }, 'spec');
const validateVerifyResult = ajv.getSchema('spec#/components/schemas/VerifyResult');
const validateMiniResult = ajv.getSchema('spec#/components/schemas/MiniResult');
function schemaErrors(v) { return JSON.stringify((v.errors || []).slice(0, 3)).slice(0, 300); }

let failures = 0;
const rows = [];
function row(name, pass, detail = '') {
    rows.push({ name, pass, detail });
    console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!pass) failures++;
}

// ------------------------------------------------------------- utilities --

function keyctl(args) {
    const res = spawnSync('bun', ['scripts/keyctl.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`keyctl ${args[0]} failed: ${res.stdout}\n${res.stderr}`);
    const key = (res.stdout.match(/^KEY=(.+)$/m) || [])[1];
    const id = (res.stdout.match(/^KEY_ID=(.+)$/m) || [])[1];
    return { key, id, out: res.stdout };
}

function d1(args) {
    const res = spawnSync(WRANGLER, ['d1', 'execute', 'c2pa-verify-api', '--local', ...args], {
        cwd: API_DIR, encoding: 'utf8',
    });
    if (res.status !== 0) throw new Error(`d1 execute failed: ${res.stdout}\n${res.stderr}`);
    return res.stdout;
}

async function portFree(port) {
    try {
        await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(600) });
        return false;
    } catch { return true; }
}

function startWrangler(port, extraArgs, configPath) {
    const child = spawn(WRANGLER, ['dev', '--local', '-c', configPath, '--port', String(port), ...extraArgs], {
        cwd: API_DIR, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.log = '';
    child.stdout.on('data', (d) => { child.log += d; });
    child.stderr.on('data', (d) => { child.log += d; });
    return child;
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

function stopChild(child) {
    return new Promise((res) => {
        if (!child || child.exitCode !== null || child.killed) return res();
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } res(); }, 8000);
        child.once('exit', () => { clearTimeout(t); res(); });
        try { child.kill('SIGTERM'); } catch { res(); }
    });
}

function startFixtureServer(port) {
    return Bun.serve({
        port,
        hostname: '127.0.0.1',
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === '/redirect/C.jpg') {
                return new Response(null, { status: 302, headers: { location: '/C.jpg' } });
            }
            if (url.pathname === '/redirect-chain/C.jpg') {
                return new Response(null, { status: 302, headers: { location: '/redirect/C.jpg' } });
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

// request helper: returns { status, json, text, headers }
async function req(method, url, { key, body, headers = {}, form } = {}) {
    const h = { ...headers };
    if (key) h['authorization'] = `Bearer ${key}`;
    let payload = body;
    if (form) payload = form;
    // Bound every matrix request: a worker that passes health but never
    // completes a response must not hang the matrix out of its cleanup path.
    const resp = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(30000) });
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

function problemShape(json, code) {
    return json && typeof json === 'object'
        && typeof json.type === 'string' && json.type.endsWith(`/problems/${code}`)
        && typeof json.title === 'string'
        && typeof json.status === 'number'
        && json.code === code;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ main --

async function main() {
    for (const p of [PORT_A, PORT_B, PORT_UPSTREAM]) {
        if (!(await portFree(p))) {
            console.error(`port ${p} is not free — refusing to start`);
            process.exit(1);
        }
    }

    // ---- seed local D1 -------------------------------------------------
    console.log('== seeding local D1 ==');
    applyLocalMigrations(API_DIR);

    const server = keyctl(['create', '--name', 'smoke-server', '--type', 'server', '--tier', 'free']);
    const browser = keyctl(['create', '--name', 'smoke-browser', '--type', 'browser', '--tier', 'free', '--origins', 'https://embed.example.com']);
    const test = keyctl(['create', '--name', 'smoke-test', '--type', 'server', '--tier', 'free', '--test']);
    const quota = keyctl(['create', '--name', 'smoke-quota', '--type', 'server', '--tier', 'free']);
    const rotation = keyctl(['create', '--name', 'smoke-rotation', '--type', 'server', '--tier', 'free', '--quota', '100']);
    const revoked = keyctl(['create', '--name', 'smoke-revoked', '--type', 'server', '--tier', 'free']);
    spawnSync('bun', ['scripts/keyctl.mjs', 'revoke', '--id', revoked.id], { cwd: ROOT, encoding: 'utf8' });

    // seed the quota key at quota-1 (the tier default moves with pricing — read it back)
    const month = new Date().toISOString().slice(0, 7);
    const quotaOut = d1(['--command', `SELECT quota_monthly FROM keys WHERE id = '${quota.id}'`, '--json']);
    const quotaMonthly = Number(((JSON.parse(quotaOut)[0] || {}).results || [])[0]?.quota_monthly || 0);
    if (!quotaMonthly) throw new Error('smoke-quota key has no monthly quota — cannot test the boundary');
    const seedCount = quotaMonthly - 1;
    d1(['--command', `INSERT INTO usage (key_id, month, verify_count, bytes_total, updated_at) VALUES ('${quota.id}', '${month}', ${seedCount}, 0, '${new Date().toISOString()}') ON CONFLICT (key_id, month) DO UPDATE SET verify_count = ${seedCount};`]);
    console.log('  keys seeded (server/browser/test/quota/revoked)');

    // ---- boot upstream fixture server + wrangler boot A -----------------
    const upstream = startFixtureServer(PORT_UPSTREAM);
    console.log(`== fixture upstream on 127.0.0.1:${PORT_UPSTREAM} ==`);

    console.log('== boot A: wrangler dev --local (ALLOW_LOCAL_UPSTREAM=1) ==');
    const wranglerConfig = await writeContainerlessWranglerConfig(API_DIR);
    const childA = startWrangler(PORT_A, ['--var', 'ALLOW_LOCAL_UPSTREAM:1'], wranglerConfig);
    const children = [childA];
    const cleanup = async () => { for (const c of children) await stopChild(c); upstream.stop(true); };
    process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
    process.on('SIGTERM', async () => { await cleanup(); process.exit(130); });

    try {
        await waitHealth(childA, BASE_A);

        const C = readFileSync(join(FIXTURES, 'C.jpg'));
        const tampered = readFileSync(join(FIXTURES, 'tampered.jpg'));
        const dscf = readFileSync(join(FIXTURES, 'DSCF9243.jpg'));
        const gps = readFileSync(join(FIXTURES, 'gps.jpg'));
        const upstreamC = `http://127.0.0.1:${PORT_UPSTREAM}/C.jpg`;

        // -- 1. verify multipart C.jpg (server key) ------------------------
        {
            const r = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                form: multipart(C, 'C.jpg', 'image/jpeg'),
                headers: { origin: 'https://irrelevant.example.com' },
            });
            const rl = r.headers.get('ratelimit-policy') === '60;w=60' && r.headers.get('ratelimit-limit') === '60';
            const noAcao = !r.headers.get('access-control-allow-origin');
            row('verify multipart C.jpg → 200 valid_untrusted',
                r.status === 200 && r.json && r.json.status === 'valid_untrusted' && r.json.trust && r.json.trust.basis === 'none',
                `status=${r.status} verdict=${r.json && r.json.status}`);
            row('  RateLimit-Policy/Limit headers on success', rl, `policy=${r.headers.get('ratelimit-policy')} limit=${r.headers.get('ratelimit-limit')}`);
            row('  no ACAO for server key even with Origin sent', noAcao, `acao=${r.headers.get('access-control-allow-origin')}`);
            row('  response validates against VerifyResult schema',
                !!r.json && validateVerifyResult(r.json) === true,
                schemaErrors(validateVerifyResult));
        }

        // -- 1b. full include set validates against schema -------------------
        {
            const r = await req('POST', `${BASE_A}/v1/verify?include=exif,iptc,gps,thumbnails,raw_manifest&strip_gps=false`, {
                key: server.key,
                form: multipart(C, 'C.jpg', 'image/jpeg'),
            });
            row('full include set → 200 validates against VerifyResult schema',
                r.status === 200 && !!r.json && validateVerifyResult(r.json) === true
                && 'raw_manifest' in r.json && 'thumbnails' in r.json,
                `status=${r.status} ${r.json && !validateVerifyResult(r.json) ? schemaErrors(validateVerifyResult) : ''}`);
        }

        // -- 2. verify json base64 tampered.jpg → 200 invalid --------------
        {
            const r = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ data: tampered.toString('base64'), mime: 'image/jpeg' }),
            });
            row('verify json base64 tampered.jpg → 200 invalid',
                r.status === 200 && r.json && r.json.status === 'invalid',
                `status=${r.status} verdict=${r.json && r.json.status}`);
        }

        // -- 3. verify json url input via local upstream -------------------
        {
            const r = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: upstreamC }),
            });
            row('verify json url input → 200 valid_untrusted',
                r.status === 200 && r.json && r.json.status === 'valid_untrusted',
                `status=${r.status} verdict=${r.json && r.json.status}`);
        }

        // -- 3b. url input through a redirect chain → 200 -------------------
        {
            const r = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: `http://127.0.0.1:${PORT_UPSTREAM}/redirect-chain/C.jpg` }),
            });
            row('url input through 2-hop redirect chain → 200 valid_untrusted',
                r.status === 200 && r.json && r.json.status === 'valid_untrusted',
                `status=${r.status} verdict=${r.json && r.json.status}`);
        }

        // -- 3c. mini on manifest-less asset → Unverified shape --------------
        {
            const r = await req('GET', `${BASE_A}/v1/verify/mini?url=${encodeURIComponent(`http://127.0.0.1:${PORT_UPSTREAM}/A.jpg`)}`, { key: server.key });
            const j = r.json || {};
            row('mini on A.jpg (no manifest) → 200 Unverified null shape',
                r.status === 200 && j.status === 'Unverified' && j.creator === null && j.issued_by === null
                && j.trust && j.trust.state === null && j.trust.basis === null && typeof j.more === 'string',
                `status=${r.status} mini-status=${j.status}`);
        }

        // -- 4a. base64 upload of 20MiB+1 → 413 ----------------------------
        // The wire body here is ~28 MiB base64 — UNDER the 28 MiB raw cap — so
        // the 413 must come from the decoded-size check, not the transport cap.
        {
            const big = Buffer.alloc(MAX_SYNC_BYTES + 1, 7);
            const wireBytes = JSON.stringify({ data: big.toString('base64'), mime: 'image/jpeg' }).length;
            const r = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ data: big.toString('base64'), mime: 'image/jpeg' }),
            });
            row('base64 upload of 20MiB+1 → 413 payload_too_large + max_sync_bytes',
                r.status === 413 && problemShape(r.json, 'payload_too_large') && r.json.max_sync_bytes === MAX_SYNC_BYTES
                && wireBytes <= 28 * 1024 * 1024,
                `status=${r.status} code=${r.json && r.json.code} wire=${wireBytes}`);
        }

        // -- 4a-ii. exactly-at-cap 20 MiB asset IS accepted end-to-end --------
        // The contract caps the DECODED asset at 20 MiB — an exactly-at-cap
        // upload must verify (any verdict), through both transports.
        {
            const big = Buffer.concat([C, Buffer.alloc(MAX_SYNC_BYTES - C.length)]);
            const r = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ data: big.toString('base64'), mime: 'image/jpeg' }),
            });
            row('base64 exactly 20 MiB at-cap asset → 200 (accepted, not 413)',
                r.status === 200,
                `status=${r.status} verdict=${r.json && r.json.status}`);
        }

        // -- 4a-iii. raw body over the 28 MiB transport cap → 413 -------------
        {
            const huge = Buffer.alloc(21 * 1024 * 1024, 3); // base64 ≈ 29.4 MB on the wire
            const r = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ data: huge.toString('base64'), mime: 'image/jpeg' }),
            });
            row('raw body over the 28 MiB transport cap → 413 payload_too_large',
                r.status === 413 && problemShape(r.json, 'payload_too_large'),
                `status=${r.status} code=${r.json && r.json.code}`);
        }

        // -- 4b. multipart post-decode 20MiB+1 → 413 (bonus: exercises the
        //        post-decode cap rather than the raw-body pre-check) -------
        {
            const big = Buffer.concat([C, Buffer.alloc(MAX_SYNC_BYTES + 1 - C.length)]);
            const r = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                form: multipart(big, 'big.jpg', 'image/jpeg'),
            });
            row('multipart 20MiB+1 decoded → 413 payload_too_large',
                r.status === 413 && problemShape(r.json, 'payload_too_large') && r.json.max_sync_bytes === MAX_SYNC_BYTES,
                `status=${r.status} code=${r.json && r.json.code}`);
        }

        // -- 5. garbage bytes renamed .jpg → 422 reader failure ------------
        {
            const garbage = Buffer.from('this is definitely not a jpeg file, just some text bytes. '.repeat(20));
            const r = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                form: multipart(garbage, 'evil.jpg', 'image/jpeg'),
            });
            row('garbage renamed .jpg → 422 invalid_request',
                r.status === 422 && problemShape(r.json, 'invalid_request'),
                `status=${r.status} code=${r.json && r.json.code} detail=${r.json && r.json.detail}`);
        }

        // -- 5b. declared non-image content type, no image evidence → 415 --
        {
            const garbage = Buffer.from('plain text payload, no image magic here');
            const r = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ data: garbage.toString('base64'), mime: 'text/plain', filename: 'notes' }),
            });
            row('declared text/plain, no image evidence → 415 unsupported_media_type',
                r.status === 415 && problemShape(r.json, 'unsupported_media_type'),
                `status=${r.status} code=${r.json && r.json.code}`);
        }

        // -- 6. auth failures ----------------------------------------------
        {
            const r1 = await req('POST', `${BASE_A}/v1/verify`, { form: multipart(C, 'C.jpg', 'image/jpeg') });
            row('no auth → 401 unauthorized problem shape',
                r1.status === 401 && problemShape(r1.json, 'unauthorized'),
                `status=${r1.status} code=${r1.json && r1.json.code}`);

            const r2 = await req('POST', `${BASE_A}/v1/verify`, {
                key: 'c2pa_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                form: multipart(C, 'C.jpg', 'image/jpeg'),
            });
            row('garbage key → 401', r2.status === 401 && problemShape(r2.json, 'unauthorized'), `status=${r2.status}`);

            const r3 = await req('POST', `${BASE_A}/v1/verify`, {
                key: revoked.key,
                form: multipart(C, 'C.jpg', 'image/jpeg'),
            });
            row('revoked key → 403 forbidden', r3.status === 403 && problemShape(r3.json, 'forbidden'), `status=${r3.status}`);
        }

        // -- 7. browser key scoping + CORS ----------------------------------
        {
            const r1 = await req('POST', `${BASE_A}/v1/verify`, {
                key: browser.key,
                form: multipart(C, 'C.jpg', 'image/jpeg'),
            });
            row('browser key on /v1/verify → 403', r1.status === 403 && problemShape(r1.json, 'forbidden'), `status=${r1.status}`);

            const r2 = await req('GET', `${BASE_A}/v1/verify/mini?url=${encodeURIComponent(upstreamC)}`, { key: browser.key });
            row('browser key on /v1/verify/mini → 200', r2.status === 200 && r2.json && typeof r2.json.status === 'string', `status=${r2.status}`);

            const r3 = await req('GET', `${BASE_A}/v1/verify/mini?url=${encodeURIComponent(upstreamC)}`, {
                key: browser.key,
                headers: { origin: 'https://embed.example.com' },
            });
            row('browser key + allowed Origin → ACAO reflected',
                r3.status === 200 && r3.headers.get('access-control-allow-origin') === 'https://embed.example.com'
                && r3.headers.get('vary') === 'Origin',
                `acao=${r3.headers.get('access-control-allow-origin')}`);

            const r4 = await req('GET', `${BASE_A}/v1/verify/mini?url=${encodeURIComponent(upstreamC)}`, {
                key: browser.key,
                headers: { origin: 'https://evil.example.com' },
            });
            row('browser key + unlisted Origin → no ACAO',
                r4.status === 200 && !r4.headers.get('access-control-allow-origin'),
                `acao=${r4.headers.get('access-control-allow-origin')}`);

            const r5 = await fetch(`${BASE_A}/v1/verify/mini`, {
                method: 'OPTIONS',
                headers: {
                    origin: 'https://embed.example.com',
                    'access-control-request-method': 'GET',
                    'access-control-request-headers': 'authorization',
                },
            });
            row('OPTIONS preflight → 204 with correct headers',
                r5.status === 204
                && r5.headers.get('access-control-allow-origin') === 'https://embed.example.com'
                && r5.headers.get('access-control-allow-methods') === 'GET,POST'
                && r5.headers.get('access-control-allow-headers') === 'authorization,content-type'
                && r5.headers.get('access-control-max-age') === '86400',
                `status=${r5.status} methods=${r5.headers.get('access-control-allow-methods')} headers=${r5.headers.get('access-control-allow-headers')} maxage=${r5.headers.get('access-control-max-age')}`);

            const r6 = await fetch(`${BASE_A}/v1/verify/mini`, {
                method: 'OPTIONS',
                headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
            });
            row('OPTIONS preflight + unlisted Origin → 204, no ACAO',
                r6.status === 204 && !r6.headers.get('access-control-allow-origin'),
                `status=${r6.status} acao=${r6.headers.get('access-control-allow-origin')}`);
        }

        // -- 8. quota --------------------------------------------------------
        {
            const r1 = await req('POST', `${BASE_A}/v1/verify`, {
                key: quota.key,
                form: multipart(C, 'C.jpg', 'image/jpeg'),
            });
            // The usage increment lands off the response path (waitUntil), so a
            // fixed delay is racy. Poll until the guard flips to 429 — each
            // additional pre-quota 200 still converges because it increments the
            // count itself; report a missing write separately from a wrong verdict.
            let r2 = null;
            let converged = false;
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                r2 = await req('POST', `${BASE_A}/v1/verify`, {
                    key: quota.key,
                    form: multipart(C, 'C.jpg', 'image/jpeg'),
                });
                if (r2.status === 429) { converged = true; break; }
                await sleep(400);
            }
            row('quota: first verify at count quota-1 → 200 (reaches quota)',
                r1.status === 200, `status=${r1.status}`);
            row('quota: next verify → 429 quota_exceeded (polled until write landed)',
                converged && r2 && problemShape(r2.json, 'quota_exceeded'),
                `converged=${converged} status=${r2 && r2.status} code=${r2 && r2.json && r2.json.code}`);
        }

        // -- 8b. rotation carries usage to the successor -------------------
        {
            // One committed verification on the predecessor, then rotate:
            // finalize seeding must carry the count into the successor's
            // ledger row, the predecessor must die immediately, and the
            // successor's own verification must land on top of the carry.
            const rv = await req('POST', `${BASE_A}/v1/verify`, {
                key: rotation.key,
                form: multipart(C, 'C.jpg', 'image/jpeg'),
            });
            row('rotation: predecessor verify → 200', rv.status === 200, `status=${rv.status}`);

            // Let the off-path ledger write land before rotating.
            await sleep(1500);
            const rot = await req('POST', `${BASE_A}/v1/key/rotate`, { key: rotation.key, method: 'POST' });
            const successor = rot.json && rot.json.key;
            row('rotation: rotate → 200 with successor key',
                (rot.status === 200 || rot.status === 201) && typeof successor === 'string' && successor.startsWith('c2pa_live_'),
                `status=${rot.status} prefix=${rot.json && rot.json.display_prefix}`);

            const dead = await req('GET', `${BASE_A}/v1/usage`, { key: rotation.key });
            row('rotation: predecessor key rejected after rotation',
                dead.status === 401 || dead.status === 403, `status=${dead.status}`);

            if (successor) {
                const sv = await req('POST', `${BASE_A}/v1/verify`, {
                    key: successor,
                    form: multipart(C, 'C.jpg', 'image/jpeg'),
                });
                row('rotation: successor verify → 200', sv.status === 200, `status=${sv.status}`);
                // Poll usage until the successor's commit lands: carried 1 + own 1 = 2.
                let count = 0;
                const deadline = Date.now() + 10000;
                while (Date.now() < deadline) {
                    const u = await req('GET', `${BASE_A}/v1/usage`, { key: successor });
                    const months = (u.json && u.json.months) || [];
                    count = months[0] ? months[0].verify_count : 0;
                    if (count >= 2) break;
                    await sleep(400);
                }
                row('rotation: successor usage = carried 1 + own 1',
                    count === 2, `verify_count=${count}`);
            }
        }

        // -- 9. mini golden shape -------------------------------------------
        {
            const golden = JSON.parse(readFileSync(join(GOLDEN, 'C.jpg.c2paMini.json'), 'utf8'));
            const r = await req('GET', `${BASE_A}/v1/verify/mini?url=${encodeURIComponent(upstreamC)}`, { key: server.key });
            const j = r.json || {};
            const expectMore = `https://c2pa.creds.im/?uri=${encodeURIComponent(upstreamC)}`;
            row('mini golden-shape: creator/issued_by/dst/status match golden',
                r.status === 200
                && j.creator === golden.creator
                && j.issued_by === golden.issued_by
                && j.digital_source_type === golden.digital_source_type
                && j.status === golden.status
                && typeof j.issued_on === 'string' && j.issued_on.length > 0,
                `creator=${j.creator} status=${j.status} golden-status=${golden.status}`);
            row('mini trust block + more url',
                j.trust && j.trust.state === 'Valid' && j.trust.basis === 'none' && j.more === expectMore,
                `trust=${JSON.stringify(j.trust)} more=${j.more}`);
            row('mini response validates against MiniResult schema',
                !!j && validateMiniResult(j) === true,
                schemaErrors(validateMiniResult));
        }

        // -- 10. trust profiles ---------------------------------------------
        {
            const r1 = await req('POST', `${BASE_A}/v1/verify?trust=c2pa`, {
                key: server.key,
                form: multipart(dscf, 'DSCF9243.jpg', 'image/jpeg'),
            });
            row('DSCF9243 trust=c2pa → valid_untrusted / basis none',
                r1.status === 200 && r1.json && r1.json.status === 'valid_untrusted' && r1.json.trust.basis === 'none',
                `status=${r1.json && r1.json.status} basis=${r1.json && r1.json.trust && r1.json.trust.basis}`);

            const r2 = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                form: multipart(dscf, 'DSCF9243.jpg', 'image/jpeg'),
            });
            row('DSCF9243 default trust → trusted / basis interim_trust_list',
                r2.status === 200 && r2.json && r2.json.status === 'trusted' && r2.json.trust.basis === 'interim_trust_list',
                `status=${r2.json && r2.json.status} basis=${r2.json && r2.json.trust && r2.json.trust.basis}`);
        }

        // -- 11. strip_gps ----------------------------------------------------
        {
            const r1 = await req('POST', `${BASE_A}/v1/verify?include=exif,iptc,gps`, {
                key: server.key,
                form: multipart(gps, 'gps.jpg', 'image/jpeg'),
            });
            const t1 = r1.text || '';
            row('gps.jpg default strip_gps → metadata.gps null, no GPS strings',
                r1.status === 200 && r1.json && r1.json.metadata && r1.json.metadata.gps === null && !t1.includes('GPSLatitude') && !t1.includes('12.9716'),
                `gps=${JSON.stringify(r1.json && r1.json.metadata && r1.json.metadata.gps)} leak=${t1.includes('GPSLatitude')}`);

            const r2 = await req('POST', `${BASE_A}/v1/verify?include=exif,iptc,gps&strip_gps=false`, {
                key: server.key,
                form: multipart(gps, 'gps.jpg', 'image/jpeg'),
            });
            row('gps.jpg strip_gps=false → gps present',
                r2.status === 200 && r2.json && r2.json.metadata && r2.json.metadata.gps
                && String(r2.json.metadata.gps.latitude).startsWith('12.97')
                && String(r2.json.metadata.gps.longitude).startsWith('77.59'),
                `gps=${JSON.stringify(r2.json && r2.json.metadata && r2.json.metadata.gps)}`);

            // options as JSON body fields (spec: query wins over body)
            const r3 = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ data: gps.toString('base64'), mime: 'image/jpeg', include: 'gps', strip_gps: false }),
            });
            row('json body-field options (include/strip_gps) → gps present',
                r3.status === 200 && r3.json && r3.json.metadata && r3.json.metadata.gps
                && !('exif' in r3.json.metadata),
                `gps=${JSON.stringify(r3.json && r3.json.metadata && r3.json.metadata.gps)} exif-present=${r3.json && 'exif' in (r3.json.metadata || {})}`);

            const r4 = await req('POST', `${BASE_A}/v1/verify?strip_gps=true&include=exif,iptc,gps`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ data: gps.toString('base64'), mime: 'image/jpeg', strip_gps: false }),
            });
            row('query wins over body (strip_gps:true query vs false body) → gps null',
                r4.status === 200 && r4.json && r4.json.metadata && r4.json.metadata.gps === null,
                `gps=${JSON.stringify(r4.json && r4.json.metadata && r4.json.metadata.gps)}`);
        }

        // -- 12. public endpoints ---------------------------------------------
        {
            const r1 = await req('GET', `${BASE_A}/v1/trust-lists`);
            row('/v1/trust-lists → 200 no auth',
                r1.status === 200 && r1.json && r1.json.lists && r1.json.lists.c2pa && /^[0-9a-f]{64}$/.test(r1.json.lists.c2pa.sha256 || ''),
                `status=${r1.status}`);

            // Provenance assertion: all three published digests must equal the
            // sha256 of the bundled trust text — a missing entry or a stale
            // digest still has 64 hex chars and passes the format check above.
            {
                const { createHash } = await import('node:crypto');
                const digest = (f) => createHash('sha256').update(readFileSync(join(ROOT, 'trust', f), 'utf8')).digest('hex');
                const lists = r1.json && r1.json.lists ? r1.json.lists : {};
                const pairs = [
                    ['c2pa', digest('C2PA-TRUST-LIST.pem'), lists.c2pa && lists.c2pa.sha256],
                    ['itl', digest('ITL-anchors.pem'), lists.itl && lists.itl.sha256],
                    ['config', digest('store.cfg'), lists.config && lists.config.sha256],
                ];
                const mismatches = pairs.filter(([, local, published]) => local !== published);
                row('/v1/trust-lists digests match the bundled trust files (c2pa, itl, config)',
                    mismatches.length === 0,
                    mismatches.map(([n, l, p]) => `${n}: local=${String(l).slice(0, 12)} published=${String(p).slice(0, 12)}`).join(' '));
            }

            const r2 = await req('GET', `${BASE_A}/v1/openapi.json`);
            row('/v1/openapi.json → valid JSON, openapi 3.1.x',
                r2.status === 200 && r2.json && typeof r2.json.openapi === 'string' && r2.json.openapi.startsWith('3.1'),
                `status=${r2.status} openapi=${r2.json && r2.json.openapi}`);
        }

        // -- 13. input validation extras ---------------------------------------
        {
            const r1 = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ data: C.toString('base64'), url: upstreamC }),
            });
            row('json with both data+url → 422', r1.status === 422 && problemShape(r1.json, 'invalid_request'), `status=${r1.status}`);

            const r2 = await req('POST', `${BASE_A}/v1/verify?include=exif,bogus`, {
                key: server.key,
                form: multipart(C, 'C.jpg', 'image/jpeg'),
            });
            row('unknown include value → 422', r2.status === 422 && problemShape(r2.json, 'invalid_request'), `status=${r2.status}`);

            const r3 = await req('GET', `${BASE_A}/v1/verify/mini`, { key: server.key });
            row('mini missing url → 422', r3.status === 422 && problemShape(r3.json, 'invalid_request'), `status=${r3.status}`);

            const r4 = await req('POST', `${BASE_A}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'text/plain' },
                body: 'hello',
            });
            row('unsupported request content-type → 415', r4.status === 415 && problemShape(r4.json, 'unsupported_media_type'), `status=${r4.status}`);
        }

        // -- 14. test keys -------------------------------------------------------
        {
            const r1 = await req('POST', `${BASE_A}/v1/verify`, {
                key: test.key,
                form: multipart(C, 'C.jpg', 'image/jpeg'),
            });
            row('test key + corpus fixture → 200', r1.status === 200, `status=${r1.status}`);

            const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...Buffer.alloc(64)]);
            const r2 = await req('POST', `${BASE_A}/v1/verify`, {
                key: test.key,
                form: multipart(png, 'random.png', 'image/png'),
            });
            row('test key + non-corpus asset → 403 fixture-corpus detail',
                r2.status === 403 && problemShape(r2.json, 'forbidden') && /fixture corpus/.test(r2.json.detail || ''),
                `status=${r2.status} detail=${r2.json && r2.json.detail}`);
        }

        // -- 14b. strip_gps raw_manifest redaction rule (pure-logic unit row) ----
        // No signed fixture embeds GPS in its assertions, so the recursive
        // redaction is verified directly on a synthetic manifest shape.
        {
            const synthetic = {
                assertions: [
                    { label: 'stds.exif', data: { 'exif:Make': 'Canon', 'exif:GPSLatitude': 12.97, 'exif:GPSLongitude': 77.59 } },
                    { label: 'stds.schema-org.CreativeWork', data: { contentLocation: { latitude: 12.97, longitude: 77.59, name: 'place' } } },
                ],
                basic_info: { claim_generator: 'x' },
            };
            const redacted = redactGpsDeep(synthetic);
            const flat = JSON.stringify(redacted);
            row('strip_gps redaction: GPS keys dropped at any depth, non-GPS kept',
                !flat.includes('GPSLatitude') && !flat.includes('12.97') && !flat.includes('77.59')
                && redacted.assertions[0].data['exif:Make'] === 'Canon'
                && redacted.assertions[1].data.contentLocation.name === 'place'
                && !('latitude' in redacted.assertions[1].data.contentLocation)
                && flat.includes('Canon'),
                `redacted=${flat.slice(0, 140)}`);
        }

        // -- 15. rate limit headers present on success, redundant double-check --
        // (covered in row 1)
    } catch (e) {
        row(`boot A harness error: ${e.message}`, false);
    } finally {
        await stopChild(childA);
        await sleep(500);
    }

    // ---- boot B: SSRF guard fully active ---------------------------------
    console.log('== boot B: wrangler dev --local (SSRF guard fully active) ==');
    const childB = startWrangler(PORT_B, [], wranglerConfig);
    children.push(childB);
    try {
        await waitHealth(childB, BASE_B);
        for (const target of ['http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.1/']) {
            const r = await req('POST', `${BASE_B}/v1/verify`, {
                key: server.key,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: target }),
            });
            row(`SSRF: url ${target} rejected pre-fetch → 422 invalid_request`,
                r.status === 422 && problemShape(r.json, 'invalid_request') && /host not allowed/.test(r.json.detail || ''),
                `status=${r.status} code=${r.json && r.json.code} detail=${r.json && r.json.detail}`);
        }
    } catch (e) {
        row(`boot B harness error: ${e.message}`, false);
    } finally {
        await stopChild(childB);
        await sleep(500);
    }

    upstream.stop(true);

    // ---- summary -----------------------------------------------------------
    console.log('\n== smoke matrix summary ==');
    const width = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
    console.log(failures ? `\n${failures} smoke failure(s)` : '\nsmoke: all rows pass');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
