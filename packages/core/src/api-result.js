// Public API result mapper — pure functions, no I/O.
//
// toApiResult(analysis, opts) reshapes the internal analyzeBytes() output
// into the public /v1 VerifyResult contract (see api/openapi.yaml).
//
// Field provenance (internal -> public):
//   id                     <- opts.id (caller-supplied, e.g. "ver_…")
//   engine.name/version    <- opts.engine.{name,version} (caller-supplied)
//   engine.trust_lists     <- analysis.c2pa.trust.lists
//                             ({c2pa:{commit,date}, itl:{fetched_at}}),
//                             nulls when trust was not evaluated
//   status                 <- analysis.c2pa.trust.state:
//                             Trusted->trusted, Valid->valid_untrusted,
//                             Invalid->invalid, none->no_manifest
//                             (falls back to analysis.validation.state when
//                             the trust block is absent)
//   trust.basis            <- analysis.c2pa.trust.basis
//                             ("c2pa_trust_list"|"interim_trust_list"|"none"|null)
//   validation.state       <- analysis.validation.state (manifest store
//                             validation_state: Valid|Invalid|Trusted|null)
//   validation.{success,informational,failure} <- analysis.validation.results
//                             buckets, Code = {code, explanation, url?}
//   active_manifest.label            <- analysis.manifest.label
//                             (store.active_manifest)
//   active_manifest.claim_generator  <- c2pa_data.basic_info.claim_generator
//   active_manifest.signer           <- c2pa_data.signature_info:
//                             issuer<-issuer, common_name<-common_name,
//                             serial_number<-cert_serial_number,
//                             signed_at<-time
//   active_manifest.digital_source_type <- c2pa_data.digital_source_type
//   active_manifest.author           <- c2pa_data.author_info (null when empty)
//   active_manifest.actions          <- c2pa_data.actions
//   active_manifest.ingredients      <- c2pa_data.ingredients
//   provenance             <- analysis.c2pa.provenance (passthrough, includes
//                             the "Signer Trust" row when trust ran)
//   metadata.exif          <- analysis.exif.exif        (include: "exif")
//   metadata.iptc          <- analysis.exif.iptc        (include: "iptc")
//   metadata.gps           <- analysis.exif.gps, null when strip_gps
//                             (include: "gps"); GPS keys never appear in
//                             exif/iptc by construction (verified: the EXIF
//                             tag allowlist and IPTC map contain no GPS fields)
//   metadata.dimensions    <- analysis.exif.{width,height} (always present)
//   asset.sha256           <- analysis.asset.sha256 (computed by analyzeBytes)
//   asset.mime/bytes       <- analysis.asset.{mime,bytes}
//   asset.width/height     <- analysis.exif.{width,height} (null if unknown)
//   thumbnails             <- analysis.c2pa.thumbnails (include: "thumbnails"):
//                             claim_thumbnail (b64) -> {mime,data_base64},
//                             ingredient_thumbnail (b64) ->
//                             ingredient_thumbnails:[{mime,data_base64}]
//   raw_manifest           <- analysis.c2pa.c2pa_data (include: "raw_manifest")
//
// include is a subset of ["exif","iptc","gps","thumbnails","raw_manifest"];
// default ["exif","iptc"]. Sections not listed are omitted entirely.

import { emptyC2paResult } from './c2pa.js';

