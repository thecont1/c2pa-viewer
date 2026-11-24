// Platform-free analysis core. Everything here is pure JS: no DOM, no
// window/document, no fetch, no Blob/FileReader, no wasm engine import.
// The C2PA engine is injected via the `engine` seam (see c2pa.js header).

import { detectFormat, imageMime } from './detect.js';
import { bytesDimensions } from './dimensions.js';
import { extractExif, extractIptc } from './exif.js';
import { formatPhotographyMetadata } from './photo.js';
import { buildC2paResult, emptyC2paResult } from './c2pa.js';

function toArrayBuffer(bytes) {
    if (bytes instanceof ArrayBuffer) return bytes;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// The per-file EXIF entry (the value inside exifMetadata's {name: entry} map
// and the shared prefix of uploadMetadata's entry).
export async function buildExifEntry({ bytes, mime, filename, contentType }) {
    const format = detectFormat(bytes, contentType, filename);
    void mime; // mime is computed by the caller; kept in the signature for symmetry

    const dims = await bytesDimensions(bytes, mime || imageMime(format));
    const exifData = await extractExif(toArrayBuffer(bytes), filename, format, bytes.byteLength);
    exifData.width = dims.width;
    exifData.height = dims.height;

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

// analyzeBytes({ bytes, mime, filename, contentType, engine, trust, include })
//   bytes:       Uint8Array | ArrayBuffer of the asset
//   mime:        image/* MIME for the asset (caller's rule)
//   filename:    display filename (used for format fallback + entry.filename)
//   contentType: raw Content-Type hint for detectFormat (may be '')
//   engine:      { init?(), read(bytes, mime, settings) } — required for c2pa
//   trust:       { anchors } — optional trust-list anchors (Task C)
//   include:     { exif?: bool, c2pa?: bool } — default both true
// Returns { exif, c2pa }:
//   exif — the per-file EXIF entry object, or null when include.exif === false
//   c2pa — the c2paMetadata-shaped result object, or null when
//          include.c2pa === false / no engine. Always the full shape
//          (empty fields) when a c2pa read ran but found no manifest.
export async function analyzeBytes({ bytes, mime, filename, contentType, engine, trust, include }) {
    const inc = include || {};
    const wantExif = inc.exif !== false;
    const wantC2pa = inc.c2pa !== false;

    const out = { exif: null, c2pa: null };

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
                out.c2pa = await buildC2paResult({ bytes, mime, engine, trust });
            } catch (e) {
                console.warn('C2PA extraction failed:', e);
                out.c2pa = emptyC2paResult();
            }
        }
    }

    return out;
}
