#!/usr/bin/env bun
// smoke-mcp.mjs — Phase 2 MCP smoke test for c2pa-verify-api.
//
//   bun scripts/smoke-mcp.mjs
//
// Boots `wrangler dev --local` for api/ with ALLOW_LOCAL_UPSTREAM=1, seeds
// local D1 keys, then speaks real MCP over Streamable HTTP with the pinned
// @modelcontextprotocol/sdk client. Exits nonzero on any failed row and
// kills every child process it starts.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'api');
const FIXTURES = join(ROOT, 'fixtures');
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');

const PORT_API = 8893;
const PORT_UPSTREAM = 8894;
const BASE = `http://localhost:${PORT_API}`;
const MCP_URL = new URL(`${BASE}/mcp`);

// VerifyResult validator — the same spec-loading approach as smoke-api.mjs.
const SPEC_DOC = parseYaml(readFileSync(join(ROOT, 'api/openapi.yaml'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ components: { schemas: SPEC_DOC.components.schemas } }, 'spec');
const validateVerifyResult = ajv.getSchema('spec#/components/schemas/VerifyResult');
function schemaErrors(v) { return JSON.stringify((v.errors || []).slice(0, 3)).slice(0, 400); }

let failures = 0;
const rows = [];
function row(name, pass, detail = '') {
    rows.push({ name, pass, detail });
    console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!pass) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        cwd: API_DIR,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    if (res.status !== 0) throw new Error(`d1 execute failed: ${res.stdout}\n${res.stderr}`);
    return res.stdout;
}

function d1Query(sql) {
    const out = d1(['--command', sql, '--json']);
    const parsed = JSON.parse(out);
    return (parsed[0] && parsed[0].results) || [];
}

async function portFree(port) {
    return new Promise((res) => {
        const srv = net.createServer();
        srv.once('error', () => res(false));
        srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
    });
}

