// Phase 2 MCP endpoint — stateless Streamable HTTP at /mcp.
//
// Authentication happens in Hono before this module delegates to the Agents
// SDK handler. The handler is constructed per request so the server factory
// closes over that request's authenticated key row, key kind, env,
// execution context and trust anchors. Ordinary tools/resources do not need
// handler-level notifications, so the per-request handler lifetime is safe
// (and is explicitly supported for this stateless use case).

import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import * as z from 'zod/v4';

import { authenticateBearer, checkQuota } from './auth.js';
import { problem } from './errors.js';
import {
    runVerification,
    decodeBase64,
    displayNameFromUrl,
} from './verify.js';
import { fetchAsset } from './urlfetch.js';
import { explainValidationCode } from './validation-codes.js';
import { trustListsPayload } from './trust-info.js';

const SERVER_INSTRUCTIONS = [
    'This server verifies C2PA provenance in image files using the same engine and trust lists as the c2pa-verify REST API.',
    'Verification answers whether a file carries a structurally valid, cryptographically intact, and optionally trusted C2PA manifest; it does not determine whether the image itself is real, authentic, or unmanipulated in a broader journalistic sense.',
    'Use verify_image for the compact high-frequency trust card and verify_image_detailed when you need validation buckets, provenance rows, metadata, ingredients, or the raw manifest.',
    'Use explain_validation_code to interpret validator codes and list_trust_lists or trust://current to inspect the trust-list revision in force.',
].join(' ');

const TRUST_PROFILES = ['c2pa', 'c2pa_and_itl'];
const INCLUDE_VALUES = ['exif', 'iptc', 'gps', 'thumbnails', 'raw_manifest'];

const verifyInputSchema = z.strictObject({
    url: z.string().url().optional()
        .describe('HTTP(S) URL of the image to fetch server-side and verify. Mutually exclusive with data.'),
    data: z.string().min(1).optional()
        .describe('Base64-encoded image bytes. Requires mime and is mutually exclusive with url.'),
    mime: z.string().min(1).optional()
        .describe('Declared MIME type for data input, for example image/jpeg.'),
    trust: z.enum(TRUST_PROFILES).optional()
        .describe('Trust profile. c2pa_and_itl (default) also honors the interim trust list; c2pa uses only the official C2PA trust list.'),
});

const verifyDetailedInputSchema = z.strictObject({
    url: z.string().url().optional()
        .describe('HTTP(S) URL of the image to fetch server-side and verify. Mutually exclusive with data.'),
    data: z.string().min(1).optional()
        .describe('Base64-encoded image bytes. Requires mime and is mutually exclusive with url.'),
    mime: z.string().min(1).optional()
        .describe('Declared MIME type for data input, for example image/jpeg.'),
    trust: z.enum(TRUST_PROFILES).optional()
        .describe('Trust profile. c2pa_and_itl (default) also honors the interim trust list; c2pa uses only the official C2PA trust list.'),
    include: z.array(z.enum(INCLUDE_VALUES)).optional()
        .describe('Optional detail sections to include. Defaults to exif and iptc, matching the REST API.'),
    strip_gps: z.boolean().optional()
        .describe('When true (default), GPS coordinates are stripped from the result even when gps is included.'),
});

const compactOutputSchema = z.strictObject({
    status: z.enum(['trusted', 'valid_untrusted', 'invalid', 'no_manifest']),
    trust: z.strictObject({
        state: z.enum(['Trusted', 'Valid', 'Invalid']).nullable(),
        basis: z.enum(['c2pa_trust_list', 'interim_trust_list', 'none']).nullable(),
    }),
    signer: z.strictObject({
        issuer: z.string().nullable(),
        common_name: z.string().nullable(),
        signed_at: z.string().nullable(),
    }).nullable(),
    claim_generator: z.string().nullable(),
    digital_source_type: z.strictObject({
        code: z.string(),
        label: z.string(),
    }).nullable(),
    validation_failures: z.array(z.string()),
    asset: z.strictObject({
        sha256: z.string(),
        mime: z.string().nullable(),
        bytes: z.number().int().nonnegative(),
    }),
    thumbnail: z.boolean(),
});

