#!/usr/bin/env bun
// make-large-fixture.mjs — generate the Phase 3 large signed JPEG fixture.
//
//   bun scripts/make-large-fixture.mjs
//   bun scripts/make-large-fixture.mjs --bytes 536870912 --out fixtures/big/large-signed.jpg
//
// The fixture is intentionally synthetic but structurally meaningful: start
// with the unsigned fixtures/A.jpg, extend the file with zero bytes to the
// requested size, then sign the padded bytes with c2pa-node's public upstream
// ES256 test key. Padding before signing means the C2PA hash covers the exact
// large asset bytes that are later verified.
//
// Certificate provenance: fixtures/certs/es256.{pem,pub} are verbatim public
// test credentials from contentauth/c2pa-js, package c2pa-node tag
// @contentauth/c2pa-node@0.12.1, path packages/c2pa-node/tests/fixtures/certs.
// Their exact SHA-256 digests are pinned below and verified on every run.

import { copyFileSync, mkdirSync, readFileSync, statSync, truncateSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Builder, LocalSigner, Reader } from '@contentauth/c2pa-node';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_BYTES = 220 * 1024 * 1024;
const CERT_SHA256 = {
    'es256.pem': 'f547ec8dbf24e50b51cf9924e58c250d246ed8844304408a072801fcf70a95d7',
    'es256.pub': '2bf499037fd1fa7d803e3052c7b4ef6a0e67564aa2b805c0d7ae64d25a13c07b',
};

function parseArgs(argv) {
    const args = { bytes: DEFAULT_BYTES, out: 'fixtures/big/large-signed.jpg', source: 'fixtures/A.jpg' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--bytes') args.bytes = Number(argv[++i]);
        else if (argv[i] === '--out') args.out = argv[++i];
        else if (argv[i] === '--source') args.source = argv[++i];
        else if (argv[i] === '--force') args.force = true;
        else throw new Error(`unknown argument: ${argv[i]}`);
    }
    if (!Number.isInteger(args.bytes) || args.bytes < 1024 * 1024) throw new Error('--bytes must be an integer >= 1 MiB');
    return args;
}

function sha256File(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyPinnedCerts() {
    for (const [name, expected] of Object.entries(CERT_SHA256)) {
        const path = resolve(ROOT, 'fixtures/certs', name);
        if (!existsSync(path)) throw new Error(`missing pinned upstream test credential: ${path}`);
        const actual = sha256File(path);
        if (actual !== expected) throw new Error(`${name} sha256 mismatch: expected ${expected}, got ${actual}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const source = resolve(ROOT, args.source);
    const out = resolve(ROOT, args.out);
    const padded = out.replace(/\.jpg$/i, '.padded-tmp.jpg');
    mkdirSync(dirname(out), { recursive: true });
    if (existsSync(out) && !args.force) {
        console.log(`exists: ${out} (${statSync(out).size} bytes) — pass --force to rebuild`);
        return;
    }
    verifyPinnedCerts();

    console.log(`padding ${source} to ${args.bytes} bytes before signing`);
    copyFileSync(source, padded);
    truncateSync(padded, args.bytes);
    if (statSync(padded).size !== args.bytes) throw new Error('padding did not produce the requested byte count');

    const manifest = {
        vendor: 'c2pa-viewer-test',
        claim_generator: 'c2pa-viewer-test/phase3-large-fixture',
        claim_generator_info: [{ name: 'c2pa-viewer-test', version: '0.12.1' }],
        title: 'large-async-fixture',
        format: 'image/jpeg',
        instance_id: randomUUID(),
        ingredients: [],
        assertions: [],
        resources: { resources: {} },
    };
    const builder = await Builder.withJsonAsync(manifest);
    builder.setIntent({ create: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture' });
    const signer = LocalSigner.newSigner(
        readFileSync(resolve(ROOT, 'fixtures/certs/es256.pub')),
        readFileSync(resolve(ROOT, 'fixtures/certs/es256.pem')),
        'es256',
    );

    console.log('signing padded asset with c2pa-node 0.12.1 test credential');
    const t0 = Date.now();
    builder.sign(signer, { path: padded, mimeType: 'image/jpeg' }, { path: out });
    console.log(`signed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const reader = await Reader.fromAsset({ path: out, mimeType: 'image/jpeg' });
    if (!reader) throw new Error('signed output did not yield a C2PA reader');
    const store = reader.json();
    const failures = store.validation_status || [];
    console.log(`output: ${out}`);
    console.log(`size_bytes: ${statSync(out).size}`);
    console.log(`sha256: ${sha256File(out)}`);
    console.log(`validation_status: ${JSON.stringify(failures)}`);
    try { await import('node:fs/promises').then((fs) => fs.rm(padded, { force: true })); } catch { }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
