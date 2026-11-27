// POST /v1/verify and GET /v1/verify/mini handlers — input parsing, MIME
// resolution, analysis and result shaping per api/openapi.yaml.

import {
    analyzeBytes,
    toApiResult,
    imageMime,
    sha256Hex,
    isVerifiedState,
    formatDatetimeFull,
} from '../../packages/core/src/index.js';
import { wasmEngine } from './engine-wasm.js';
import { problem, ApiError, MAX_SYNC_BYTES, MAX_RAW_BODY_BYTES, payloadTooLarge } from './errors.js';
import { fetchAsset } from './urlfetch.js';
import { SANDBOX_SHA256 } from './sandbox-hashes.js';
import { commitQuota } from './quota.js';
import { RATELIMIT_POLICY, RATELIMIT_LIMIT } from './auth.js';

// c2pa-wasm engine version — literal, matching the pinned
// @contentauth/c2pa-wasm dependency in package.json (0.11.6).
const ENGINE_INFO = { name: 'c2pa-wasm', version: '0.11.6' };

const INCLUDE_ALLOWED = new Set(['exif', 'iptc', 'gps', 'thumbnails', 'raw_manifest']);

// ---------------------------------------------------------------- options --

export function parseInclude(raw) {
    if (raw === undefined || raw === null || raw === '') return ['exif', 'iptc'];
    // REST accepts a comma-separated string; MCP supplies an array enum.
    const list = Array.isArray(raw)
        ? raw.map((s) => String(s).trim()).filter(Boolean)
        : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    for (const item of list) {
        if (!INCLUDE_ALLOWED.has(item)) {
            throw new ApiError('invalid', `unknown include section: ${item}`);
        }
    }
    return list.length ? list : ['exif', 'iptc'];
}

export function parseTrust(raw) {
    if (raw === undefined || raw === null || raw === '') return 'c2pa_and_itl';
    if (raw === 'c2pa' || raw === 'c2pa_and_itl') return raw;
    throw new ApiError('invalid', `unknown trust profile: ${raw}`);
}

export function parseStripGps(raw) {
    if (raw === undefined || raw === null || raw === '') return true;
    if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true;
    if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false;
    throw new ApiError('invalid', `invalid strip_gps value: ${JSON.stringify(raw)}`);
}

// Options may arrive as query parameters or as body/form fields; query wins.
function resolveOptions(c, bodyFields) {
    const q = c.req.query();
    const pick = (name) => (q[name] !== undefined ? q[name] : bodyFields[name]);
    return {
        include: parseInclude(pick('include')),
        trust: parseTrust(pick('trust')),
        strip_gps: parseStripGps(pick('strip_gps')),
    };
}

// ------------------------------------------------------------------- MIME --

// Magic-bytes sniff over the first 12 bytes — the same table core
// detectFormat uses, but WITHOUT its content-type/extension/default
// fallbacks, so "inconclusive" is representable.
function sniffMagic(u8) {
    if (u8[0] === 0xFF && u8[1] === 0xD8) return 'JPEG';
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'PNG';
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'GIF';
    if (u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57 && u8[9] === 0x45) return 'WEBP';
    if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2A) ||
        (u8[0] === 0x4D && u8[1] === 0x4D && u8[2] === 0x00)) return 'TIFF';
    return null;
}

// Content-type / extension evidence, mirroring the fallback half of core
// detectFormat (plus .jpg/.jpeg, which detectFormat reaches only as its
// default).
function formatFromHints(contentType, filename) {
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('png')) return 'PNG';
    if (ct.includes('jpeg') || ct.includes('jpg')) return 'JPEG';
    if (ct.includes('webp')) return 'WEBP';
    if (ct.includes('gif')) return 'GIF';
    if (ct.includes('tiff')) return 'TIFF';
    const path = (filename || '').split('?')[0].toLowerCase();
    if (path.endsWith('.png')) return 'PNG';
    if (path.endsWith('.webp')) return 'WEBP';
    if (path.endsWith('.gif')) return 'GIF';
    if (path.endsWith('.tif') || path.endsWith('.tiff') || path.endsWith('.dng')) return 'TIFF';
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'JPEG';
    return null;
}