function startWrangler(port) {
    const child = spawn(WRANGLER, ['dev', '--local', '--port', String(port), '--var', 'ALLOW_LOCAL_UPSTREAM:1'], {
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

async function waitHealth(child, timeoutMs = 90000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (child.exitCode !== null) throw new Error(`wrangler exited early (code ${child.exitCode})\n${child.log.slice(-2500)}`);
        try {
            const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
            if (r.ok) return;
        } catch { }
        await sleep(400);
    }
    throw new Error('wrangler dev did not become healthy in time');
}

function startFixtureServer(port) {
    return Bun.serve({
        port,
        hostname: '127.0.0.1',
        fetch(req) {
            const url = new URL(req.url);
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

async function connectClient(key, label = 'smoke') {
    const client = new Client(
        { name: `smoke-mcp-${label}`, version: '0.1.0' },
        { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(MCP_URL, {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
    });
    await client.connect(transport); // real initialize + notifications/initialized sequence
    return client;
}

async function closeClient(client) {
    if (!client) return;
    try { await client.close(); } catch { }
}

function textOf(result) {
    return ((result && result.content) || [])
        .filter((part) => part && part.type === 'text')
        .map((part) => part.text || '')
        .join('\n');
}

function toolError(result, pattern = null) {
    if (!result || result.isError !== true) return false;
    if (!pattern) return true;
    return pattern.test(textOf(result));
}

function sortedJson(value) {
    return JSON.stringify([...value].sort());
}

function initializeBody() {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'smoke-mcp-raw', version: '0.1.0' },
        },
    });
}

async function rawInitialize(key) {
    const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
    };
    if (key) headers.authorization = `Bearer ${key}`;
    const resp = await fetch(MCP_URL, { method: 'POST', headers, body: initializeBody() });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { }
    return { status: resp.status, headers: resp.headers, text, json };
}

function usageFor(keyId, month) {
    const rowsOut = d1Query(`SELECT verify_count, bytes_total FROM usage WHERE key_id = '${keyId}' AND month = '${month}';`);
    return rowsOut.length ? rowsOut[0].verify_count : 0;
}

// ------------------------------------------------------------------ main --

async function main() {
    for (const p of [PORT_API, PORT_UPSTREAM]) {
        if (!(await portFree(p))) {
            console.error(`port ${p} is not free — refusing to start`);
            process.exit(1);
        }
    }

    console.log('== seeding local D1 ==');
    d1(['--file', 'migrations/0001_init.sql']);
    const server = keyctl(['create', '--name', 'mcp-smoke-server', '--type', 'server', '--tier', 'pro']);
    const meter = keyctl(['create', '--name', 'mcp-smoke-meter', '--type', 'server', '--tier', 'pro']);
    const quota = keyctl(['create', '--name', 'mcp-smoke-quota', '--type', 'server', '--tier', 'free']);
    const testKey = keyctl(['create', '--name', 'mcp-smoke-test', '--type', 'server', '--tier', 'free', '--test']);
    const revoked = keyctl(['create', '--name', 'mcp-smoke-revoked', '--type', 'server', '--tier', 'free']);
    spawnSync('bun', ['scripts/keyctl.mjs', 'revoke', '--id', revoked.id], { cwd: ROOT, encoding: 'utf8' });

    const month = new Date().toISOString().slice(0, 7);
    d1(['--command', `INSERT INTO usage (key_id, month, verify_count, bytes_total, updated_at) VALUES ('${quota.id}', '${month}', 499, 0, '${new Date().toISOString()}') ON CONFLICT (key_id, month) DO UPDATE SET verify_count = 499;`]);
    console.log('  keys seeded (server/meter/quota/revoked)');

    const upstream = startFixtureServer(PORT_UPSTREAM);
    console.log(`== fixture upstream on 127.0.0.1:${PORT_UPSTREAM} ==`);
    console.log('== boot: wrangler dev --local (ALLOW_LOCAL_UPSTREAM=1) ==');
    const child = startWrangler(PORT_API);
    const clients = [];

    const cleanup = async () => {
        for (const c of clients.splice(0)) await closeClient(c);
        await stopChild(child);
        upstream.stop(true);
    };
    process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
    process.on('SIGTERM', async () => { await cleanup(); process.exit(130); });

    try {
        await waitHealth(child);

        const C = readFileSync(join(FIXTURES, 'C.jpg'));
        const urlFor = (name) => `http://127.0.0.1:${PORT_UPSTREAM}/${name}`;

        // -- handshake, tool/resource surface --------------------------------
        const client = await connectClient(server.key, 'main');
        clients.push(client);

        const version = client.getServerVersion() || {};
        const instructions = client.getInstructions() || '';
        row('initialize handshake: server identity + instructions',
            version.name === 'c2pa-verify-api'
            && typeof version.version === 'string'
            && instructions.includes('does not determine whether the image itself is real')
            && instructions.includes('verify_image_detailed'),
            `server=${version.name}@${version.version}`);

        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name);
        row('tools/list exactly the phase-2 tool set (no jobs tools)',
            sortedJson(names) === sortedJson(['verify_image', 'verify_image_detailed', 'explain_validation_code', 'list_trust_lists']),
            names.join(','));

        const resources = await client.listResources();
        row('resources/list exposes exactly trust://current',
            resources.resources.length === 1 && resources.resources[0].uri === 'trust://current',
            resources.resources.map((r) => r.uri).join(',') || '(none)');
        const trustResource = await client.readResource({ uri: 'trust://current' });
        const trustResourceText = trustResource.contents && trustResource.contents[0] && trustResource.contents[0].text;
        let trustResourceJson = null;
        try { trustResourceJson = JSON.parse(trustResourceText || ''); } catch { }
        row('trust://current reads as trust-list JSON',
            !!trustResourceJson && !!trustResourceJson.lists && /^[0-9a-f]{64}$/.test((trustResourceJson.lists.c2pa || {}).sha256 || ''),
            `contents=${(trustResource.contents || []).length}`);

        // -- verify_image over url inputs ------------------------------------
        const urlCases = [
            ['C.jpg', 'valid_untrusted', 'none'],
            ['DSCF9243.jpg', 'trusted', 'interim_trust_list'],
            // Invalid manifests do not necessarily evaluate to a trust basis;
            // the contract assertion here is the rolled-up invalid verdict.
            ['tampered.jpg', 'invalid', undefined],
            ['A.jpg', 'no_manifest', null],
        ];
        for (const [file, expectedStatus, expectedBasis] of urlCases) {
            const r = await client.callTool({ name: 'verify_image', arguments: { url: urlFor(file) } });
            const sc = r.structuredContent || {};
            const basisPass = expectedBasis === undefined || (sc.trust && sc.trust.basis === expectedBasis);
            row(`verify_image url ${file} → ${expectedStatus}`,
                r.isError !== true
                && sc.status === expectedStatus
                && basisPass
                && sc.asset && typeof sc.asset.sha256 === 'string'
                && Array.isArray(sc.validation_failures),
                `status=${sc.status} basis=${sc.trust && sc.trust.basis} isError=${r.isError || false}`);
        }

        {
            const r = await client.callTool({ name: 'verify_image', arguments: { url: urlFor('C.jpg') } });
            const sc = r.structuredContent || {};
            const expectedKeys = ['asset', 'claim_generator', 'digital_source_type', 'signer', 'status', 'thumbnail', 'trust', 'validation_failures'];
            row('verify_image compact card has exactly the compact key set',
                sortedJson(Object.keys(sc)) === sortedJson(expectedKeys)
                && sc.trust && sortedJson(Object.keys(sc.trust)) === sortedJson(['state', 'basis'])
                && typeof sc.thumbnail === 'boolean',
                `keys=${Object.keys(sc).sort().join(',')}`);
        }

        // -- detailed output validates against the REST VerifyResult schema --
        {
            const r = await client.callTool({
                name: 'verify_image_detailed',
                arguments: { url: urlFor('C.jpg'), include: ['exif', 'iptc'], strip_gps: true },
            });
            const sc = r.structuredContent;
            row('verify_image_detailed structuredContent validates as VerifyResult',
                r.isError !== true && !!sc && validateVerifyResult(sc) === true,
                `status=${sc && sc.status}${sc && !validateVerifyResult(sc) ? ` schema=${schemaErrors(validateVerifyResult)}` : ''}`);
            row('verify_image_detailed text mirrors structuredContent JSON',
                !!sc && JSON.stringify(JSON.parse(textOf(r))) === JSON.stringify(sc));
        }

        // -- explain_validation_code ------------------------------------------
        {
            const known = await client.callTool({ name: 'explain_validation_code', arguments: { code: 'claimSignature.mismatch' } });
            row('explain_validation_code claimSignature.mismatch → severity error',
                known.isError !== true && known.structuredContent && known.structuredContent.severity === 'error'
                && Array.isArray(known.structuredContent.common_causes),
                `severity=${known.structuredContent && known.structuredContent.severity}`);

            const unknown = await client.callTool({ name: 'explain_validation_code', arguments: { code: 'future.unknownCode' } });
            row('explain_validation_code unknown code → generic info entry',
                unknown.isError !== true && unknown.structuredContent
                && unknown.structuredContent.severity === 'info'
                && unknown.structuredContent.title === 'Unknown validation code',
                `title=${unknown.structuredContent && unknown.structuredContent.title}`);
        }

        // -- list_trust_lists ---------------------------------------------------
        {
            const r = await client.callTool({ name: 'list_trust_lists', arguments: {} });
            const rest = await fetch(`${BASE}/v1/trust-lists`).then((x) => x.json());
            const sc = r.structuredContent || {};
            row('list_trust_lists matches GET /v1/trust-lists',
                r.isError !== true
                && sc.lists && rest.lists
                && sc.lists.c2pa && rest.lists.c2pa && sc.lists.c2pa.sha256 === rest.lists.c2pa.sha256
                && /^[0-9a-f]{64}$/.test(sc.lists.c2pa.sha256 || ''),
                `c2pa=${sc.lists && sc.lists.c2pa && String(sc.lists.c2pa.sha256).slice(0, 12)}`);
        }

        // -- input validation and corrupt-input tool errors ---------------------
        {
            const c64 = C.toString('base64');
            const badBoth = await client.callTool({
                name: 'verify_image',
                arguments: { url: urlFor('C.jpg'), data: c64, mime: 'image/jpeg' },
            });
            row('verify_image both url+data → tool error', toolError(badBoth, /exactly one of data or url/), textOf(badBoth));

            const badNeither = await client.callTool({ name: 'verify_image', arguments: {} });
            row('verify_image neither url nor data → tool error', toolError(badNeither, /exactly one of data or url/), textOf(badNeither));

            const badBase64 = await client.callTool({
                name: 'verify_image',
                arguments: { data: '%%%not-valid-base64%%%', mime: 'image/jpeg' },
            });
            row('garbage base64 → clean tool error, not a crash', toolError(badBase64), textOf(badBase64).slice(0, 120));

            const garbageBytes = Buffer.from('definitely not a jpeg — just text bytes').toString('base64');
            const badData = await client.callTool({
                name: 'verify_image',
                arguments: { data: garbageBytes, mime: 'image/jpeg' },
            });
            row('base64-encoded garbage bytes → clean tool error matching REST 422 style',
                toolError(badData, /could not be read|corrupt|unparseable/), textOf(badData));
        }

        // -- metering and base64 input ------------------------------------------
        const meterClient = await connectClient(meter.key, 'metering');
        clients.push(meterClient);
        {
            const before = usageFor(meter.id, month);
            const ex1 = await meterClient.callTool({ name: 'explain_validation_code', arguments: { code: 'timeStamp.mismatch' } });
            await sleep(500);
            const afterExplain = usageFor(meter.id, month);
            row('metering: explain_validation_code does not increment usage',
                ex1.isError !== true && before === 0 && afterExplain === before,
                `before=${before} after=${afterExplain}`);

            const ok = await meterClient.callTool({
                name: 'verify_image',
                arguments: { data: C.toString('base64'), mime: 'image/jpeg' },
            });
            await sleep(1500); // let ctx.waitUntil increment land
            const afterVerify = usageFor(meter.id, month);
            row('verify_image base64 data input works and increments usage exactly once',
                ok.isError !== true && ok.structuredContent && ok.structuredContent.status === 'valid_untrusted'
                && afterVerify === before + 1,
                `status=${ok.structuredContent && ok.structuredContent.status} before=${before} after=${afterVerify}`);

            const ex2 = await meterClient.callTool({ name: 'explain_validation_code', arguments: { code: 'assertion.dataHash.mismatch' } });
            await sleep(500);
            const afterSecondExplain = usageFor(meter.id, month);
            row('metering remains unchanged after another free explain call',
                ex2.isError !== true && afterSecondExplain === afterVerify,
                `afterVerify=${afterVerify} afterExplain=${afterSecondExplain}`);
        }

        // -- test-key sandbox behavior is inherited through the shared pipeline ---
        const testClient = await connectClient(testKey.key, 'test-key');
        clients.push(testClient);
        {
            const before = usageFor(testKey.id, month);
            const corpus = await testClient.callTool({
                name: 'verify_image',
                arguments: { data: C.toString('base64'), mime: 'image/jpeg' },
            });
            await sleep(1200);
            const afterCorpus = usageFor(testKey.id, month);
            row('test key verifies fixture corpus through MCP and remains unmetered',
                corpus.isError !== true && corpus.structuredContent && corpus.structuredContent.status === 'valid_untrusted'
                && before === 0 && afterCorpus === 0,
                `status=${corpus.structuredContent && corpus.structuredContent.status} usage=${afterCorpus}`);

            const nonCorpus = await testClient.callTool({
                name: 'verify_image',
                arguments: { data: Buffer.from('not part of the fixture corpus').toString('base64'), mime: 'image/jpeg' },
            });
            row('test key rejects non-corpus MCP input before verification work',
                toolError(nonCorpus, /test keys only accept the fixture corpus/), textOf(nonCorpus));
        }

        // -- quota enforcement ---------------------------------------------------
        const quotaClient = await connectClient(quota.key, 'quota');
        clients.push(quotaClient);
        {
            const first = await quotaClient.callTool({ name: 'verify_image', arguments: { url: urlFor('C.jpg') } });
            await sleep(1500);
            const second = await quotaClient.callTool({ name: 'verify_image', arguments: { url: urlFor('C.jpg') } });
            row('quota: verify at count 499 succeeds, next verify is rejected as a tool error',
                first.isError !== true && toolError(second, /Monthly quota of 500 verifications exhausted/),
                `first=${first.isError || false} secondError=${textOf(second)}`);
        }

        // -- auth at the HTTP layer ---------------------------------------------
        {
            const missing = await rawInitialize(null);
            const invalid = await rawInitialize('c2pa_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            const revokedRaw = await rawInitialize(revoked.key);
            const validShape = (r) => r.status === 401
                && r.headers.get('www-authenticate') === 'Bearer'
                && r.json && r.json.status === 401 && r.json.code === 'unauthorized';
            row('missing key → HTTP 401 + WWW-Authenticate + problem body',
                validShape(missing), `status=${missing.status} code=${missing.json && missing.json.code}`);
            row('invalid key → HTTP 401 + WWW-Authenticate + problem body',
                validShape(invalid), `status=${invalid.status} code=${invalid.json && invalid.json.code}`);
            row('revoked key → HTTP 401 + WWW-Authenticate + problem body',
                validShape(revokedRaw), `status=${revokedRaw.status} code=${revokedRaw.json && revokedRaw.json.code}`);

            let clientError = null;
            try {
                const badClient = await connectClient('c2pa_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'unauthorized');
                clients.push(badClient);
            } catch (e) {
                clientError = e;
            }
            row('real SDK client surfaces missing/invalid auth as HTTP 401 connect failure',
                !!clientError && clientError.code === 401 && /POSTing to endpoint/.test(clientError.message || ''),
                clientError ? `${clientError.constructor.name}: ${String(clientError.message).split('\n')[0].slice(0, 100)}` : 'no error');
        }

        // -- CORS preflight remains the MCP handler's wildcard default ----------
        {
            const preflight = await fetch(MCP_URL, {
                method: 'OPTIONS',
                headers: { 'access-control-request-method': 'POST' },
            });
            row('OPTIONS /mcp without Origin → wildcard MCP CORS, unauthenticated',
                preflight.status === 200
                && preflight.headers.get('access-control-allow-origin') === '*'
                && (preflight.headers.get('access-control-allow-methods') || '').includes('POST'),
                `status=${preflight.status} acao=${preflight.headers.get('access-control-allow-origin')}`);
        }
    } catch (e) {
        row(`harness error: ${e.message}`, false);
        if (child.log) console.log('--- wrangler output (tail) ---\n' + child.log.split('\n').slice(-35).join('\n'));
    } finally {
        await cleanup();
        await sleep(500);
    }

    console.log('\n== smoke-mcp summary ==');
    const width = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
    console.log(failures ? `\n${failures} smoke-mcp failure(s)` : '\nsmoke-mcp: all rows pass');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