export async function sha256Hex(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = await crypto.subtle.digest('SHA-256', u8);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const API_INCLUDE = new Set(['exif', 'iptc', 'gps', 'thumbnails', 'raw_manifest']);

function normalizeInclude(include) {
    const list = Array.isArray(include) && include.length ? include : ['exif', 'iptc'];
    return new Set(list.filter((s) => API_INCLUDE.has(s)));
}

function statusFromTrust(c2pa, validation) {
    const state = c2pa.trust && c2pa.trust.state !== undefined ? c2pa.trust.state : null;
    if (state === 'Trusted') return 'trusted';
    if (state === 'Valid') return 'valid_untrusted';
    if (state === 'Invalid') return 'invalid';
    if (state === null && c2pa.c2pa_data) {
        // Trust block absent (anchors not supplied): fall back to the
        // manifest store's own validation_state.
        const vs = validation && validation.state;
        if (vs === 'Trusted') return 'trusted';
        if (vs === 'Valid') return 'valid_untrusted';
        if (vs === 'Invalid') return 'invalid';
    }
    return 'no_manifest';
}

// Sniff the image MIME of a base64 thumbnail payload from its magic bytes.
function thumbMime(dataBase64) {
    try {
        const bin = atob(dataBase64.slice(0, 64));
        const b = [...bin].map((c) => c.charCodeAt(0));
        if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
        if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
        if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
        if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
    } catch { }
    return 'application/octet-stream';
}

function nonEmpty(obj) {
    return obj && typeof obj === 'object' && Object.keys(obj).length > 0;
}

export function toApiResult(analysis, { id, engine, include, strip_gps = true } = {}) {
    const c2pa = analysis.c2pa || emptyC2paResult();
    const exifEntry = analysis.exif || null;
    const validation = analysis.validation || null;
    const inc = normalizeInclude(include);
    const hasManifest = !!c2pa.c2pa_data;

    const trustBlock = c2pa.trust || null;
    const trustLists = (trustBlock && trustBlock.lists) || {
        c2pa: { commit: null, date: null },
        itl: { fetched_at: null },
    };

    const out = {
        id: id ?? null,
        engine: {
            name: engine && engine.name !== undefined ? engine.name : null,
            version: engine && engine.version !== undefined ? engine.version : null,
            trust_lists: trustLists,
        },
        status: statusFromTrust(c2pa, validation),
        trust: { basis: trustBlock ? (trustBlock.basis ?? null) : null },
        validation: {
            state: validation ? validation.state : null,
            success: (validation && validation.results && validation.results.success) || [],
            informational: (validation && validation.results && validation.results.informational) || [],
            failure: (validation && validation.results && validation.results.failure) || [],
        },
        active_manifest: null,
        provenance: c2pa.provenance || [],
        metadata: {},
        asset: {
            sha256: analysis.asset ? analysis.asset.sha256 : null,
            mime: analysis.asset ? analysis.asset.mime : null,
            bytes: analysis.asset ? analysis.asset.bytes : null,
            width: exifEntry ? exifEntry.width : null,
            height: exifEntry ? exifEntry.height : null,
        },
    };

    if (hasManifest) {
        const data = c2pa.c2pa_data;
        const basic = data.basic_info || {};
        const sig = data.signature_info || {};
        const author = nonEmpty(data.author_info) ? data.author_info : null;
        out.active_manifest = {
            label: analysis.manifest ? analysis.manifest.label : null,
            claim_generator: basic.claim_generator ?? null,
            signer: {
                issuer: sig.issuer ?? null,
                common_name: sig.common_name ?? null,
                serial_number: sig.cert_serial_number ?? null,
                signed_at: sig.time ?? null,
            },
            digital_source_type: data.digital_source_type || null,
            author,
            actions: data.actions || [],
            ingredients: data.ingredients || [],
        };
    }

    if (exifEntry) {
        if (inc.has('exif')) out.metadata.exif = exifEntry.exif || {};
        if (inc.has('iptc')) out.metadata.iptc = exifEntry.iptc || {};
        if (inc.has('gps')) {
            const gps = exifEntry.gps;
            out.metadata.gps = !strip_gps && nonEmpty(gps) ? gps : null;
        }
    }
    out.metadata.dimensions = {
        width: exifEntry ? exifEntry.width : null,
        height: exifEntry ? exifEntry.height : null,
    };

    if (inc.has('thumbnails')) {
        const thumbs = c2pa.thumbnails || {};
        const t = {};
        if (thumbs.claim_thumbnail) {
            t.claim_thumbnail = { mime: thumbMime(thumbs.claim_thumbnail), data_base64: thumbs.claim_thumbnail };
        }
        if (thumbs.ingredient_thumbnail) {
            t.ingredient_thumbnails = [{
                mime: thumbMime(thumbs.ingredient_thumbnail),
                data_base64: thumbs.ingredient_thumbnail,
            }];
        }
        out.thumbnails = t;
    }

    if (inc.has('raw_manifest')) {
        out.raw_manifest = hasManifest ? c2pa.c2pa_data : null;
    }

    return out;
}
