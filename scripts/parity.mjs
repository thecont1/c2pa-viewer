#!/usr/bin/env bun
// Parity test (P0.5): the Cloudflare-Worker engine path must produce the
// same analysis as the browser path captured in fixtures/golden/.
//
// For every fixtures/*.jpg:
//   POST /verify on `wrangler dev --local` (api/spike) returns
//   { ...c2paResult, exif } — the same shapes window.C2paApi returns.
//   - response minus `exif` deep-equals fixtures/golden/<f>.c2paMetadata.json
//   - response.exif deep-equals the entry inside
//     fixtures/golden/<f>.exifMetadata.json (keyed by filename)
//
// VOLATILE — paths normalized before diffing, with justification:
//   c2pa.provenance[*].date / [*].when — formatDatetimeFull(..., true)
//   renders in the HOST timezone: the browser golden was captured in local
//   time (e.g. "GMT+5:30") while workerd renders UTC ("UTC"). Same instant,
//   different wall string. Only these two provenance fields are affected;
//   c2pa_data keeps raw ISO strings and EXIF dates are naive (verified
//   stable). The volatile COUNT is asserted to match.
//
// Hard verdict assertions run on top of the deep diffs.
// Exit 1 on any mismatch; kills wrangler on every exit path.

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPIKE = join(ROOT, 'api/spike');
const FIXTURES = join(ROOT, 'fixtures');
const GOLDEN = join(FIXTURES, 'golden');
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;

// Explicit verdict expectations (lead-specified table).
const EXPECTED = {
  'A.jpg':              { manifest: false, state: null,     basis: null },
  'C.jpg':              { manifest: true,  state: 'Valid', basis: 'none' },
  'C_with_CAWG_data.jpg': { manifest: true, state: 'Valid', basis: 'none' },
  'cloud.jpg':          { manifest: true,  state: 'Trusted', basis: 'interim_trust_list' },
  'tampered.jpg':       { manifest: true,  state: 'Invalid', basis: null },
  'DSCF9243.jpg':       { manifest: true,  state: 'Trusted', basis: 'interim_trust_list' },
};

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const ok = (m) => console.log(`ok    ${m}`);

// ------------------------------------------------------------- diffing ----

function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

// Replace timezone-formatted provenance date/when strings with a token.
// Mutates in place; returns nothing.
function normalizeVolatile(value) {
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.provenance)) {
      for (const item of node.provenance) {
        if (item && typeof item === 'object') {
          for (const k of ['date', 'when']) {
            if (typeof item[k] === 'string') item[k] = '<volatile-tz>';
          }
        }
      }
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(value);
}

function countVolatile(value) {
  let n = 0;
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x.provenance)) {
      for (const it of x.provenance) {
        if (it && typeof it === 'object') for (const k of ['date', 'when']) {
          if (it[k] === '<volatile-tz>') n++;
        }
      }
    }
    for (const y of Object.values(x)) walk(y);
  };
  walk(value);
  return n;
}

function diffTrees(a, b, path = '$', out = [], limit = 40) {
  if (out.length >= limit) return out;
  if (Object.is(a, b)) return out;
  const aObj = a && typeof a === 'object';
  const bObj = b && typeof b === 'object';
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n && out.length < limit; i++) diffTrees(a[i], b[i], `${path}[${i}]`, out, limit);
    return out;
  }
  if (aObj && bObj && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      if (out.length >= limit) break;
      if (!(k in a)) out.push(`${path}.${k}: <missing> -> ${JSON.stringify(b[k])}`);
      else if (!(k in b)) out.push(`${path}.${k}: ${JSON.stringify(a[k])} -> <missing>`);
      else diffTrees(a[k], b[k], `${path}.${k}`, out, limit);
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return out;
}

function deepCompare(name, goldenVal, workerVal) {
  const g = sortValue(JSON.parse(JSON.stringify(goldenVal)));
  const w = sortValue(JSON.parse(JSON.stringify(workerVal)));
  normalizeVolatile(g);
  normalizeVolatile(w);
  const diffs = diffTrees(g, w);
  const gv = countVolatile(g), wv = countVolatile(w);
  if (gv !== wv) diffs.push(`$volatile-count: golden=${gv} worker=${wv}`);
  if (diffs.length) {
    fail(`${name}: ${diffs.length} diff(s)`);
    for (const d of diffs.slice(0, 15)) console.log(`        ${d}`);
    return false;
  }
  return true;
}

