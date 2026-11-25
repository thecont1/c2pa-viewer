#!/usr/bin/env bun
// Golden-master capture for the C2PA metadata pipeline.
//
// Serves the repo root on a FIXED port (the port is embedded in c2paMini's
// `more` URL, so it must never change), loads index.html in headless Chromium,
// and records the raw JSON of window.C2paApi calls for every fixtures/*.jpg.
//
//   bun scripts/golden.mjs --update   capture fixtures/golden/*.json
//   bun scripts/golden.mjs --check    re-run and diff against stored golden
//                                     (exit 1 on any mismatch)
//
// VOLATILE: paths that may legitimately differ between runs. Keep this list
// minimal — every entry must be justified here.
const VOLATILE = [
  // (empty — all captured fields are derived from fixture bytes and fixed
  //  server origin; if a diff shows up here, investigate before adding)
];

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = resolve(ROOT, 'fixtures/golden');
const FIXTURES_DIR = resolve(ROOT, 'fixtures');
const PORT = 8899; // fixed: c2paMini's `more` field embeds location.origin
const BASE = `http://localhost:${PORT}`;

const UPDATE = process.argv.includes('--update');
const CHECK = process.argv.includes('--check');
if (!UPDATE && !CHECK) {
  console.error('usage: bun scripts/golden.mjs --update | --check');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.pem': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

function startServer() {
  return Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT + '/') && file !== ROOT) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        const data = readFileSync(file);
        const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
        return new Response(data, { headers: { 'content-type': type } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  });
}

// Recursively sort object keys so stored goldens diff cleanly.
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

function goldenPath(name, fn) {
  return join(GOLDEN_DIR, `${name}.${fn}.json`);
}

// Path-level diff between two JSON trees. Returns list of "path: a -> b".
function diffTrees(a, b, path = '$', out = [], limit = 60) {
  if (out.length >= limit) return out;
  if (Object.is(a, b)) return out;
  const aObj = a && typeof a === 'object' && !Array.isArray(a);
  const bObj = b && typeof b === 'object' && !Array.isArray(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n && out.length < limit; i++) {
      diffTrees(a[i], b[i], `${path}[${i}]`, out, limit);
    }
    return out;
  }
  if (aObj && bObj) {
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

async function main() {
  const fixtures = readdirSync(FIXTURES_DIR)
    .filter((f) => f.toLowerCase().endsWith('.jpg'))
    .sort();
  if (!fixtures.length) throw new Error('no fixtures/*.jpg found');
  // uploadMetadata needs a File; pick fixtures with the richest coverage:
  // one C2PA test-signed image and one real camera JPEG.
  const UPLOAD_FIXTURES = ['C.jpg', 'DSCF9243.jpg'].filter((f) => fixtures.includes(f));

  const server = startServer();
  console.log(`serving ${ROOT} on ${BASE}`);

  const browser = await chromium.launch();
  // Pin the browser timezone: provenance date strings are deliberately formatted
  // in the runtime-local timezone (correct product behavior — browsers show
  // user-local time), so byte-exact goldens are only meaningful under one fixed
  // zone. Goldens were captured in Asia/Kolkata; without this pin the check
  // fails on any host/CI runner in a different timezone.
  const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.C2paApi && typeof window.C2paApi.c2paMetadata === 'function');

  // Sanity: the page must be able to reach its own wasm + fixtures.
  const health = await page.evaluate(async () => {
    const r = await fetch('/fixtures/A.jpg');
    return r.status;
  });
  if (health !== 200) throw new Error(`fixture fetch failed: HTTP ${health}`);

  const results = {}; // "name.fn" -> value
  for (const f of fixtures) {
    for (const fn of ['c2paMetadata', 'exifMetadata', 'c2paMini']) {
      const key = `${f}.${fn}`;
      process.stdout.write(`  ${key} ... `);
      const value = await page.evaluate(
        async ([fnName, uri]) => window.C2paApi[fnName](uri),
        [fn, `${BASE}/fixtures/${f}`]
      );
      results[key] = value;
      console.log('ok');
    }
  }
  for (const f of UPLOAD_FIXTURES) {
    const key = `${f}.uploadMetadata`;
    process.stdout.write(`  ${key} ... `);
    const value = await page.evaluate(async (uri) => {
      const resp = await fetch(uri);
      const buf = await resp.arrayBuffer();
      const file = new File([buf], uri.split('/').pop(), { type: 'image/jpeg' });
      return window.C2paApi.uploadMetadata(file);
    }, `${BASE}/fixtures/${f}`);
    results[key] = value;
    console.log('ok');
  }

  await browser.close();
  server.stop(true);

  // ---- write or check ----
  const entries = Object.entries(results).sort(([a], [b]) => a.localeCompare(b));
  let failures = 0;

  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    for (const [key, value] of entries) {
      // key is "<file>.jpg.<fn>" — split at the LAST dot before fn
      const idx = key.lastIndexOf('.');
      const fileName = key.slice(0, idx);
      const fnName = key.slice(idx + 1);
      const p = goldenPath(fileName, fnName);
      writeFileSync(p, JSON.stringify(sortValue(value), null, 2) + '\n');
      console.log(`wrote ${p}`);
    }
    console.log(`\ncaptured ${entries.length} golden files in fixtures/golden/`);
    return;
  }

  // --check
  for (const [key, value] of entries) {
    const idx = key.lastIndexOf('.');
    const fileName = key.slice(0, idx);
    const fnName = key.slice(idx + 1);
    const p = goldenPath(fileName, fnName);
    if (!existsSync(p)) {
      console.log(`MISSING  ${key} (no stored golden)`);
      failures++;
      continue;
    }
    const stored = JSON.parse(readFileSync(p, 'utf8'));
    const diffs = diffTrees(sortValue(stored), sortValue(value));
    // filter volatile paths
    const real = diffs.filter((d) => !VOLATILE.some((v) => d.startsWith(v)));
    if (real.length) {
      failures++;
      console.log(`DIFF     ${key}`);
      for (const d of real.slice(0, 20)) console.log(`           ${d}`);
      if (real.length > 20) console.log(`           ... ${real.length - 20} more`);
    } else {
      console.log(`ok       ${key}`);
    }
  }
  // detect stale golden files
  if (existsSync(GOLDEN_DIR)) {
    for (const f of readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'))) {
      const base = f.replace(/\.json$/, '');
      const idx = base.lastIndexOf('.');
      const key = `${base.slice(0, idx)}.${base.slice(idx + 1)}`;
      if (!results[key]) {
        console.log(`STALE    fixtures/golden/${f} (no current counterpart)`);
        failures++;
      }
    }
  }
  console.log(failures ? `\n${failures} golden mismatch(es)` : '\nall golden outputs match');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