// Resolve the MIME passed to analyzeBytes:
//   1. magic bytes win — sniffed format -> imageMime()
//   2. inconclusive -> declared content-type / extension, like core does
//   3. a declared non-image type with no image evidence -> 415
//   4. no evidence at all -> core default image/jpeg; the engine rejects
//      undecodable input downstream (422 reader failure)
export function resolveMime(u8, declaredType, filename) {
    const sniffed = sniffMagic(u8);
    if (sniffed) return imageMime(sniffed);

    const hinted = formatFromHints(declaredType, filename);
    if (hinted) return imageMime(hinted);

    const ct = (declaredType || '').split(';')[0].trim().toLowerCase();
    if (ct.startsWith('image/')) return ct; // declared image type we don't key on
    if (ct && ct !== 'application/octet-stream') {
        throw new ApiError('unsupported', `declared content-type is not an image type: ${ct}`);
    }
    return 'image/jpeg';
}

// ------------------------------------------------------------------ inputs --

function enforceSize(n) {
    if (n > MAX_SYNC_BYTES) throw new ApiError('too_large', 'asset exceeds the 20 MiB sync cap');
}

export function decodeBase64(data) {
    if (typeof data !== 'string' || data.length === 0) {
        throw new ApiError('invalid', 'data must be a non-empty base64 string');
    }
    let bin;
    try {
        bin = atob(data.replace(/\s+/g, ''));
    } catch {
        throw new ApiError('invalid', 'data is not valid base64');
    }
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

export function displayNameFromUrl(urlString) {
    try {
        const u = new URL(urlString);
        const seg = u.pathname.split('/').filter(Boolean).pop();
        if (seg) return decodeURIComponent(seg);
    } catch { }
    return 'image';
}

// Read the raw request body with the byte cap enforced while streaming, not
// just from the declared Content-Length — a missing or understated header must
// not let an oversized body through to the parser. The declared-length check
// stays as a fast reject.
async function readBoundedBody(rawRequest) {
    const declared = Number(rawRequest.headers.get('content-length') || 0);
    if (declared > MAX_RAW_BODY_BYTES) {
        throw new ApiError('too_large', `request body of ${declared} bytes exceeds the 28 MiB raw cap`);
    }
    if (!rawRequest.body) return new Uint8Array(0);
    const reader = rawRequest.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RAW_BODY_BYTES) {
            try { await reader.cancel(); } catch { }
            throw new ApiError('too_large', `request body exceeds the 28 MiB raw cap`);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) { out.set(chunk, off); off += chunk.byteLength; }
    return out;
}