// ------------------------------------------------------------- harness ----

async function portFree(port) {
  try {
    await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(800) });
    return false;
  } catch { return true; }
}

async function waitHealth(child, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`wrangler exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
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

async function postVerify(file) {
  const bytes = readFileSync(join(FIXTURES, file));
  const resp = await fetch(`${BASE}/verify`, {
    method: 'POST',
    headers: { 'x-mime': 'image/jpeg', 'x-filename': file },
    body: bytes,
  });
  return { status: resp.status, json: await resp.json().catch(() => null) };
}

// ------------------------------------------------------------------ main --

async function main() {
  const fixtures = readdirSync(FIXTURES).filter((f) => f.toLowerCase().endsWith('.jpg')).sort();

  if (!(await portFree(PORT))) {
    console.log(`port ${PORT} is not free — refusing to start wrangler`);
    process.exit(1);
  }

  const child = spawn('bunx', ['wrangler', 'dev', '--local', '--port', String(PORT)], {
    cwd: SPIKE, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wranglerLog = '';
  child.stdout.on('data', (d) => { wranglerLog += d; });
  child.stderr.on('data', (d) => { wranglerLog += d; });
  const onSignal = async () => { await stopChild(child); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const rows = [];
  try {
    await waitHealth(child);

    for (const f of fixtures) {
      const goldenC2paPath = join(GOLDEN, `${f}.c2paMetadata.json`);
      const goldenExifPath = join(GOLDEN, `${f}.exifMetadata.json`);
      const { status, json } = await postVerify(f);
      if (status !== 200 || !json) { fail(`${f}: HTTP ${status}`); continue; }

      // split worker response: everything except `exif` is the c2pa result
      const { exif: workerExif, ...workerC2pa } = json;
      const goldenC2pa = JSON.parse(readFileSync(goldenC2paPath, 'utf8'));
      const goldenExifAll = JSON.parse(readFileSync(goldenExifPath, 'utf8'));
      const goldenExif = goldenExifAll[f] ?? Object.values(goldenExifAll)[0];

      const c2paOk = deepCompare(`${f} c2pa`, goldenC2pa, workerC2pa);
      const exifOk = deepCompare(`${f} exif`, goldenExif, workerExif);

      // hard verdict assertions
      const exp = EXPECTED[f];
      const t = workerC2pa.trust || {};
      const vs = workerC2pa.c2pa_data ? workerC2pa.c2pa_data.validation_state : null;
      const hasManifest = !!workerC2pa.c2pa_data;
      let verdict = 'n/a';
      if (exp) {
        const good = hasManifest === exp.manifest
          && (exp.manifest ? (vs === exp.state && t.state === exp.state && t.basis === exp.basis) : true);
        verdict = good ? 'ok' : 'MISMATCH';
        if (!good) fail(`${f} verdict: manifest=${hasManifest} vs=${vs} trust=${t.state}/${t.basis} (expected ${JSON.stringify(exp)})`);
      }
      rows.push({ f, c2pa: c2paOk ? 'ok' : 'DIFF', exif: exifOk ? 'ok' : 'DIFF', verdict });
    }
  } catch (e) {
    fail(`worker harness: ${e.message}`);
    if (wranglerLog) console.log('--- wrangler output (tail) ---\n' + wranglerLog.split('\n').slice(-25).join('\n'));
  } finally {
    await stopChild(child);
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('\n== parity summary ==');
  console.log('fixture                 c2pa   exif   verdict');
  for (const r of rows) {
    console.log(`${r.f.padEnd(24)} ${r.c2pa.padEnd(6)} ${r.exif.padEnd(6)} ${r.verdict}`);
  }
  console.log(failures ? `\n${failures} parity failure(s)` : '\nparity: all fixtures match');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
