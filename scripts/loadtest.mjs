#!/usr/bin/env bun
// loadtest.mjs — local Phase 1 load/memory measurement for c2pa-verify-api.
//
//   bun scripts/loadtest.mjs
//
// Phases:
//   (a) 50 sequential POST /v1/verify measurements of fixtures/C.jpg;
//   (b) concurrency sweeps of 5, 10 and 25 parallel workers, 40 requests
//       total at each level, all C.jpg;
//   (c) 10 sequential verifies of fixtures/big/pad-15mb.jpg (regenerated as
//       C.jpg zero-padded after EOI when missing).
//
// Summed workerd RSS is sampled every 50 ms throughout the run. Raw request
// data and RSS samples are written to docs/loadtest-results.json.
//
// IMPORTANT: local wall/CPU/RSS numbers are not the production Cloudflare
// budget. This is a macOS/Linux workstation running workerd outside the
// production isolate constraints; production evidence comes from the deployed
// measurement in Task I.

import { spawn, spawnSync, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateKey, sha256HexText } from '../api/src/keys-mw.js';

const execFileP = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'api');
const FIXTURES = join(ROOT, 'fixtures');
const OUT = join(ROOT, 'docs/loadtest-results.json');
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');
const SAMPLE_MS = 50;
const PAD15 = join(FIXTURES, 'big/pad-15mb.jpg');
const PAD15_BYTES = 15 * 1024 * 1024;
const CPU_BUDGET_NOTE = 'Local CPU/wall/RSS are not the production Cloudflare isolate budget: this measures a workstation workerd process, not the production CPU/memory cap. Production numbers come from the deployed Task I measurement.';

// -------------------------------------------------------------- utilities --

function sqlQuote(v) {
    if (v === null || v === undefined) return 'NULL';
    return `'${String(v).replaceAll("'", "''")}'`;
}

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
        maxBuffer: 32 * 1024 * 1024,
    });
    if (res.status !== 0) throw new Error(`d1 execute failed: ${res.stdout}\n${res.stderr}`);
}