// Parse the POST /v1/verify request into { bytes, declaredType, filename }.
// Throws ApiError for every input-level failure.
async function parseVerifyInput(c) {
    const ctHeader = c.req.header('content-type') || '';
    const ct = ctHeader.split(';')[0].trim().toLowerCase();

    if (ct === 'multipart/form-data' || ct === 'application/json') {
        // One bounded read up front; the parsers below never see an uncapped body.
        var rawBytes = await readBoundedBody(c.req.raw);
    }

    if (ct === 'multipart/form-data') {
        let form;
        try {
            const reparsed = new Request(c.req.raw.url, {
                method: c.req.raw.method,
                headers: { 'content-type': ctHeader },
                body: rawBytes,
            });
            form = await reparsed.formData();
        } catch (e) {
            throw new ApiError('invalid', `malformed multipart body: ${e && e.message ? e.message : e}`);
        }
        const file = form.get('file');
        if (!file || typeof file === 'string') {
            throw new ApiError('invalid', 'multipart form requires a file part');
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        enforceSize(bytes.byteLength);
        return {
            bytes,
            declaredType: file.type || '',
            filename: file.name || 'image',
            bodyFields: {
                include: form.get('include') ?? undefined,
                trust: form.get('trust') ?? undefined,
                strip_gps: form.get('strip_gps') ?? undefined,
            },
        };
    }

    if (ct === 'application/json') {
        let body;
        try {
            body = JSON.parse(new TextDecoder().decode(rawBytes));
        } catch {
            throw new ApiError('invalid', 'malformed JSON body');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new ApiError('invalid', 'JSON body must be an object');
        }
        // Exactly one key present, regardless of the value it carries: an
        // explicit null for the other input is ambiguous client input, not a
        // absent key, so it is rejected like any both-keys body.
        const hasData = Object.hasOwn(body, 'data');
        const hasUrl = Object.hasOwn(body, 'url');
        if (hasData === hasUrl) {
            throw new ApiError('invalid', 'provide exactly one of data or url');
        }
        if (hasUrl) {
            if (typeof body.url !== 'string') throw new ApiError('invalid', 'url must be a string');
            // Type-check the hints up front: a numeric mime or filename would
            // otherwise reach toLowerCase()/split() downstream and throw a
            // TypeError instead of a clean input error.
            if (body.mime !== undefined && body.mime !== null && typeof body.mime !== 'string') {
                throw new ApiError('invalid', 'mime must be a string');
            }
            if (body.filename !== undefined && body.filename !== null && typeof body.filename !== 'string') {
                throw new ApiError('invalid', 'filename must be a string');
            }
            const fetched = await fetchAsset(body.url, c.env);
            enforceSize(fetched.bytes.byteLength);
            return {
                bytes: fetched.bytes,
                declaredType: body.mime || fetched.contentType || '',
                filename: body.filename || displayNameFromUrl(fetched.finalUrl),
                bodyFields: body,
                sourceUrl: body.url,
            };
        }
        const bytes = decodeBase64(body.data);
        enforceSize(bytes.byteLength);
        return {
            bytes,
            declaredType: typeof body.mime === 'string' ? body.mime : '',
            filename: typeof body.filename === 'string' ? body.filename : 'image',
            bodyFields: body,
        };
    }

    throw new ApiError('unsupported_ct', `unsupported request content-type: ${ct || '(none)'} — use multipart/form-data or application/json`);
}

// --------------------------------------------------------------- metering --

// Commit one successful verification against the key's quota reservation.
// Awaited (not waitUntil) so the commit always lands before the quota
// middleware's finally-release — exactly-once is enforced by the DO's
// idempotent terminal transitions. Sandbox keys never bill quota; unlimited
// keys carry a null token and commit as a no-op. The D1 ledger write happens
// inside the DO off-path.
export async function meterVerification(env, keyRow, keyKind, bytes, quotaToken) {
    if (!keyRow) return;
    if (keyKind === 'test') return;
    await commitQuota(env, keyRow, quotaToken, bytes.byteLength);
}

function meter(c, bytes) {
    return meterVerification(c.env, c.get('keyRow'), c.get('keyKind'), bytes, c.get('quotaToken'));
}

function withRateHeaders(res) {
    res.headers.set('RateLimit-Policy', RATELIMIT_POLICY);
    res.headers.set('RateLimit-Limit', RATELIMIT_LIMIT);
    return res;
}

// Map an ApiError kind to its problem response.
export function apiErrorResponse(e) {
    switch (e.kind) {
        case 'too_large': return payloadTooLarge();
        case 'sandbox':
            return problem(403, 'forbidden', { detail: e.message });
        case 'unsupported':
        case 'unsupported_ct':
            return problem(415, 'unsupported_media_type', { detail: e.message });
        case 'ssrf':
            // Decision (documented in the Phase-1 report): SSRF-blocked urls
            // are rejected as 422 invalid_request — the spec's 422 covers
            // "unfetchable URL" inputs, and 403/502 would misattribute the
            // cause (key permission / upstream network).
            return problem(422, 'invalid_request', { detail: e.message });
        case 'upstream':
            return problem(502, 'upstream_fetch_failed', { detail: e.message });
        case 'internal':
            // Infrastructure failures (quota store, engine init, D1) are
            // server faults — 422 would misattribute them to the caller.
            return problem(500, 'internal_error', { detail: e.message });
        case 'quota':
            return problem(429, 'quota_exceeded', {
                detail: e.message,
                headers: { 'RateLimit-Policy': RATELIMIT_POLICY, 'RateLimit-Limit': RATELIMIT_LIMIT },
            });
        default:
            return problem(422, 'invalid_request', { detail: e.message });
    }
}

// Sandbox gate for c2pa_test_ keys: the asset must be one of the fixture
// corpus files. Compared on the sha256 of the exact submitted bytes.
async function sandboxCheck(c, bytes) {
    if (c.get('keyKind') !== 'test') return null;
    const hash = await sha256Hex(bytes);
    if (!SANDBOX_SHA256.has(hash)) {
        return problem(403, 'forbidden', { detail: 'test keys only accept the fixture corpus' });
    }
    return null;
}

// ---------------------------------------------------------- shared pipeline --

// runVerification — the single strict verification pipeline behind both
// POST /v1/verify and the MCP verification tools. Input acquisition is the
// caller's job; everything after byte acquisition (size cap, sandbox gate,
// MIME resolution, wasm read, API shaping, success metering) lives here so
// REST and MCP cannot drift apart.
//
// Parameters mirror the caller-visible facts:
//   bytes        exact asset bytes
//   declaredMime declared content-type / MIME hint (magic bytes still win)
//   opts         filename, trustAnchors, trust profile, include, strip_gps,
//                keyKind (test keys are corpus-restricted and unmetered)
// Returns the public VerifyResult object. Throws ApiError for caller-input
// failures; engine initialization failures propagate as server errors.
export async function runVerification(env, executionCtx, keyRow, bytes, declaredMime, opts = {}) {
    const keyKind = opts.keyKind
        || (keyRow && typeof keyRow.display_prefix === 'string' && keyRow.display_prefix.startsWith('c2pa_test_') ? 'test' : 'live');
    const filename = opts.filename || 'image';
    const trustAnchors = opts.trustAnchors;
    const trustProfile = parseTrust(opts.trust);
    const include = parseInclude(opts.include);
    const stripGps = parseStripGps(opts.strip_gps);

    enforceSize(bytes.byteLength);

    if (keyKind === 'test') {
        const hash = await sha256Hex(bytes);
        if (!SANDBOX_SHA256.has(hash)) {
            throw new ApiError('sandbox', 'test keys only accept the fixture corpus');
        }
    }

    const mime = resolveMime(bytes, declaredMime, filename);

    // Engine init failures are server-side. Init here, outside the
    // reader-failure try, so the two never conflate.
    await wasmEngine.init();

    let analysis;
    try {
        analysis = await analyzeBytes({
            bytes,
            mime,
            filename,
            contentType: declaredMime,
            engine: wasmEngine,
            trust: { anchors: trustAnchors },
            trustProfile,
            include: { exif: true, c2pa: true },
            strict: true, // reader failures on corrupt input -> caller error, not an empty result
        });
    } catch (e) {
        // strict mode only propagates engine READ failures — corrupt or
        // unparseable asset bytes are the caller's problem, not ours.
        console.error('reader failure:', e && e.message ? e.message : e);
        throw new ApiError('invalid', 'the asset could not be read — corrupt or unparseable input');
    }

    const result = toApiResult(analysis, {
        id: `ver_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
        engine: ENGINE_INFO,
        include,
        strip_gps: stripGps,
    });

    await meterVerification(env, keyRow, keyKind, bytes, opts.quotaToken);
    return result;
}

// ---------------------------------------------------------------- handlers --

export async function verifyHandler(c) {
    let input;
    try {
        input = await parseVerifyInput(c);
    } catch (e) {
        if (e instanceof ApiError) return apiErrorResponse(e);
        throw e;
    }

    let options;
    try {
        options = resolveOptions(c, input.bodyFields || {});
    } catch (e) {
        if (e instanceof ApiError) return apiErrorResponse(e);
        throw e;
    }

    let result;
    try {
        result = await runVerification(c.env, c.executionCtx, c.get('keyRow'), input.bytes, input.declaredType, {
            filename: input.filename,
            trustAnchors: c.get('trustAnchors'),
            trust: options.trust,
            include: options.include,
            strip_gps: options.strip_gps,
            keyKind: c.get('keyKind'),
            quotaToken: c.get('quotaToken'),
        });
    } catch (e) {
        if (e instanceof ApiError) return apiErrorResponse(e);
        throw e;
    }

    return withRateHeaders(Response.json(result));
}

const VIEWER_BASE = 'https://c2pa.creds.im/';

export async function miniHandler(c) {
    const sourceUrl = c.req.query('url');
    if (!sourceUrl) {
        return problem(422, 'invalid_request', { detail: 'missing required url query parameter' });
    }

    let options;
    try {
        options = resolveOptions(c, {});
    } catch (e) {
        if (e instanceof ApiError) return apiErrorResponse(e);
        throw e;
    }

    let fetched;
    try {
        fetched = await fetchAsset(sourceUrl, c.env);
    } catch (e) {
        if (e instanceof ApiError) return apiErrorResponse(e);
        throw e;
    }

    const forbidden = await sandboxCheck(c, fetched.bytes);
    if (forbidden) return forbidden;

    let mime;
    try {
        mime = resolveMime(fetched.bytes, fetched.contentType, displayNameFromUrl(fetched.finalUrl));
    } catch (e) {
        if (e instanceof ApiError) return apiErrorResponse(e);
        throw e;
    }

    await wasmEngine.init();

    // Lenient analysis, matching the viewer's c2paMini semantics: an
    // unparseable or manifest-less asset is simply Unverified.
    const analysis = await analyzeBytes({
        bytes: fetched.bytes,
        mime,
        filename: displayNameFromUrl(fetched.finalUrl),
        contentType: fetched.contentType,
        engine: wasmEngine,
        trust: { anchors: c.get('trustAnchors') },
        trustProfile: options.trust,
        include: { exif: false, c2pa: true },
    });

    const more = `${VIEWER_BASE}?uri=${encodeURIComponent(sourceUrl)}`;
    const c2pa = analysis.c2pa || {};
    const trustBlock = c2pa.trust || {};
    const trust = {
        state: trustBlock.state ?? null,
        basis: trustBlock.basis ?? null,
    };

    const c2paData = c2pa.c2pa_data;
    let body;
    if (!c2paData) {
        body = {
            creator: null,
            digital_source_type: null,
            issued_by: null,
            issued_on: null,
            status: 'Unverified',
            trust,
            more,
        };
    } else {
        // Same label logic as the viewer's c2paMini.
        const authorInfo = c2paData.author_info || {};
        let creator = null;
        const authors = authorInfo.author;
        if (Array.isArray(authors) && authors.length > 0) creator = (authors[0] || {}).name ?? null;
        else if (authors && typeof authors === 'object') creator = authors.name ?? null;

        const sigInfo = c2paData.signature_info || {};
        const digitalSource = c2paData.digital_source_type || {};
        body = {
            creator,
            digital_source_type: digitalSource.label ?? null,
            issued_by: sigInfo.issuer ?? null,
            issued_on: sigInfo.time ? formatDatetimeFull(sigInfo.time, true) : null,
            status: isVerifiedState(c2paData.validation_state) ? 'Authenticity Verified' : 'Unverified',
            trust,
            more,
        };
    }

    await meter(c, fetched.bytes);
    return withRateHeaders(Response.json(body));
}
