#!/usr/bin/env bun
// Refresh the vendored C2PA trust lists in trust/ and rewrite trust/meta.json.
//
// Sources:
//   C2PA Trust List : https://raw.githubusercontent.com/c2pa-org/conformance-public/main/trust-list/C2PA-TRUST-LIST.pem
//   Interim TL (ITL): https://contentcredentials.org/trust/anchors.pem
//   Trust config    : https://contentcredentials.org/trust/store.cfg
//
// meta.json records provenance per file (source_url, fetched_at, sha256,
// cert_count) plus the upstream commit sha/date of the C2PA list resolved via
// the GitHub commits API for path trust-list/C2PA-TRUST-LIST.pem.
//
// Usage: bun scripts/update-trust-lists.mjs

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRUST_DIR = join(ROOT, 'trust');

const C2PA_PEM_URL = 'https://raw.githubusercontent.com/c2pa-org/conformance-public/main/trust-list/C2PA-TRUST-LIST.pem';
const ITL_PEM_URL = 'https://contentcredentials.org/trust/anchors.pem';
const STORE_CFG_URL = 'https://contentcredentials.org/trust/store.cfg';
const GH_COMMITS_URL = 'https://api.github.com/repos/c2pa-org/conformance-public/commits?path=trust-list/C2PA-TRUST-LIST.pem&per_page=1';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const certCount = (text) => (text.match(/-----BEGIN CERTIFICATE-----/g) || []).length;

async function fetchText(url) {
    const resp = await fetch(url, { headers: { 'User-Agent': 'c2pa-viewer-trust-sync' } });
    if (!resp.ok) throw new Error(`GET ${url} -> HTTP ${resp.status}`);
    return resp.text();
}

// Latest upstream commit touching the C2PA trust list path.
async function c2paListCommit() {
    const resp = await fetch(GH_COMMITS_URL, {
        headers: { 'User-Agent': 'c2pa-viewer-trust-sync', Accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) throw new Error(`GitHub commits API -> HTTP ${resp.status}`);
    const commits = await resp.json();
    const c = Array.isArray(commits) && commits[0];
    if (!c) return { commit: null, commit_date: null };
    return {
        commit: c.sha ?? null,
        commit_date: c.commit?.committer?.date ?? c.commit?.author?.date ?? null,
    };
}

const fetchedAt = new Date().toISOString();

const [c2paPem, itlPem, storeCfg, c2paCommit] = await Promise.all([
    fetchText(C2PA_PEM_URL),
    fetchText(ITL_PEM_URL),
    fetchText(STORE_CFG_URL),
    c2paListCommit(),
]);

writeFileSync(join(TRUST_DIR, 'C2PA-TRUST-LIST.pem'), c2paPem);
writeFileSync(join(TRUST_DIR, 'ITL-anchors.pem'), itlPem);
writeFileSync(join(TRUST_DIR, 'store.cfg'), storeCfg);

const meta = {
    fetched_at: fetchedAt,
    lists: {
        c2pa: {
            source_url: C2PA_PEM_URL,
            fetched_at: fetchedAt,
            sha256: sha256(Buffer.from(c2paPem, 'utf8')),
            cert_count: certCount(c2paPem),
            commit: c2paCommit.commit,
            commit_date: c2paCommit.commit_date,
        },
        itl: {
            source_url: ITL_PEM_URL,
            fetched_at: fetchedAt,
            sha256: sha256(Buffer.from(itlPem, 'utf8')),
            cert_count: certCount(itlPem),
        },
        config: {
            source_url: STORE_CFG_URL,
            fetched_at: fetchedAt,
            sha256: sha256(Buffer.from(storeCfg, 'utf8')),
        },
    },
};

writeFileSync(join(TRUST_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

console.log(`trust lists refreshed at ${fetchedAt}`);
console.log(`  c2pa : ${meta.lists.c2pa.cert_count} certs, ${c2paPem.length} bytes, commit ${c2paCommit.commit} (${c2paCommit.commit_date})`);
console.log(`  itl  : ${meta.lists.itl.cert_count} certs, ${itlPem.length} bytes`);
console.log(`  cfg  : ${storeCfg.length} bytes`);
