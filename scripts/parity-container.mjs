// Capture or compare container /verify outputs for the fixture corpus.
//   bun scripts/parity-container.mjs capture [baseUrl]   — save reference JSON
//   bun scripts/parity-container.mjs compare [baseUrl]   — diff live vs reference
// The reference goldens were captured from the original Node container (now
// removed, TZ=UTC); the compare target is the Rust container. Do not recapture
// against Rust — the goldens are the frozen behavioral contract.
// Field-order-sensitive byte diff after canonical JSON.stringify.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'fixtures/golden-container');
const FIXTURES = join(ROOT, 'fixtures');

async function loadSettingsHeader() {
    const c2pa = await readFile(join(ROOT, 'trust/C2PA-TRUST-LIST.pem'), 'utf8');
    const itl = await readFile(join(ROOT, 'trust/ITL-anchors.pem'), 'utf8');
    const config = await readFile(join(ROOT, 'trust/store.cfg'), 'utf8');
    const meta = JSON.parse(await readFile(join(ROOT, 'trust/meta.json'), 'utf8'));
    return JSON.stringify({
        trust: { c2pa_anchors: c2pa, itl_anchors: itl, trust_config: config },
        trust_meta: meta,
    });
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

async function verifyFile(base, settings, file) {
    const bytes = await readFile(join(FIXTURES, file));
    const ext = file.slice(file.lastIndexOf('.'));
    const res = await fetch(`${base}/verify`, {
        method: 'POST',
        headers: {
            'content-type': 'application/octet-stream',
            'x-mime': MIME[ext] || 'image/jpeg',
            'x-filename': encodeURIComponent(file),
            'x-c2pa-settings': settings,
        },
        body: bytes,
    });
    const json = await res.json();
    return { status: res.status, json };
}

const [mode, baseArg] = process.argv.slice(2);
const base = (baseArg || 'http://localhost:8080').replace(/\/$/, '');
const settings = await loadSettingsHeader();

const files = (await readdir(FIXTURES)).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
let failures = 0;

for (const file of files) {
    const goldenPath = join(GOLDEN, `${file}.json`);
    if (mode === 'capture') {
        const out = await verifyFile(base, settings, file);
        await writeFile(goldenPath, JSON.stringify(out, null, 2));
        console.log(`captured ${file}: status ${out.status}`);
    } else if (mode === 'compare') {
        const expected = JSON.parse(await readFile(goldenPath, 'utf8'));
        const actual = await verifyFile(base, settings, file);
        const a = JSON.stringify(actual);
        const e = JSON.stringify(expected);
        if (a === e) {
            console.log(`MATCH ${file}`);
        } else {
            failures++;
            console.log(`DIFF ${file} (status ${actual.status} vs ${expected.status})`);
            // First diverging key path — shallow diagnostic.
            const flatDiff = (x, y, path) => {
                if (JSON.stringify(x) === JSON.stringify(y)) return null;
                if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object') {
                    return `${path}: ${JSON.stringify(x)?.slice(0, 120)} != ${JSON.stringify(y)?.slice(0, 120)}`;
                }
                const keys = new Set([...Object.keys(x || {}), ...Object.keys(y || {})]);
                for (const k of keys) {
                    const d = flatDiff(x?.[k], y?.[k], `${path}.${k}`);
                    if (d) return d;
                }
                return `${path}: object shape differs`;
            };
            console.log('  first diff:', flatDiff(actual.json, expected.json, '$'));
        }
    }
}
if (mode === 'compare') {
    console.log(failures ? `${failures} fixture(s) differ` : 'all fixtures match');
    process.exit(failures ? 1 : 0);
}
