// Platform-free analysis core. Everything here is pure JS: no DOM, no
// window/document, no fetch, no Blob/FileReader, no wasm engine import.
// The C2PA engine is injected via the `engine` seam (see c2pa.js header).

import { detectFormat, imageMime } from './detect.js';
import { bytesDimensions } from './dimensions.js';
import { extractExif, extractIptc } from './exif.js';
import { formatPhotographyMetadata } from './photo.js';
import { readC2paAsset, emptyC2paResult } from './c2pa.js';
import { sha256Hex } from './api-result.js';

function toArrayBuffer(bytes) {
    if (bytes instanceof ArrayBuffer) return bytes;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// EXIF orientations 5–8 transpose the image: the displayed dimensions are the
// encoded ones swapped. Header parsers report encoded dimensions, while the
// pre-refactor viewer reported what createImageBitmap decoded — and its default
// imageOrientation is 'from-image', i.e. oriented dimensions. exifr translates
// Orientation to a string ('Rotate 90 CW') under the current parse options, so
// accept both the numeric and translated forms.
const TRANSPOSE_ORIENTATIONS = new Set([5, 6, 7, 8]);
const EXIFR_ORIENTATION_STRINGS = {
    'horizontal (normal)': 1,
    'mirror horizontal': 2,
    'rotate 180': 3,
    'mirror vertical': 4,
    'mirror horizontal and rotate 270 cw': 5,
    'rotate 90 cw': 6,
    'mirror horizontal and rotate 90 cw': 7,
    'rotate 270 cw': 8,
};

function orientationNumber(value) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string') {
        const mapped = EXIFR_ORIENTATION_STRINGS[value.toLowerCase()];
        if (mapped !== undefined) return mapped;
        const n = Number(value);
        if (Number.isInteger(n)) return n;
    }
    return null;
}

// The per-file EXIF entry (the value inside exifMetadata's {name: entry} map
// and the shared prefix of uploadMetadata's entry).
export async function buildExifEntry({ bytes, mime, filename, contentType }) {
    const format = detectFormat(bytes, contentType, filename);
    void mime; // mime is computed by the caller; kept in the signature for symmetry

    const dims = await bytesDimensions(bytes, mime || imageMime(format));
    const exifData = await extractExif(toArrayBuffer(bytes), filename, format, bytes.byteLength);
    const orientation = orientationNumber(exifData._rawExif && exifData._rawExif.Orientation);
    if (orientation && TRANSPOSE_ORIENTATIONS.has(orientation)) {
        exifData.width = dims.height;
        exifData.height = dims.width;
    } else {
        exifData.width = dims.width;
        exifData.height = dims.height;
    }

    // IPTC lives in the same exifr parse — extractExif stashes the raw parse.
    const iptcData = extractIptc(exifData._rawExif);

    const photography = formatPhotographyMetadata(exifData, iptcData);
    const gpsData = exifData.gps || {};
    const formattedGps = {};
    if (gpsData.latitude !== undefined && gpsData.longitude !== undefined) {
        formattedGps.latitude = gpsData.latitude;
        formattedGps.longitude = gpsData.longitude;
    }

    const entry = {
        filename,
        format: exifData.format,
        width: exifData.width,
        height: exifData.height,
        file_size_bytes: exifData.file_size_bytes,
        file_size_mb: exifData.file_size_mb,
        photography,
        exif: exifData.exif,
        gps: formattedGps,
        iptc: iptcData,
    };
    delete exifData._rawExif;
    return entry;
}

// analyzeBytes({ bytes, mime, filename, contentType, engine, trust, include, trustProfile, strict })
//   bytes:       Uint8Array | ArrayBuffer of the asset
//   mime:        image/* MIME for the asset (caller's rule)
//   filename:    display filename (used for format fallback + entry.filename)
//   contentType: raw Content-Type hint for detectFormat (may be '')
//   engine:      { init?(), read(bytes, mime, settings) } — required for c2pa
//   trust:       { anchors } — optional trust-list anchors
//   trustProfile: 'c2pa' | 'c2pa_and_itl' (default 'c2pa_and_itl') — which
//                trust lists may produce a Trusted verdict. 'c2pa' skips the
//                ITL fallback read. Omitting it keeps legacy behaviour.
//   strict:      when true, engine read failures (corrupt/unparseable input)
//                PROPAGATE instead of being swallowed into the empty result.
//                Default false — the viewer relies on the lenient behaviour.
// Returns { exif, c2pa, validation, asset, manifest }:
//   exif       — the per-file EXIF entry object, or null when include.exif === false
//   c2pa       — the c2paMetadata-shaped result object, or null when
//                include.c2pa === false / no engine. Always the full shape
//                (empty fields) when a c2pa read ran but found no manifest.
//   validation — { state, results:{success,informational,failure} } from the
//                manifest store, or null when no manifest / c2pa not run.
//                Sibling of c2pa so viewer-facing shapes stay unchanged.
//   asset      — { sha256, mime, bytes } — transport facts always present;
//                sha256 is null when the caller passes assetHash:false.
//   manifest   — { label } — store.active_manifest label, null when no manifest.
export async function analyzeBytes({ bytes, mime, filename, contentType, engine, trust, include, trustProfile = 'c2pa_and_itl', strict = false, assetHash = true }) {
    const inc = include || {};
    const wantExif = inc.exif !== false;
    const wantC2pa = inc.c2pa !== false;

    const out = {
        exif: null,
        c2pa: null,
        validation: null,
        asset: null,
        manifest: null,
    };

    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // The sha256 is a full extra pass over the asset. REST responses and the
    // async fixture-key enforcement need it; the viewer adapters never surface
    // it, so viewer callers pass assetHash:false to skip the pass on large
    // uploads. mime/bytes are transport facts and always reported.
    out.asset = {
        sha256: assetHash ? await sha256Hex(u8) : null,
        mime: mime || null,
        bytes: u8.byteLength,
    };

    if (wantExif) {
        out.exif = await buildExifEntry({ bytes, mime, filename, contentType });
    }

    if (wantC2pa) {
        if (!engine) {
            out.c2pa = emptyC2paResult();
        } else {
            // Init failures must propagate (they are not "no credentials").
            if (engine.init) await engine.init();
            try {
                const r = await readC2paAsset({ bytes, mime, engine, trust, trustProfile });
                out.c2pa = r.result;
                out.validation = r.validation;
                out.manifest = r.manifestLabel !== null ? { label: r.manifestLabel } : null;
            } catch (e) {
                if (strict) throw e;
                console.warn('C2PA extraction failed:', e);
                out.c2pa = emptyC2paResult();
            }
        }
    }

    return out;
}
