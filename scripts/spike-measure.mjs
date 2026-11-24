#!/usr/bin/env bun
// P0.1 Worker spike measurement script.
//
// Local mode (default): starts `bunx wrangler dev --local --port 8799` in
// api/spike, runs the fixture matrix while sampling summed workerd RSS,
// then repeats for a second independent cold start.
//
// Remote mode: `bun scripts/spike-measure.mjs --url https://c2pa-spike.<acct>.workers.dev`
// POSTs the same fixtures to a deployed worker (no RSS sampling).
//
// Output: docs/spike-results.json + a printed table.

import { spawn, execFile, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPIKE_DIR = resolve(ROOT, 'api/spike');
const FIXTURES = resolve(ROOT, 'fixtures');
const OUT = resolve(ROOT, 'docs/spike-results.json');
const PORT = 8799;
const LOCAL_URL = `http://localhost:${PORT}`;
const SAMPLE_MS = 25;

const FIXTURE_FILES = [
  'A.jpg',
  'C.jpg',
  'C_with_CAWG_data.jpg',
  'cloud.jpg',
  'tampered.jpg',
  'big/pad-5mb.jpg',
  'big/pad-15mb.jpg',
  'big/pad-25mb.jpg',
  'big/pad-40mb.jpg',
];
const PAD_FILES = FIXTURE_FILES.filter((f) => f.startsWith('big/pad-'));
const PAD_REPEAT = 3;
const RUNS = 2; // two independent cold starts

const args = process.argv.slice(2);
const urlFlag = args.indexOf('--url');
const REMOTE_URL = urlFlag >= 0 ? args[urlFlag + 1] : null;
const ONLY = args.filter((a, i) => !a.startsWith('--') && (urlFlag < 0 || i !== urlFlag + 1));

function fixturePath(name) {
  return resolve(FIXTURES, name);
}

function loadFixture(name) {
  return readFileSync(fixturePath(name));
}

// ---------------------------------------------------------------------------
// workerd RSS sampling (macOS/Linux)
// ---------------------------------------------------------------------------

// One `ps` spawn per sample, filtered in JS. Async so sampling never blocks
// the in-flight fetch (a synchronous exec would inflate wall_ms).
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

function workerdPids() {
  try {
    const out = execSync('pgrep -f workerd', { encoding: 'utf8' });
    return out
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function health(url) {
  const res = await fetch(`${url}/health`);
  return res.ok;
}

async function waitForHealth(url, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await health(url)) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function postRead(url, name, bytes) {
  const t0 = performance.now();
  let status = 0;
  let body = null;
  let bodyText = null;
  try {
    const res = await fetch(`${url}/read`, {
      method: 'POST',
      headers: { 'x-mime': 'image/jpeg', 'content-type': 'application/octet-stream' },
      body: bytes,
      signal: AbortSignal.timeout(180000),
    });
    status = res.status;
    bodyText = await res.text();
    try {
      body = JSON.parse(bodyText);
    } catch {}
  } catch (e) {
    bodyText = String(e);
  }
  const wallMs = performance.now() - t0;
  return { fixture: name, status, wall_ms: +wallMs.toFixed(1), body, body_text: bodyText };
}

// One measured request: samples workerd RSS every SAMPLE_MS while in flight.
async function measuredRead(url, name) {
  const bytes = loadFixture(name);
  const preRssKb = await totalWorkerdRssKb();
  const samples = [preRssKb];
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return; // skip a tick rather than stack up ps spawns
    inFlight = true;
    totalWorkerdRssKb()
      .then((kb) => samples.push(kb))
      .finally(() => {
        inFlight = false;
      });
  }, SAMPLE_MS);
  try {
    const result = await postRead(url, name, bytes);
    return { ...result, bytes_len: bytes.byteLength, pre_rss_kb: preRssKb, rss_samples_kb: samples };
  } finally {
    clearInterval(timer);
    samples.push(await totalWorkerdRssKb());
  }
}

function rssStats(samplesKb, preKb) {
  if (!samplesKb || samplesKb.length === 0) return null;
  const peak = Math.max(...samplesKb);
  const post = samplesKb[samplesKb.length - 1];
  return {
    idle_rss_mb: +(preKb / 1024).toFixed(1),
    peak_rss_mb: +(peak / 1024).toFixed(1),
    peak_delta_mb: +((peak - preKb) / 1024).toFixed(1),
    post_rss_mb: +(post / 1024).toFixed(1),
    post_delta_mb: +((post - preKb) / 1024).toFixed(1),
    samples: samplesKb.length,
  };
}

// ---------------------------------------------------------------------------
// wrangler dev lifecycle
// ---------------------------------------------------------------------------

function startWranglerDev() {
  // detached: wrangler + workerd share a process group we can kill wholesale
  const child = spawn('bunx', ['wrangler', 'dev', '--local', `--port=${PORT}`], {
    cwd: SPIKE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: true,
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return { child, getLog: () => log };
}

function killTree(child) {
  return new Promise((resolveKill) => {
    try {
      // Kill the whole detached process group (wrangler -> workerd).
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
      // Fallback for stragglers whose cmdline references this spike.
      try {
        execSync(`pkill -f "wrangler dev --local --port=${PORT}" 2>/dev/null || true`);
        execSync(`pkill -f "api/spike" 2>/dev/null || true`);
      } catch {}
      resolveKill();
    }, 1200);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const results = {
  generated_at: new Date().toISOString(),
  protocol: {
    sample_ms: SAMPLE_MS,
    fixtures: FIXTURE_FILES,
    pad_repeat: PAD_REPEAT,
    runs: RUNS,
    note: 'RSS = summed RSS of all workerd processes (ps -o rss=, KB->MB). Local workerd has no 128MB isolate limit.',
  },
  local: null,
  remote: null,
};

async function runLocal() {
  const runs = [];
  for (let run = 0; run < RUNS; run++) {
    console.log(`\n=== local run ${run + 1}/${RUNS}: starting wrangler dev ===`);
    const { child, getLog } = startWranglerDev();
    const ok = await waitForHealth(LOCAL_URL);
    if (!ok) {
      console.error('wrangler dev failed to become healthy. Log tail:\n' + getLog().slice(-3000));
      killTree(child);
      process.exit(1);
    }
    // let the runtime settle, then record idle RSS
    await new Promise((r) => setTimeout(r, 1000));
    const idleRssKb = await totalWorkerdRssKb();
    const pids = workerdPids();
    console.log(`healthy. workerd pids: ${pids.join(',') || 'none'}; idle RSS ${(idleRssKb / 1024).toFixed(1)} MB`);

    const requests = [];
    const fixtures = ONLY.length ? FIXTURE_FILES.filter((f) => ONLY.includes(f)) : FIXTURE_FILES;

    for (const name of fixtures) {
      const isCold = requests.length === 0;
      console.log(`  [${isCold ? 'COLD' : 'warm'}] POST /read ${name} (${(loadFixture(name).byteLength / 1048576).toFixed(2)} MiB)`);
      const r = await measuredRead(LOCAL_URL, name);
      const stats = rssStats(r.rss_samples_kb, r.pre_rss_kb);
      requests.push({
        fixture: name,
        cold_start: isCold,
        http_status: r.status,
        wall_ms: r.wall_ms,
        bytes: r.body?.bytes ?? r.bytes_len,
        ok: r.body?.ok ?? null,
        validation_state: r.body?.validation_state ?? null,
        active_manifest: r.body?.active_manifest ?? null,
        manifest_count: r.body?.manifest_count ?? null,
        init_ms: r.body?.init_ms ?? null,
        read_ms: r.body?.read_ms ?? null,
        error: r.body?.error ?? (r.status >= 400 ? r.body_text?.slice(0, 300) : null),
        rss: stats,
      });
      const b = r.body || {};
      console.log(
        `    -> status=${r.status} ok=${b.ok} vs=${b.validation_state} manifests=${b.manifest_count} ` +
          `wall=${r.wall_ms}ms read=${b.read_ms}ms init=${b.init_ms}ms cold=${b.cold} ` +
          `peakRSS=${stats?.peak_rss_mb}MB (+${stats?.peak_delta_mb})${b.error ? ' err=' + String(b.error).slice(0, 120) : ''}`
      );
    }

    // pad repeats: 3x back-to-back per pad size
    const padRepeats = [];
    for (const name of PAD_FILES.filter((f) => fixtures.includes(f))) {
      for (let i = 0; i < PAD_REPEAT; i++) {
        const r = await measuredRead(LOCAL_URL, name);
        const stats = rssStats(r.rss_samples_kb, r.pre_rss_kb);
        padRepeats.push({
          fixture: name,
          rep: i + 1,
          http_status: r.status,
          wall_ms: r.wall_ms,
          ok: r.body?.ok ?? null,
          validation_state: r.body?.validation_state ?? null,
          manifest_count: r.body?.manifest_count ?? null,
          error: r.body?.error ?? null,
          rss: stats,
        });
        console.log(`    pad-repeat ${name} #${i + 1}: wall=${r.wall_ms}ms peakRSS=${stats?.peak_rss_mb}MB (+${stats?.peak_delta_mb})`);
      }
    }

    runs.push({ run: run + 1, idle_rss_mb: +(idleRssKb / 1024).toFixed(1), workerd_pids: pids, requests, pad_repeats: padRepeats });
    await killTree(child);
    // ensure port freed before next run
    await new Promise((r) => setTimeout(r, 1500));
  }
  results.local = { runs };
}

async function runRemote() {
  const requests = [];
  for (const name of FIXTURE_FILES) {
    const bytes = loadFixture(name);
    console.log(`  POST /read ${name} (${(bytes.byteLength / 1048576).toFixed(2)} MiB)`);
    const r = await postRead(REMOTE_URL, name, bytes);
    const b = r.body || {};
    requests.push({
      fixture: name,
      http_status: r.status,
      wall_ms: r.wall_ms,
      ok: b.ok ?? null,
      validation_state: b.validation_state ?? null,
      active_manifest: b.active_manifest ?? null,
      manifest_count: b.manifest_count ?? null,
      init_ms: b.init_ms ?? null,
      read_ms: b.read_ms ?? null,
      error: b.error ?? (r.status >= 400 ? (r.body_text || '').slice(0, 500) : null),
      cf_ray: null,
      body_preview: r.status >= 400 ? (r.body_text || '').slice(0, 500) : null,
    });
    console.log(`    -> status=${r.status} ok=${b.ok} vs=${b.validation_state} manifests=${b.manifest_count} wall=${r.wall_ms}ms ${b.error ? 'err=' + String(b.error).slice(0, 140) : ''}`);
  }
  // extra ramp sizes if requested via --extra-sizes 30,35,40 (MiB), built on the fly
  const extraIdx = args.indexOf('--extra-sizes');
  if (extraIdx >= 0) {
    const sizes = args[extraIdx + 1].split(',').map((s) => parseInt(s, 10)).filter(Boolean);
    const c = readFileSync(fixturePath('C.jpg'));
    for (const mb of sizes) {
      const target = mb * 1024 * 1024;
      const bytes = Buffer.concat([c, Buffer.alloc(target - c.length)]);
      const name = `pad-${mb}mb-generated`;
      console.log(`  POST /read ${name} (${(bytes.byteLength / 1048576).toFixed(2)} MiB)`);
      const r = await postRead(REMOTE_URL, name, bytes);
      const b = r.body || {};
      requests.push({
        fixture: name,
        http_status: r.status,
        wall_ms: r.wall_ms,
        ok: b.ok ?? null,
        validation_state: b.validation_state ?? null,
        manifest_count: b.manifest_count ?? null,
        error: b.error ?? (r.status >= 400 ? (r.body_text || '').slice(0, 500) : null),
        body_preview: r.status >= 400 ? (r.body_text || '').slice(0, 500) : null,
      });
      console.log(`    -> status=${r.status} ok=${b.ok} vs=${b.validation_state} manifests=${b.manifest_count} wall=${r.wall_ms}ms ${b.error ? 'err=' + String(b.error).slice(0, 140) : ''}`);
    }
  }
  results.remote = { url: REMOTE_URL, requests };
}

function printTable() {
  const fmt = (v, w = 10) => String(v ?? '').padEnd(w).slice(0, w);
  console.log('\nfixture                cold  status  ok    vs        manifests  wall_ms  read_ms  init_ms  peakRSS_MB  +delta_MB');
  console.log('-'.repeat(110));
  for (const run of results.local?.runs ?? []) {
    console.log(`-- local run ${run.run} (idle ${(run.idle_rss_mb ?? '?')} MB) --`);
    for (const r of run.requests) {
      console.log(
        fmt(r.fixture, 22) +
          fmt(r.cold_start ? 'COLD' : '', 6) +
          fmt(r.http_status, 8) +
          fmt(r.ok, 6) +
          fmt(r.validation_state, 10) +
          fmt(r.manifest_count, 10) +
          fmt(Math.round(r.wall_ms), 9) +
          fmt(r.read_ms != null ? Math.round(r.read_ms) : '', 9) +
          fmt(r.init_ms != null ? (+r.init_ms).toFixed(1) : '', 9) +
          fmt(r.rss?.peak_rss_mb, 11) +
          fmt(r.rss?.peak_delta_mb, 9) +
          (r.error ? ` err=${String(r.error).slice(0, 80)}` : '')
      );
    }
    for (const r of run.pad_repeats ?? []) {
      console.log(
        fmt(`${r.fixture}#${r.rep}`, 22) +
          fmt('', 6) +
          fmt(r.http_status, 8) +
          fmt(r.ok, 6) +
          fmt(r.validation_state, 10) +
          fmt(r.manifest_count, 10) +
          fmt(Math.round(r.wall_ms), 9) +
          fmt('', 9) +
          fmt('', 9) +
          fmt(r.rss?.peak_rss_mb, 11) +
          fmt(r.rss?.peak_delta_mb, 9)
      );
    }
  }
  if (results.remote) {
    console.log(`\n-- remote ${results.remote.url} --`);
    for (const r of results.remote.requests) {
      console.log(
        fmt(r.fixture, 22) +
          fmt('', 6) +
          fmt(r.http_status, 8) +
          fmt(r.ok, 6) +
          fmt(r.validation_state, 10) +
          fmt(r.manifest_count, 10) +
          fmt(Math.round(r.wall_ms), 9) +
          fmt(r.read_ms != null ? Math.round(r.read_ms) : '', 9) +
          fmt('', 9) +
          fmt('', 11) +
          fmt('', 9) +
          (r.error ? ` err=${String(r.error).slice(0, 80)}` : '')
      );
    }
  }
}

mkdirSync(dirname(OUT), { recursive: true });
// Preserve results from prior runs of the other mode (local vs remote).
try {
  const prev = JSON.parse(readFileSync(OUT, 'utf8'));
  if (REMOTE_URL && prev.local) results.local = prev.local;
  if (!REMOTE_URL && prev.remote) results.remote = prev.remote;
} catch {}
if (REMOTE_URL) {
  await runRemote();
} else {
  await runLocal();
}
writeFileSync(OUT, JSON.stringify(results, null, 2));
printTable();
console.log(`\nwrote ${OUT}`);