function startWrangler(port) {
    const child = spawn(WRANGLER, ['dev', '--local', '--port', String(port)], {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- RSS sampler --

// One ps spawn per sample, filtered in JS. If a spawn is still in flight at
// the next tick, skip the tick rather than stacking process spawns.
async function totalWorkerdRssKb() {
    try {
        const { stdout } = await execFileP('ps', ['-eo', 'pid=,rss=,args='], {
            maxBuffer: 16 * 1024 * 1024,
        });
        let kb = 0;
        for (const line of stdout.split('\n')) {
            if (!/workerd/.test(line)) continue;
            const m = line.trim().match(/^(\d+)\s+(\d+)/);
            if (m) kb += parseInt(m[2], 10);
        }
        return kb;
    } catch {
        return 0;
    }
}

class RssSampler {
    constructor(intervalMs) {
        this.intervalMs = intervalMs;
        this.samples = [];
        this.startedAt = performance.now();
        this.inflight = null;
        this.timer = null;
    }
    start() {
        this.tick();
        this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
    tick() {
        if (this.inflight) return;
        this.inflight = totalWorkerdRssKb()
            .then((kb) => {
                this.samples.push({ t_ms: +(performance.now() - this.startedAt).toFixed(1), rss_kb: kb });
            })
            .finally(() => { this.inflight = null; });
    }
    index() { return this.samples.length; }
    slice(start, end) { return this.samples.slice(start, end); }
    async stop() {
        if (this.timer) clearInterval(this.timer);
        if (this.inflight) await this.inflight;
    }
}

// --------------------------------------------------------------- statistics --

function percentileNearest(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function wallStats(requests) {
    const walls = requests.map((r) => r.wall_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    return {
        count: walls.length,
        p50_ms: percentileNearest(walls, 50),
        p95_ms: percentileNearest(walls, 95),
        max_ms: walls.length ? walls[walls.length - 1] : null,
    };
}

function median(values) {
    if (!values.length) return null;
    const xs = [...values].sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function mb(kb) {
    return kb === null || kb === undefined ? null : +(kb / 1024).toFixed(1);
}

// plateau definition: median RSS over the final two seconds of load in the
// phase (or all samples when the phase is shorter), representing warm RSS
// rather than a transient spike.
function rssStats(samples, baselineKb) {
    if (!samples.length) {
        return {
            baseline_rss_mb: mb(baselineKb),
            peak_rss_mb: null,
            plateau_rss_mb: null,
            end_rss_mb: null,
            sample_count: 0,
        };
    }
    const values = samples.map((s) => s.rss_kb);
    const endT = samples[samples.length - 1].t_ms;
    const tail = samples.filter((s) => s.t_ms >= endT - 2000).map((s) => s.rss_kb);
    return {
        baseline_rss_mb: mb(baselineKb),
        peak_rss_mb: mb(Math.max(...values)),
        plateau_rss_mb: mb(median(tail.length ? tail : values)),
        end_rss_mb: mb(values[values.length - 1]),
        sample_count: samples.length,
    };
}

// Recovery definition used consistently in the JSON and summary: post-idle
// RSS is within the larger of 10% or 16 MiB of the phase baseline. Memory
// allocators are not required to return memory to the OS, so the raw numbers
// matter as much as this boolean.
function recovered(postIdleKb, baselineKb) {
    if (!postIdleKb || !baselineKb) return false;
    return postIdleKb <= baselineKb + Math.max(16 * 1024, baselineKb * 0.10);
}

// --------------------------------------------------------------- requests --

function multipart(fileBytes, filename) {
    const form = new FormData();
    form.append('file', new Blob([fileBytes], { type: 'image/jpeg' }), filename);
    return form;
}

async function verifyOnce(base, key, bytes, filename, meta = {}) {
    const t0 = performance.now();
    let status = 0;
    let json = null;
    let error = null;
    try {
        const resp = await fetch(`${base}/v1/verify`, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}` },
            body: multipart(bytes, filename),
            signal: AbortSignal.timeout(180000),
        });
        status = resp.status;
        const text = await resp.text();
        try { json = JSON.parse(text); } catch { }
        if (!json) error = text.slice(0, 300);
    } catch (e) {
        error = String(e && e.message ? e.message : e);
    }
    const wallMs = +(performance.now() - t0).toFixed(1);
    return {
        ...meta,
        http_status: status,
        wall_ms: wallMs,
        ok: status === 200,
        verdict: json && json.status ? json.status : null,
        trust_basis: json && json.trust ? json.trust.basis : null,
        problem_code: json && json.code ? json.code : null,
        error: status === 200 ? null : (json && json.detail) || error,
    };
}

async function runConcurrent({ base, bytes, filename, total, concurrency, keys, phase }) {
    const results = new Array(total);
    let next = 0;
    async function worker(workerIndex) {
        const key = keys[workerIndex].plaintext;
        for (;;) {
            const i = next++;
            if (i >= total) return;
            results[i] = await verifyOnce(base, key, bytes, filename, {
                phase,
                request_index: i + 1,
                worker_index: workerIndex + 1,
                concurrency,
            });
        }
    }
    await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
    return results;
}

// ------------------------------------------------------------ seed keys --

async function seedKeyPool(count) {
    // 25 keyctl invocations would spend tens of seconds shelling out to
    // wrangler. Use the same key primitives and insert the worker pool in one
    // D1 statement; plaintext keys remain only in this process's memory.
    const keys = [];
    const rows = [];
    const now = new Date().toISOString();
    for (let i = 0; i < count; i++) {
        const { plaintext, displayPrefix } = generateKey('live');
        const hash = await sha256HexText(plaintext);
        const id = crypto.randomUUID();
        keys.push({ plaintext, id, displayPrefix });
        rows.push(`(${sqlQuote(id)}, ${sqlQuote(hash)}, ${sqlQuote(displayPrefix)}, ${sqlQuote(`load-worker-${i + 1}`)}, 'server', 'pro', '["verify"]', NULL, NULL, ${sqlQuote(now)})`);
    }
    d1(['--command', `INSERT INTO keys (id, key_hash, display_prefix, name, type, tier, scopes, quota_monthly, allowed_origins, created_at) VALUES ${rows.join(',')};`]);
    return keys;
}

function ensurePad15() {
    if (existsSync(PAD15)) return;
    const c = readFileSync(join(FIXTURES, 'C.jpg'));
    if (PAD15_BYTES <= c.length) throw new Error('C.jpg is unexpectedly larger than the pad-15mb target');
    mkdirSync(dirname(PAD15), { recursive: true });
    // The original fixture ends in EOI (ffd9); appending zeroes therefore pads
    // after EOI, matching the spike-fixture generation method.
    writeFileSync(PAD15, Buffer.concat([c, Buffer.alloc(PAD15_BYTES - c.length)]));
    console.log('generated fixtures/big/pad-15mb.jpg by zero-padding C.jpg after EOI');
}

// ------------------------------------------------------------------- main --

async function main() {
    ensurePad15();
    const C = readFileSync(join(FIXTURES, 'C.jpg'));
    const pad15 = readFileSync(PAD15);

    console.log('== seeding local D1 ==');
    d1(['--file', 'migrations/0001_init.sql']);
    const primary = keyctl(['create', '--name', 'load-primary', '--type', 'server', '--tier', 'pro']);
    const workerKeys = await seedKeyPool(25);
    console.log('  primary key + 25 worker keys seeded (plaintext keys not printed)');

    const port = await freePort();
    const base = `http://localhost:${port}`;
    console.log(`== wrangler dev --local on port ${port} ==`);
    const child = startWrangler(port);

    const cleanup = async () => { await stopChild(child); };
    process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
    process.on('SIGTERM', async () => { await cleanup(); process.exit(130); });

    const sampler = new RssSampler(SAMPLE_MS);
    const result = {
        generated_at: new Date().toISOString(),
        protocol: {
            sample_ms: SAMPLE_MS,
            phases: {
                a_sequential_small: { fixture: 'C.jpg', requests: 50, concurrency: 1 },
                b_concurrency_sweep: { fixture: 'C.jpg', concurrency_levels: [5, 10, 25], requests_per_level: 40 },
                c_sequential_pad15: { fixture: 'big/pad-15mb.jpg', requests: 10, concurrency: 1 },
            },
            rss_plateau_definition: 'median summed workerd RSS over the final two seconds of load in the phase',
            rss_recovery_definition: 'post-10s-idle RSS within the larger of 10% or 16 MiB of the phase baseline',
            rate_limit_note: 'Phase A/C share one fresh primary key (exactly 60 total requests, within the 60/min/key limit). Concurrency workers use distinct fresh keys so the sweep measures verification capacity rather than deliberate per-key throttling.',
            cpu_budget_note: CPU_BUDGET_NOTE,
        },
        environment: {
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            cpu_model: os.cpus()[0] && os.cpus()[0].model,
            total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
            bun_version: Bun.version,
            wrangler_version: JSON.parse(readFileSync(join(ROOT, 'node_modules/wrangler/package.json'), 'utf8')).version,
        },
        phases: {},
    };

    // Preserve a deployed measurement if this file already has one (Task I).
    try {
        const prev = JSON.parse(readFileSync(OUT, 'utf8'));
        if (prev.deployed) result.deployed = prev.deployed;
    } catch { }

    let harnessError = null;
    try {
        await waitHealth(child, base);
        console.log('healthy; starting RSS sampler');
        sampler.start();

        async function runLoadPhase(name, execute) {
            const baselineKb = await totalWorkerdRssKb();
            const startIndex = sampler.index();
            const startedAt = new Date().toISOString();
            const t0 = performance.now();
            const data = await execute();
            const elapsedMs = +(performance.now() - t0).toFixed(1);
            const endIndex = sampler.index();
            const loadSamples = sampler.slice(startIndex, endIndex);

            const idleStartIndex = sampler.index();
            await sleep(10000);
            const idleEndIndex = sampler.index();
            const idleSamples = sampler.slice(idleStartIndex, idleEndIndex);
            const postIdleKb = idleSamples.length ? idleSamples[idleSamples.length - 1].rss_kb : await totalWorkerdRssKb();

            return {
                ...data,
                started_at: startedAt,
                elapsed_ms: elapsedMs,
                rss: rssStats(loadSamples, baselineKb),
                idle_10s: {
                    post_idle_rss_mb: mb(postIdleKb),
                    recovered: recovered(postIdleKb, baselineKb),
                    sample_count: idleSamples.length,
                },
                rss_samples: loadSamples,
                idle_rss_samples: idleSamples,
                name,
            };
        }

        console.log('\n== phase A: 50 sequential verifies of C.jpg ==');
        const phaseA = await runLoadPhase('a_sequential_small', async () => {
            const requests = [];
            for (let i = 0; i < 50; i++) {
                const r = await verifyOnce(base, primary.key, C, 'C.jpg', {
                    phase: 'a_sequential_small',
                    request_index: i + 1,
                    concurrency: 1,
                    cold_start: i === 0,
                });
                requests.push(r);
                if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/50 complete`);
            }
            return { requests, wall: wallStats(requests), failures: requests.filter((r) => !r.ok).length };
        });
        result.phases.a_sequential_small = phaseA;

        console.log('\n== phase B: concurrency sweep 5/10/25 × 40 total requests ==');
        async function sweep(concurrency) {
            const baselineKb = await totalWorkerdRssKb();
            const startIndex = sampler.index();
            const t0 = performance.now();
            const requests = await runConcurrent({
                base,
                bytes: C,
                filename: 'C.jpg',
                total: 40,
                concurrency,
                keys: workerKeys,
                phase: `b_concurrency_${concurrency}`,
            });
            const elapsedMs = +(performance.now() - t0).toFixed(1);
            const endIndex = sampler.index();
            const rss_samples = sampler.slice(startIndex, endIndex);
            return {
                concurrency,
                total_requests: 40,
                elapsed_ms: elapsedMs,
                requests,
                wall: wallStats(requests),
                failures: requests.filter((r) => !r.ok).length,
                rss: rssStats(rss_samples, baselineKb),
                rss_samples,
            };
        }

        const phaseB = await runLoadPhase('b_concurrency_sweep', async () => {
            const sweeps = [];
            for (const concurrency of [5, 10, 25]) {
                console.log(`  concurrency ${concurrency}: 40 requests`);
                sweeps.push(await sweep(concurrency));
            }
            const allRequests = sweeps.flatMap((s) => s.requests);
            return {
                sweeps,
                requests: allRequests,
                wall: wallStats(allRequests),
                failures: allRequests.filter((r) => !r.ok).length,
            };
        });
        result.phases.b_concurrency_sweep = phaseB;

        console.log('\n== phase C: 10 sequential verifies of big/pad-15mb.jpg ==');
        const phaseC = await runLoadPhase('c_sequential_pad15', async () => {
            const requests = [];
            for (let i = 0; i < 10; i++) {
                const r = await verifyOnce(base, primary.key, pad15, 'pad-15mb.jpg', {
                    phase: 'c_sequential_pad15',
                    request_index: i + 1,
                    concurrency: 1,
                });
                requests.push(r);
                console.log(`  ${i + 1}/10 complete status=${r.http_status} wall=${r.wall_ms}ms`);
            }
            return { requests, wall: wallStats(requests), failures: requests.filter((r) => !r.ok).length };
        });
        result.phases.c_sequential_pad15 = phaseC;
    } catch (e) {
        harnessError = e;
        console.error(`harness error: ${e.message}`);
        if (child.log) console.error('--- wrangler output (tail) ---\n' + child.log.split('\n').slice(-30).join('\n'));
    } finally {
        await sampler.stop();
        await cleanup();
        await sleep(700);
    }

    // Include the full continuous sample series once; per-phase slices above
    // make phase attribution easy without duplicating the whole series.
    result.continuous_rss_samples = sampler.samples;
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(result, null, 2));

    console.log(`\nNOTE: ${CPU_BUDGET_NOTE}`);
    console.log('\n== load summary ==');
    console.log('phase                         reqs  conc  fail    p50ms    p95ms    maxms   peakRSS  plateauRSS  postIdleRSS  recovered');
    console.log('-'.repeat(125));
    const printRow = (label, reqs, conc, failures, wall, rss, idle) => {
        const fmt = (v, w) => String(v ?? '-').padStart(w);
        console.log(
            label.padEnd(28) +
            fmt(reqs, 5) + fmt(conc, 6) + fmt(failures, 6) +
            fmt(wall && wall.p50_ms != null ? Math.round(wall.p50_ms) : '-', 9) +
            fmt(wall && wall.p95_ms != null ? Math.round(wall.p95_ms) : '-', 9) +
            fmt(wall && wall.max_ms != null ? Math.round(wall.max_ms) : '-', 9) +
            fmt(rss && rss.peak_rss_mb != null ? rss.peak_rss_mb : '-', 10) +
            fmt(rss && rss.plateau_rss_mb != null ? rss.plateau_rss_mb : '-', 12) +
            fmt(idle && idle.post_idle_rss_mb != null ? idle.post_idle_rss_mb : '-', 13) +
            fmt(idle ? (idle.recovered ? 'yes' : 'no') : '-', 10)
        );
    };

    const a = result.phases.a_sequential_small;
    if (a) printRow('A sequential C.jpg', a.requests.length, 1, a.failures, a.wall, a.rss, a.idle_10s);
    const b = result.phases.b_concurrency_sweep;
    if (b) {
        for (const s of b.sweeps) {
            printRow(`B sweep concurrency=${s.concurrency}`, s.requests.length, s.concurrency, s.failures, s.wall, s.rss, null);
        }
        printRow('B sweep aggregate', b.requests.length, '5/10/25', b.failures, b.wall, b.rss, b.idle_10s);
    }
    const cphase = result.phases.c_sequential_pad15;
    if (cphase) printRow('C sequential pad-15mb', cphase.requests.length, 1, cphase.failures, cphase.wall, cphase.rss, cphase.idle_10s);

    const totalFailures = [a, b, cphase].reduce((n, p) => n + (p ? p.failures : 0), 0);
    console.log(`\nwrote ${OUT}`);
    if (harnessError) {
        console.error(`load: harness failed — ${harnessError.message}`);
        process.exit(1);
    }
    console.log(totalFailures ? `load: completed with ${totalFailures} request failure(s)` : 'load: completed with zero request failures');
    process.exit(totalFailures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
