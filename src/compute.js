// Browser-side adapter: URL fetching, File handling, base64 building and the
// c2pa-web engine. All pure analysis lives in packages/core (analyzeBytes).
// Produces the same JSON shapes the FastAPI endpoints returned.
import { createC2pa } from '@contentauth/c2pa-web';
import {
    analyzeBytes,
    detectFormat,
    imageMime,
    bytesToBase64,
    formatDatetimeFull,
    isVerifiedState,
} from '../packages/core/src/index.js';

// ---------------------------------------------------------------------------
// Image acquisition (platform-specific: fetch)
// ---------------------------------------------------------------------------

function isHttpUri(uri) {
    try {
        const u = new URL(uri);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function displayNameForUri(uri) {
    try {
        const u = new URL(uri);
        const seg = u.pathname.split('/').filter(Boolean).pop() || 'image';
        return decodeURIComponent(seg);
    } catch {
        return uri.split('/').pop() || 'image';
    }
}

async function fetchDirect(uri, timeoutMs) {
    const resp = await fetch(uri, {
        headers: {
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    return { bytes: buf, contentType: resp.headers.get('content-type') || '' };
}

async function fetchViaProxy(uri, timeoutMs) {
    const resp = await fetch(`/api/img?url=${encodeURIComponent(uri)}`, {
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { detail = (await resp.json()).error || detail; } catch { }
        throw new Error(detail);
    }
    const buf = await resp.arrayBuffer();
    return { bytes: buf, contentType: resp.headers.get('content-type') || '' };
}

// Mirrors ImagePathContext: direct fetch first (works when the host sends CORS
// headers), then the Pages Function proxy which fetches with browser-like
// headers on our behalf.
async function fetchImageBytes(uri, timeoutMs = 30000) {
    if (!isHttpUri(uri)) {
        throw new Error('Only http(s) image URLs are supported');
    }
    try {
        return await fetchDirect(uri, timeoutMs);
    } catch (e) {
        try {
            return await fetchViaProxy(uri, timeoutMs);
        } catch (e2) {
            throw new Error(`Failed to download image: ${e2.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// C2PA engine adapter (c2pa-web)
// ---------------------------------------------------------------------------

let _c2paPromise = null;
function getC2pa() {
    if (!_c2paPromise) {
        // Clear the cache on rejection so a transient init failure doesn't
        // poison every subsequent call; success stays cached for sharing.
        _c2paPromise = createC2pa({
            wasmSrc: new URL('vendor/c2pa_bg.wasm', document.baseURI).href,
        }).catch((err) => {
            _c2paPromise = null;
            throw err;
        });
    }
    return _c2paPromise;
}

// ---------------------------------------------------------------------------
// Trust anchors (vendored trust lists, staged to vendor/trust/)
// ---------------------------------------------------------------------------

let _trustPromise = null;
function getTrustAnchors() {
    if (!_trustPromise) {
        const base = new URL('vendor/trust/', document.baseURI).href;
        const fetchText = async (name) => {
            // Bounded wait: a stalled trust-asset request must reject so the
            // cached promise clears and a later call can retry — otherwise
            // every C2PA call wedges behind one hung fetch forever.
            const resp = await fetch(`${base}${name}`, { signal: AbortSignal.timeout(15000) });
            if (!resp.ok) throw new Error(`trust asset ${name}: HTTP ${resp.status}`);
            return resp.text();
        };
        // Fail loudly: a missing/corrupt trust list must surface as an init
        // error, never silently degrade to untrusted verification.
        _trustPromise = (async () => {
            const [c2pa, itl, config, metaText] = await Promise.all([
                fetchText('C2PA-TRUST-LIST.pem'),
                fetchText('ITL-anchors.pem'),
                fetchText('store.cfg'),
                fetchText('meta.json'),
            ]);
            return { c2pa, itl, config, meta: JSON.parse(metaText) };
        })().catch((err) => {
            _trustPromise = null;
            throw err;
        });
    }
    return _trustPromise;
}

// Implements the core engine seam:
//   init()            -> getC2pa() (rejects on SDK/wasm init failure)
//   read(bytes,mime,settings) -> null | { store, resourceToBytes, dispose }
const c2paEngine = {
    init: () => getC2pa(),
    async read(bytes, mime, settings) {
        const c2pa = await getC2pa();
        const blob = new Blob([bytes], { type: mime || 'image/jpeg' });
        const reader = await c2pa.reader.fromBlob(blob.type, blob, settings ?? undefined);
        if (!reader) return null;
        let store;
        try {
            store = await reader.manifestStore();
        } catch (e) {
            try { await reader.free(); } catch { }
            throw e;
        }
        if (!store) {
            try { await reader.free(); } catch { }
            return null;
        }
        return {
            store,
            resourceToBytes: (id) => reader.resourceToBytes(id),
            dispose: () => reader.free(),
        };
    },
};

// ---------------------------------------------------------------------------
// Public API — same response shapes as the FastAPI endpoints
// ---------------------------------------------------------------------------

export async function exifMetadata(uri, timeoutMs = 30000) {
    const { bytes, contentType } = await fetchImageBytes(uri, timeoutMs);
    const displayName = displayNameForUri(uri);
    const format = detectFormat(bytes, contentType, uri);
    const mime = imageMime(format);
    const { exif } = await analyzeBytes({
        assetHash: false,
        bytes, mime, filename: displayName, contentType,
        include: { exif: true, c2pa: false },
    });
    return { [displayName]: exif };
}

export async function c2paMetadata(uri, timeoutMs = 30000) {
    const { bytes, contentType } = await fetchImageBytes(uri, timeoutMs);
    const format = detectFormat(bytes, contentType, uri);
    const mime = imageMime(format);
    const anchors = await getTrustAnchors();
    const { c2pa } = await analyzeBytes({
        assetHash: false,
        bytes, mime, filename: displayNameForUri(uri), contentType,
        engine: c2paEngine, trust: { anchors }, include: { exif: false, c2pa: true },
    });
    return c2pa;
}

export async function c2paMini(uri, timeoutMs = 15000) {
    const more = `${location.origin}${location.pathname.replace(/\/?$/, '/')}?uri=${encodeURIComponent(uri)}`;
    const unverified = {
        creator: null, issued_by: null, issued_on: null,
        status: 'Unverified', digital_source_type: null, more,
    };
    let image;
    try {
        image = await fetchImageBytes(uri, timeoutMs);
    } catch {
        return unverified;
    }
    // SDK init + trust-asset failures propagate to the caller as an explicit
    // error — they must not be reported as 'Unverified'. Pre-init here
    // (outside the try) preserves that; analyzeBytes' own init() call then
    // resolves from the cached promises.
    await c2paEngine.init();
    const anchors = await getTrustAnchors();
    try {
        const format = detectFormat(image.bytes, image.contentType, uri);
        const mime = imageMime(format);
        const { c2pa } = await analyzeBytes({
        assetHash: false,
            bytes: image.bytes, mime, filename: displayNameForUri(uri), contentType: image.contentType,
            engine: c2paEngine, trust: { anchors }, include: { exif: false, c2pa: true },
        });
        const c2paData = c2pa && c2pa.c2pa_data;
        if (!c2paData) return unverified;

        const authorInfo = c2paData.author_info || {};
        let creator = null;
        const authors = authorInfo.author;
        if (Array.isArray(authors) && authors.length > 0) creator = (authors[0] || {}).name;
        else if (authors && typeof authors === 'object') creator = authors.name;

        const sigInfo = c2paData.signature_info || {};
        const digitalSource = c2paData.digital_source_type || {};

        return {
            creator: creator ?? null,
            issued_by: sigInfo.issuer ?? null,
            issued_on: sigInfo.time ? formatDatetimeFull(sigInfo.time, true) : null,
            status: isVerifiedState(c2paData.validation_state) ? 'Authenticity Verified' : 'Unverified',
            digital_source_type: digitalSource.label ?? null,
            more,
        };
    } catch (e) {
        console.warn('c2pa_mini failed:', e);
        return unverified;
    }
}

export async function uploadMetadata(file) {
    const bytes = await file.arrayBuffer();
    const displayName = file.name || 'unknown.jpg';
    const contentType = file.type || '';
    const format = detectFormat(bytes, contentType, displayName);
    const mime = contentType || imageMime(format);
    const anchors = await getTrustAnchors();

    const { exif, c2pa } = await analyzeBytes({
        assetHash: false,
        bytes, mime, filename: displayName, contentType,
        engine: c2paEngine, trust: { anchors }, include: { exif: true, c2pa: true },
    });

    const entry = {
        filename: exif.filename,
        format: exif.format,
        width: exif.width,
        height: exif.height,
        file_size_bytes: exif.file_size_bytes,
        file_size_mb: exif.file_size_mb,
        photography: exif.photography,
        exif: exif.exif,
        gps: exif.gps,
        iptc: exif.iptc,
        thumbnails: c2pa.thumbnails,
        provenance: c2pa.provenance,
        digital_source_type: c2pa.digital_source_type,
        author_info: c2pa.c2pa_data ? c2pa.author_info : {},
        image_data: `data:${imageMime(format)};base64,${bytesToBase64(bytes)}`,
    };

    return { [displayName]: entry };
}

// Expose for the classic script.js bundle (index.html loads this first).
if (typeof window !== 'undefined') {
    window.C2paApi = { exifMetadata, c2paMetadata, c2paMini, uploadMetadata };
}
