// c2pa-verify-api — Phase 1 sync API MVP.
//
//   POST /v1/verify       — multipart | JSON base64 | JSON url, full VerifyResult
//   GET  /v1/verify/mini  — compact trust card for a url
//   GET  /v1/trust-lists  — vendored trust-list provenance        (PUBLIC)
//   GET  /v1/openapi.json — the OpenAPI 3.1 document              (PUBLIC)
//   GET  /health          — ops liveness (not part of the public contract)
//
// POST /v1/jobs + GET /v1/jobs/{job_id} are the Phase 3 async surface.

import { Hono } from 'hono';
import { parse as parseYaml } from 'yaml';

import { authMw, optionalAuthMw, rateLimitMw, quotaMw } from './auth.js';
import { corsMw, dashboardCorsMw, preflightMw } from './cors.js';
import { verifyHandler, miniHandler } from './verify.js';
import { createJobHandler, getJobHandler } from './jobs.js';
import { signupFreeHandler, getKeyHandler, getUsageHandler, rotateKeyHandler, revokeKeyHandler, listJobsHandler } from './keyman.js';
import { checkoutHandler, revealHandler, portalHandler, webhookHandler } from './billing.js';
import { jobsQueueHandler } from './jobs-consumer.js';
import { JobRunner } from './job-runner.js';
import { QuotaCounter } from './quota-do.js';
import { mcpAuthMw, mcpHandler, mcpOptionsHandler } from './mcp.js';
import { problem } from './errors.js';
import { TRUST_ANCHORS, trustListsPayload } from './trust-info.js';
import openapiYaml from '../openapi.yaml';

// Parsed once per isolate at startup.
let startupPromise = null;
function startup() {
    if (!startupPromise) {
        startupPromise = (async () => ({
            openapiDoc: parseYaml(openapiYaml),
        }))().catch((e) => {
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

// Phase 2 stateless MCP endpoint. The MCP handler owns /mcp CORS and body
// parsing; the per-key browser-CORS middleware intentionally does not apply.
// Rate limiting is per authenticated HTTP request (as on REST); verification
// quota/usage is tool-aware inside the verify tools.
app.options('/mcp', mcpOptionsHandler);
app.get('/mcp', mcpAuthMw, rateLimitMw, mcpHandler);
app.post('/mcp', mcpAuthMw, rateLimitMw, mcpHandler);
app.delete('/mcp', mcpAuthMw, rateLimitMw, mcpHandler);

// Protected endpoints. corsMw is outermost so rate/quota errors still carry
// ACAO when the key's origin is allowed; it applies the headers after the
// chain completes, keyed off what authMw stashed.
app.post('/v1/verify', corsMw, authMw, rateLimitMw, quotaMw, verifyHandler);
app.get('/v1/verify/mini', corsMw, authMw, rateLimitMw, quotaMw, miniHandler);
// Quota on job creation is enforced inside createJobRecord — after the
// idempotent-replay lookup — so a replay can recover its job even at quota.
app.post('/v1/jobs', corsMw, authMw, rateLimitMw, createJobHandler);
app.get('/v1/jobs/:job_id', corsMw, authMw, rateLimitMw, getJobHandler);

// Phase 4 self-service. Signup is the single unauthenticated write surface
// (Turnstile + per-IP limited inside the handler); everything else is keyed
// by the presented key itself and never consumes verification quota.
app.post('/v1/signup/free', dashboardCorsMw, signupFreeHandler);
app.get('/v1/key', dashboardCorsMw, corsMw, authMw, rateLimitMw, getKeyHandler);
app.get('/v1/usage', dashboardCorsMw, corsMw, authMw, rateLimitMw, getUsageHandler);
app.post('/v1/key/rotate', dashboardCorsMw, corsMw, authMw, rateLimitMw, rotateKeyHandler);
app.post('/v1/key/revoke', dashboardCorsMw, corsMw, authMw, rateLimitMw, revokeKeyHandler);
app.get('/v1/jobs', dashboardCorsMw, corsMw, authMw, rateLimitMw, listJobsHandler);

// Phase 4 billing. The webhook is unauthenticated by design — the Stripe
// signature IS the credential. Checkout accepts optional key auth (upgrade in
// place vs keyless new-customer flow); reveal and portal speak for themselves.
app.post('/v1/billing/checkout', dashboardCorsMw, optionalAuthMw, checkoutHandler);
app.get('/v1/billing/reveal', dashboardCorsMw, revealHandler);
app.post('/v1/billing/portal', dashboardCorsMw, corsMw, authMw, rateLimitMw, portalHandler);
app.post('/v1/billing/webhook', webhookHandler);

// Public endpoints.
app.get('/v1/trust-lists', async (c) => c.json(await trustListsPayload()));

app.get('/v1/openapi.json', async (c) => {
    const { openapiDoc } = await startup();
    return c.json(openapiDoc);
});

// Unexpected exceptions: no internals in the response, detail goes to logs.
app.onError((err, c) => {
    console.error('unhandled error:', err && err.stack ? err.stack : err);
    return problem(500, 'internal_error', { detail: 'Unexpected server error.' });
});

export { JobRunner, QuotaCounter };

export default {
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    queue: jobsQueueHandler,
};
