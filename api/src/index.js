// c2pa-verify-api — Phase 1 sync API MVP.
//
//   POST /v1/verify       — multipart | JSON base64 | JSON url, full VerifyResult
//   GET  /v1/verify/mini  — compact trust card for a url
//   GET  /v1/trust-lists  — vendored trust-list provenance        (PUBLIC)
//   GET  /v1/openapi.json — the OpenAPI 3.1 document              (PUBLIC)
//   GET  /health          — ops liveness (not part of the public contract)
//
// /v1/jobs* is intentionally NOT registered in this phase.

import { Hono } from 'hono';
import { parse as parseYaml } from 'yaml';

import { authMw, rateLimitMw, quotaMw } from './auth.js';
import { corsMw, preflightMw } from './cors.js';
import { verifyHandler, miniHandler } from './verify.js';
import { problem } from './errors.js';
import { sha256HexText } from './keys-mw.js';

// Trust lists are bundled as text modules (wrangler `rules`, see
// wrangler.jsonc); meta.json bundles as a JSON module.
import c2paTrustPem from '../../trust/C2PA-TRUST-LIST.pem';
import itlTrustPem from '../../trust/ITL-anchors.pem';
import trustConfig from '../../trust/store.cfg';
import trustMeta from '../../trust/meta.json';
import openapiYaml from '../openapi.yaml';

const TRUST_ANCHORS = {
    c2pa: c2paTrustPem,
    itl: itlTrustPem,
    config: trustConfig,
    meta: trustMeta,
};

// Computed once per isolate at startup: sha256 of each vendored trust file
// and the parsed OpenAPI document.
let startupPromise = null;
function startup() {
    if (!startupPromise) {
        startupPromise = (async () => {
            const [c2paHash, itlHash, cfgHash] = await Promise.all([
                sha256HexText(c2paTrustPem),
                sha256HexText(itlTrustPem),
                sha256HexText(trustConfig),
            ]);
            return {
                hashes: { c2pa: c2paHash, itl: itlHash, config: cfgHash },
                openapiDoc: parseYaml(openapiYaml),
            };
        })().catch((e) => {
            startupPromise = null; // retry on next request
            throw e;
        });
    }
    return startupPromise;
}

const app = new Hono();

// Stash trust anchors for every request.
app.use('*', async (c, next) => {
    c.set('trustAnchors', TRUST_ANCHORS);
    await next();
});

// Preflight is unauthenticated by nature (no Authorization header on
// OPTIONS), so it must be handled before the auth chain.
app.options('/v1/*', preflightMw);

app.get('/health', (c) => c.json({ ok: true }));

// Protected endpoints. corsMw is outermost so rate/quota errors still carry
// ACAO when the key's origin is allowed; it applies the headers after the
// chain completes, keyed off what authMw stashed.
app.post('/v1/verify', corsMw, authMw, rateLimitMw, quotaMw, verifyHandler);
app.get('/v1/verify/mini', corsMw, authMw, rateLimitMw, quotaMw, miniHandler);

// Public endpoints.
app.get('/v1/trust-lists', async (c) => {
    const { hashes } = await startup();
    const meta = JSON.parse(JSON.stringify(trustMeta));
    if (meta.lists && meta.lists.c2pa) meta.lists.c2pa.sha256 = hashes.c2pa;
    if (meta.lists && meta.lists.itl) meta.lists.itl.sha256 = hashes.itl;
    if (meta.lists && meta.lists.config) meta.lists.config.sha256 = hashes.config;
    return c.json(meta);
});

app.get('/v1/openapi.json', async (c) => {
    const { openapiDoc } = await startup();
    return c.json(openapiDoc);
});

// Unexpected exceptions: no internals in the response, detail goes to logs.
app.onError((err, c) => {
    console.error('unhandled error:', err && err.stack ? err.stack : err);
    return problem(500, 'internal_error', { detail: 'Unexpected server error.' });
});

export default app;
