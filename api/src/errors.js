// RFC 9457 problem+json helpers. Every error the API returns uses the
// application/problem+json shape with a machine-readable `code` member
// (see api/openapi.yaml components.schemas.Problem).

// Titles follow the spec examples, keyed by code (they are per-code in
// openapi.yaml, not per-status).
const CODE_TITLES = {
    unauthorized: 'Unauthorized',
    forbidden: 'Forbidden',
    rate_limited: 'Too Many Requests',
    quota_exceeded: 'Too Many Requests',
    payload_too_large: 'Payload Too Large',
    unsupported_media_type: 'Unsupported Media Type',
    invalid_request: 'Unprocessable Entity',
    upstream_fetch_failed: 'Upstream Fetch Failed',
    job_not_found: 'Job not found',
    internal_error: 'Internal Server Error',
    billing_not_configured: 'Service Unavailable',
    billing_unavailable: 'Bad Gateway',
    payment_required: 'Payment Required',
    not_found: 'Not Found',
    gone: 'Gone',
};

// buildProblemPayload(status, code, detail, extra) — the plain object form of
// a problem, shared by the REST error responses and the stored job errors
// assembled in jobs.js (so a title/type change reaches both).
export function buildProblemPayload(status, code, detail, extra = {}) {
    const body = {
        type: `https://c2pa.creds.im/problems/${code}`,
        title: CODE_TITLES[code] || 'Error',
        status,
        code,
    };
    if (detail) body.detail = detail;
    Object.assign(body, extra);
    return body;
}

// problem(status, code, { detail, headers, ...extraMembers })
// Builds the problem response. `type` follows the spec convention
// https://c2pa.creds.im/problems/<code>.
export function problem(status, code, { detail, headers = {}, ...extra } = {}) {
    const body = buildProblemPayload(status, code, detail, extra);
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/problem+json', ...headers },
    });
}

// Thrown for input-level failures that map to a problem response.
// `kind` selects the mapping in verify.js:
//   'invalid'   -> 422 invalid_request (corrupt asset, bad base64, bad options)
//   'ssrf'      -> 422 invalid_request with a host-not-allowed detail
//   'upstream'  -> 502 upstream_fetch_failed
//   'too_large' -> 413 payload_too_large (+ max_sync_bytes member)
export class ApiError extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind;
    }
}

export const MAX_SYNC_BYTES = 20 * 1024 * 1024;       // 20 MiB decoded asset cap
// Raw request body cap. Base64 inflates 4/3, so a exactly-at-cap 20 MiB asset
// is 27,962,028 bytes on the wire before the JSON envelope; 28 MiB carries it
// with envelope slack while still bounding what the server buffers. A 20 MiB+1
// asset therefore reaches — and is rejected by — the decoded-size check rather
// than the transport cap.
export const MAX_RAW_BODY_BYTES = 28 * 1024 * 1024;   // 28 MiB raw request body cap

export function payloadTooLarge() {
    return problem(413, 'payload_too_large', {
        detail: 'The asset exceeds the 20 MiB synchronous verification cap.',
        max_sync_bytes: MAX_SYNC_BYTES,
        hint: 'Use POST /v1/jobs for assets larger than 20 MiB.',
    });
}
