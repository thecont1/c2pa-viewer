// Vendored trust-list anchors and provenance payload shared by the REST
// public endpoint and the MCP tools/resources.

import { sha256HexText } from './keys-mw.js';

// Trust lists are bundled as text modules (wrangler `rules`, see
// wrangler.jsonc); meta.json bundles as a JSON module.
import c2paTrustPem from '../../trust/C2PA-TRUST-LIST.pem';
import itlTrustPem from '../../trust/ITL-anchors.pem';
import trustConfig from '../../trust/store.cfg';
import trustMeta from '../../trust/meta.json';

export const TRUST_ANCHORS = {
    c2pa: c2paTrustPem,
    itl: itlTrustPem,
    config: trustConfig,
    meta: trustMeta,
};

let hashesPromise = null;

// sha256 of each vendored trust file, computed once per isolate.
export function trustFileHashes() {
    if (!hashesPromise) {
        hashesPromise = (async () => {
            const [c2pa, itl, config] = await Promise.all([
                sha256HexText(c2paTrustPem),
                sha256HexText(itlTrustPem),
                sha256HexText(trustConfig),
            ]);
            return { c2pa, itl, config };
        })().catch((e) => {
            hashesPromise = null; // retry on next request
            throw e;
        });
    }
    return hashesPromise;
}

// Same payload shape as GET /v1/trust-lists.
export async function trustListsPayload() {
    const hashes = await trustFileHashes();
    const meta = JSON.parse(JSON.stringify(trustMeta));
    if (meta.lists && meta.lists.c2pa) meta.lists.c2pa.sha256 = hashes.c2pa;
    if (meta.lists && meta.lists.itl) meta.lists.itl.sha256 = hashes.itl;
    if (meta.lists && meta.lists.config) meta.lists.config.sha256 = hashes.config;
    return meta;
}