// A deliberately tolerant structured representation of the REST VerifyResult.
// The authoritative field-level contract remains api/openapi.yaml; looseness
// here avoids turning additive manifest/metadata shapes into MCP errors.
const verifyResultOutputSchema = z.looseObject({
    id: z.string(),
    engine: z.looseObject({
        name: z.string(),
        version: z.string(),
        trust_lists: z.looseObject({}),
    }),
    status: z.enum(['trusted', 'valid_untrusted', 'invalid', 'no_manifest']),
    trust: z.looseObject({ basis: z.string().nullable() }),
    validation: z.looseObject({
        state: z.string().nullable(),
        success: z.array(z.unknown()),
        informational: z.array(z.unknown()),
        failure: z.array(z.unknown()),
    }),
    active_manifest: z.looseObject({}).nullable(),
    provenance: z.array(z.unknown()),
    metadata: z.looseObject({}),
    asset: z.looseObject({
        sha256: z.string(),
        mime: z.string().nullable(),
        bytes: z.number().int().nonnegative(),
        width: z.number().int().nullable(),
        height: z.number().int().nullable(),
    }),
});

const explainOutputSchema = z.strictObject({
    code: z.string(),
    title: z.string(),
    severity: z.enum(['info', 'warning', 'error']),
    explanation: z.string(),
    what_it_means: z.string(),
    common_causes: z.array(z.string()),
    spec_reference: z.string().optional(),
});

const trustListsOutputSchema = z.looseObject({});

function jsonResult(value) {
    return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
    };
}

function toolInputError(message) {
    // Tool-handler throws are serialized by SDK v2 as ordinary tool results
    // with isError:true. That is the model-visible recovery channel; HTTP and
    // JSON-RPC transport errors are reserved for protocol/transport failures.
    return new Error(message);
}

function sourcePresence(args) {
    return {
        hasUrl: args.url !== undefined && args.url !== null,
        hasData: args.data !== undefined && args.data !== null,
    };
}

function validateSourceArguments(args) {
    const { hasUrl, hasData } = sourcePresence(args);
    if (hasUrl === hasData) throw toolInputError('provide exactly one of data or url');
    if (hasData && (args.mime === undefined || args.mime === null || args.mime === '')) {
        throw toolInputError('data input requires mime');
    }
    if (hasUrl && args.mime !== undefined && args.mime !== null) {
        throw toolInputError('mime is only valid with data input');
    }
}

async function acquireToolInput(args, env) {
    validateSourceArguments(args);
    if (args.url !== undefined && args.url !== null) {
        const fetched = await fetchAsset(args.url, env);
        return {
            bytes: fetched.bytes,
            declaredType: fetched.contentType || '',
            filename: displayNameFromUrl(fetched.finalUrl),
        };
    }
    return {
        bytes: decodeBase64(args.data),
        declaredType: args.mime,
        filename: 'image',
    };
}

async function runMeteredVerification(args, context, resultInclude) {
    // REST performs quota before any verification work. Rate limiting is done
    // once per authenticated /mcp HTTP request in Hono middleware; the quota
    // check is necessarily tool-aware and therefore lives here.
    const quotaFailure = await checkQuota(context.env.DB, context.keyRow);
    if (quotaFailure) throw toolInputError(quotaFailure.detail);

    const input = await acquireToolInput(args, context.env);
    return runVerification(context.env, context.executionCtx, context.keyRow, input.bytes, input.declaredType, {
        filename: input.filename,
        trustAnchors: context.trustAnchors,
        trust: args.trust,
        include: resultInclude,
        strip_gps: args.strip_gps,
        keyKind: context.keyKind,
    });
}

function trustStateFromStatus(status) {
    if (status === 'trusted') return 'Trusted';
    if (status === 'valid_untrusted') return 'Valid';
    if (status === 'invalid') return 'Invalid';
    return null;
}

function compactTrustCard(result) {
    const manifest = result.active_manifest || null;
    const signer = manifest && manifest.signer ? {
        issuer: manifest.signer.issuer ?? null,
        common_name: manifest.signer.common_name ?? null,
        signed_at: manifest.signer.signed_at ?? null,
    } : null;
    const dst = manifest && manifest.digital_source_type ? manifest.digital_source_type : null;
    const failures = ((result.validation && result.validation.failure) || [])
        .map((entry) => entry && entry.code)
        .filter((code) => typeof code === 'string');
    const thumbs = result.thumbnails || {};
    return {
        status: result.status,
        trust: {
            state: trustStateFromStatus(result.status),
            basis: result.trust ? (result.trust.basis ?? null) : null,
        },
        signer,
        claim_generator: manifest ? (manifest.claim_generator ?? null) : null,
        digital_source_type: dst && dst.code && dst.label ? { code: dst.code, label: dst.label } : null,
        validation_failures: failures,
        asset: {
            sha256: result.asset ? result.asset.sha256 : null,
            mime: result.asset ? result.asset.mime : null,
            bytes: result.asset ? result.asset.bytes : 0,
        },
        thumbnail: Boolean(
            thumbs.claim_thumbnail
            || (Array.isArray(thumbs.ingredient_thumbnails) && thumbs.ingredient_thumbnails.length > 0)
        ),
    };
}

function createServer(context) {
    const server = new McpServer(
        { name: 'c2pa-verify-api', version: '0.2.0' },
        { instructions: SERVER_INSTRUCTIONS },
    );

    server.registerTool(
        'verify_image',
        {
            title: 'Verify image provenance (compact)',
            description: 'Verify C2PA provenance for one image and return a token-efficient trust card. Accepts either a public HTTP(S) url or base64 data with a declared mime. This answers whether the file carries valid/trusted C2PA provenance; it does not establish whether the depicted content is real.',
            inputSchema: verifyInputSchema,
            outputSchema: compactOutputSchema,
        },
        async (args) => {
            // Include thumbnails internally only so the compact boolean is
            // accurate; the base64 payloads are stripped from the response.
            const result = await runMeteredVerification(args, context, ['thumbnails']);
            return jsonResult(compactTrustCard(result));
        },
    );

    server.registerTool(
        'verify_image_detailed',
        {
            title: 'Verify image provenance (detailed)',
            description: 'Verify C2PA provenance for one image and return the full VerifyResult object, equivalent to POST /v1/verify on the REST API. Use this only when the compact trust card is insufficient.',
            inputSchema: verifyDetailedInputSchema,
            outputSchema: verifyResultOutputSchema,
        },
        async (args) => jsonResult(await runMeteredVerification(args, context, args.include)),
    );

    server.registerTool(
        'explain_validation_code',
        {
            title: 'Explain a C2PA validation code',
            description: 'Explain a c2pa-rs/C2PA validation status code in plain language, including severity, operational meaning, and common causes. Unknown codes return a generic info entry rather than an error.',
            inputSchema: z.strictObject({
                code: z.string().min(1).describe('Validation code, for example claimSignature.mismatch'),
            }),
            outputSchema: explainOutputSchema,
        },
        async ({ code }) => jsonResult(explainValidationCode(code)),
    );

    server.registerTool(
        'list_trust_lists',
        {
            title: 'List active trust lists',
            description: 'Return provenance and digest metadata for the trust lists currently used by this verifier. This is the same data as GET /v1/trust-lists.',
            inputSchema: z.strictObject({}),
            outputSchema: trustListsOutputSchema,
        },
        async () => jsonResult(await trustListsPayload()),
    );

    server.registerResource(
        'current-trust-lists',
        'trust://current',
        {
            title: 'Current trust lists',
            description: 'JSON summary of the active C2PA and interim trust-list revisions used by this verifier.',
            mimeType: 'application/json',
        },
        async (uri) => {
            const payload = await trustListsPayload();
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify(payload),
                }],
            };
        },
    );

    return server;
}

function mcpHandlerFor(c) {
    const context = {
        env: c.env,
        executionCtx: c.executionCtx,
        keyRow: c.get('keyRow'),
        keyKind: c.get('keyKind'),
        trustAnchors: c.get('trustAnchors'),
    };
    return createMcpHandler(() => createServer(context), {
        route: '/mcp',
        onerror: (error) => console.error('mcp handler error:', error),
    });
}

// Bearer auth for MCP. Unlike REST, revoked credentials are intentionally
// collapsed into 401 unauthorized: the phase-2 contract requires credential
// failures at this endpoint to be a clean HTTP 401 challenge.
export async function mcpAuthMw(c, next) {
    const auth = await authenticateBearer(c.env, c.req.header('authorization'));
    if (auth.error) {
        let { status, code, detail, headers } = auth.error;
        if (auth.error.reason === 'revoked') {
            status = 401;
            code = 'unauthorized';
            headers = { 'WWW-Authenticate': 'Bearer' };
        }
        return problem(status, code, { detail, headers });
    }

    if (auth.row.type === 'browser') {
        return problem(403, 'forbidden', {
            detail: 'Browser keys may only call GET /v1/verify/mini.',
        });
    }

    c.set('keyRow', auth.row);
    c.set('keyKind', auth.kind);
    await next();
}

// Delegate the raw Request untouched. The Agents handler owns body parsing,
// content negotiation, JSON/SSE response selection, and its wildcard CORS.
export async function mcpHandler(c) {
    return mcpHandlerFor(c).fetch(c.req.raw);
}

// OPTIONS never carries Authorization. The Agents wrapper answers preflight
// before invoking the server factory, so it is safe to delegate here without
// an authenticated context.
export async function mcpOptionsHandler(c) {
    return mcpHandlerFor(c).fetch(c.req.raw);
}
