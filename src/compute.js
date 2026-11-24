// Browser-side port of server.py's metadata pipeline.
// Produces the same JSON shapes the FastAPI endpoints returned.
import { createC2pa } from '@contentauth/c2pa-web';
import { parse as exifrParse } from 'exifr';

// ---------------------------------------------------------------------------
// Constants (ported verbatim from server.py)
// ---------------------------------------------------------------------------

const DIGITAL_SOURCE_TYPE_LABELS = {
    'digitalCapture': 'Digital Camera',
    'negativeFilm': 'Negative Film Scan',
    'positiveFilm': 'Slide Film Scan',
    'print': 'Print Scan',
    'screenCapture': 'Screen Capture',
    'trainedAlgorithmicMedia': 'Generative AI',
    'algorithmicallyEnhanced': 'AI Enhanced',
    'minorHumanEdits': 'Lightly Edited',
    'compositeCapture': 'Composite (Camera)',
    'compositeDigital': 'Composite (Digital)',
    'compositeSynthetic': 'Composite (Synthetic)',
    'compositeWithTrainedAlgorithmicMedia': 'Composite (AI + Camera)',
    'multiFrameComputationalCapture': 'Computational Photography',
    'virtualRecording': 'Virtual Recording',
    'digitalArt': 'Digital Art',
    'dataDrivenMedia': 'Data-Driven Media',
};

// exifr's output names differ from the EXIF tag names server.py used;
// EXIF_ALIASES maps them back so response shapes stay identical.
const EXIF_TAGS = [
    'Make', 'Model', 'XResolution', 'YResolution', 'Software', 'ModifyDate',
    'Artist', 'Copyright', 'DateTimeOriginal', 'CreateDate',
    'ImageDescription', 'UserComment', 'ApertureValue', 'MeteringMode',
    'Flash', 'FocalLength', 'ColorSpace', 'SensingMethod', 'ExposureMode',
    'WhiteBalance', 'ISO', 'FNumber', 'ExposureTime', 'LensModel',
];

const EXIF_ALIASES = {
    ISO: 'ISOSpeedRatings',
    CreateDate: 'DateTimeDigitized',
    ModifyDate: 'DateTime',
};

const IPTC_MAP = {
    title: 'ObjectName',
    description: 'Caption',
    keywords: 'Keywords',
    author: 'Byline',
    city: 'City',
    location: 'Sublocation',
    copyright: 'CopyrightNotice',
};

// ---------------------------------------------------------------------------
// Image acquisition
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

function detectFormat(bytes, contentType, uri) {
    const u8 = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
    if (u8[0] === 0xFF && u8[1] === 0xD8) return 'JPEG';
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'PNG';
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'GIF';
    if (u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57 && u8[9] === 0x45) return 'WEBP';
    if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2A) ||
        (u8[0] === 0x4D && u8[1] === 0x4D && u8[2] === 0x00)) return 'TIFF';
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('png')) return 'PNG';
    if (ct.includes('jpeg') || ct.includes('jpg')) return 'JPEG';
    if (ct.includes('webp')) return 'WEBP';
    if (ct.includes('gif')) return 'GIF';
    if (ct.includes('tiff')) return 'TIFF';
    const path = (uri || '').split('?')[0].toLowerCase();
    if (path.endsWith('.png')) return 'PNG';
    if (path.endsWith('.webp')) return 'WEBP';
    if (path.endsWith('.gif')) return 'GIF';
    if (path.endsWith('.tif') || path.endsWith('.tiff') || path.endsWith('.dng')) return 'TIFF';
    return 'JPEG';
}

async function imageDimensions(bytes, mime) {
    try {
        const blob = new Blob([bytes], { type: mime });
        const bmp = await createImageBitmap(blob);
        const { width, height } = bmp;
        bmp.close();
        return { width, height };
    } catch {
        return { width: null, height: null };
    }
}

// ---------------------------------------------------------------------------
// C2PA (via @contentauth/c2pa-web)
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

async function readManifestStore(bytes, mime) {
    const c2pa = await getC2pa();
    const blob = new Blob([bytes], { type: mime || 'image/jpeg' });
    const reader = await c2pa.reader.fromBlob(blob.type, blob);
    if (!reader) return null;
    const store = await reader.manifestStore();
    if (!store) return null;
    return { reader, store };
}

function activeManifest(store) {
    const label = store && store.active_manifest;
    const manifests = (store && store.manifests) || {};
    if (!label || !(label in manifests)) return null;
    return manifests[label];
}

function extractSocialLinks(assertionData) {
    const socialLinks = {};
    if (!assertionData) return socialLinks;

    const authorArray = assertionData.author;
    if (Array.isArray(authorArray)) {
        for (const author of authorArray) {
            if (author && typeof author === 'object') {
                const authorId = author['@id'] || '';
                if (authorId && typeof authorId === 'string') {
                    const lower = authorId.toLowerCase();
                    if (lower.includes('instagram.com')) socialLinks.instagram = authorId;
                    else if (lower.includes('twitter.com') || lower.includes('x.com')) socialLinks.twitter = authorId;
                    else if (lower.includes('linkedin.com')) socialLinks.linkedin = authorId;
                }
            }
        }
    }

    const socialMappings = {
        instagram: ['instagram', 'instagram_url'],
        twitter: ['twitter', 'twitter_url', 'x_url'],
        linkedin: ['linkedin', 'linkedin_url'],
    };
    for (const [socialType, keys] of Object.entries(socialMappings)) {
        if (socialLinks[socialType]) continue;
        for (const key of keys) {
            let value = assertionData[key];
            if (value) {
                if (typeof value !== 'string') value = String(value);
                if (!value.startsWith('http://') && !value.startsWith('https://')) {
                    value = `https://${value}`;
                }
                socialLinks[socialType] = value;
                break;
            }
        }
    }

    const urlField = assertionData.url;
    if (typeof urlField === 'string') {
        const lower = urlField.toLowerCase();
        if (lower.includes('instagram.com') && !socialLinks.instagram) socialLinks.instagram = urlField;
        else if ((lower.includes('twitter.com') || lower.includes('x.com')) && !socialLinks.twitter) socialLinks.twitter = urlField;
        else if (lower.includes('linkedin.com') && !socialLinks.linkedin) socialLinks.linkedin = urlField;
    }

    const urls = assertionData.url;
    if (Array.isArray(urls)) {
        for (const url of urls) {
            if (typeof url !== 'string') continue;
            const lower = url.toLowerCase();
            if (lower.includes('instagram.com') && !socialLinks.instagram) socialLinks.instagram = url;
            else if ((lower.includes('twitter.com') || lower.includes('x.com')) && !socialLinks.twitter) socialLinks.twitter = url;
            else if (lower.includes('linkedin.com') && !socialLinks.linkedin) socialLinks.linkedin = url;
        }
    }

    return socialLinks;
}

function getDigitalSourceType(c2paData) {
    if (!c2paData) return [null, null];

    const claimGenerator = ((c2paData.basic_info && c2paData.basic_info.claim_generator) || '').toLowerCase();
    const aiTools = ['firefly', 'dall-e', 'dalle', 'midjourney', 'stable diffusion',
        'generative fill', 'generative remove', 'generative'];
    if (aiTools.some(t => claimGenerator.includes(t))) {
        return ['trainedAlgorithmicMedia', 'Generative AI'];
    }

    const scanActions = (actionsList) => {
        for (const action of actionsList || []) {
            const actionName = (action.action || '').toLowerCase();
            const softwareAgent = (action.softwareAgent || '').toLowerCase();
            const parameters = action.parameters || {};
            if (actionName.includes('generative') || actionName.includes('ai')) {
                return ['trainedAlgorithmicMedia', 'Generative AI'];
            }
            if (aiTools.some(t => softwareAgent.includes(t))) {
                return ['trainedAlgorithmicMedia', 'Generative AI'];
            }
            for (const [key, value] of Object.entries(parameters)) {
                const keyLower = (key || '').toLowerCase();
                const valueLower = String(value || '').toLowerCase();
                if (['firefly', 'generative', 'ai', 'text_to_image'].some(kw => keyLower.includes(kw))) {
                    return ['trainedAlgorithmicMedia', 'Generative AI'];
                }
                if (['text_to_image', 'generative', 'firefly'].some(kw => valueLower.includes(kw))) {
                    return ['trainedAlgorithmicMedia', 'Generative AI'];
                }
            }
        }
        return null;
    };

    for (const assertion of c2paData.assertions || []) {
        const label = assertion.label || '';
        const data = assertion.data || {};
        const labelLower = label.toLowerCase();
        if (labelLower.includes('iptc') || labelLower.includes('photo-metadata')) {
            const st = data.digitalSourceType;
            if (st) return [st, DIGITAL_SOURCE_TYPE_LABELS[st] || st];
        }
        if (label.includes('CreativeWork')) {
            const st = data.digitalSourceType;
            if (st) return [st, DIGITAL_SOURCE_TYPE_LABELS[st] || st];
        }
        if (labelLower.includes('actions')) {
            const hit = scanActions(data.actions);
            if (hit) return hit;
        }
    }

    const legacyHit = scanActions(c2paData.actions);
    if (legacyHit) return legacyHit;

    const ingredients = c2paData.ingredients || [];
    for (const ingredient of ingredients) {
        const fmt = (ingredient.format || '').toLowerCase();
        const title = (ingredient.title || '').toLowerCase();
        if (fmt.includes('dng') || fmt.includes('raw') || title.endsWith('.dng') || title.endsWith('.raw')) {
            return ['digitalCapture', 'Digital Camera (RAW)'];
        }
        if (fmt.includes('jpeg') || fmt.includes('jpg') || fmt.includes('tiff')) {
            return ['digitalCapture', 'Digital Camera'];
        }
    }

    if ((c2paData.actions && c2paData.actions.length) || (c2paData.ingredients && c2paData.ingredients.length)) {
        return ['digitalCapture', 'Digital Camera'];
    }
    return [null, null];
}

// Port of extract_c2pa_data / extract_c2pa_minimal (one pass covers both).
async function extractC2paData(bytes, mime) {
    try {
        const ctx = await readManifestStore(bytes, mime);
        if (!ctx) return null;
        const { reader, store } = ctx;
        const manifest = activeManifest(store);
        if (!manifest) return null;

        const result = {
            basic_info: {
                title: manifest.title ?? null,
                format: manifest.format ?? null,
                instance_id: manifest.instance_id ?? null,
                claim_generator: manifest.claim_generator ?? null,
            },
            signature_info: manifest.signature_info || {},
            assertions: [],
            ingredients: [],
            actions: [],
            author_info: {},
            digital_source_type: null,
        };

        for (const assertion of manifest.assertions || []) {
            const label = assertion.label || 'Unknown';
            const assertionData = assertion.data || {};
            result.assertions.push({ label, data: assertionData });

            if (label === 'c2pa.actions.v2') {
                for (const action of assertionData.actions || []) {
                    result.actions.push({
                        action: action.action ?? null,
                        when: action.when ?? null,
                        softwareAgent: action.softwareAgent ?? null,
                        parameters: action.parameters || {},
                    });
                }
            } else if (label === 'stds.schema-org.CreativeWork') {
                result.author_info = assertionData;
                result.author_info.social_links = extractSocialLinks(assertionData);
            }
        }

        for (const ingredient of manifest.ingredients || []) {
            result.ingredients.push({
                title: ingredient.title ?? null,
                format: ingredient.format ?? null,
                relationship: ingredient.relationship ?? null,
                instance_id: ingredient.instance_id ?? null,
            });
        }

        const [code, label2] = getDigitalSourceType(result);
        result.digital_source_type = { code, label: label2 };

        // Keep reader alive for thumbnail extraction via a non-enumerable hook.
        result._reader = reader;
        result._manifest = manifest;
        return result;
    } catch (e) {
        console.warn('C2PA extraction failed:', e);
        return null;
    }
}

function bytesToBase64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

async function extractThumbnails(c2paData) {
    const thumbnails = {};
    const reader = c2paData && c2paData._reader;
    const manifest = c2paData && c2paData._manifest;
    if (!reader || !manifest) return thumbnails;

    const claimThumb = manifest.thumbnail;
    if (claimThumb && typeof claimThumb === 'object' && claimThumb.identifier) {
        try {
            const bytes = await reader.resourceToBytes(claimThumb.identifier);
            thumbnails.claim_thumbnail = bytesToBase64(bytes);
        } catch (e) {
            console.warn('claim thumbnail failed:', e);
        }
    }

    const ingredients = manifest.ingredients || [];
    if (ingredients.length > 0) {
        const ingThumb = ingredients[0] && ingredients[0].thumbnail;
        if (ingThumb && typeof ingThumb === 'object' && ingThumb.identifier) {
            try {
                const bytes = await reader.resourceToBytes(ingThumb.identifier);
                thumbnails.ingredient_thumbnail = bytesToBase64(bytes);
            } catch (e) {
                console.warn('ingredient thumbnail failed:', e);
            }
        }
    }
    return thumbnails;
}

// ---------------------------------------------------------------------------
// Formatting helpers (ported from server.py)
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDateFields(y, mo, d, h, mi) {
    const h12 = h % 12 || 12;
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${MONTHS[mo]} ${pad2(d)}, ${y} at ${h12}:${pad2(mi)} ${ampm}`;
}

function tzName(date) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
            .formatToParts(date);
        const tz = parts.find(p => p.type === 'timeZoneName');
        return tz ? tz.value : '';
    } catch { return ''; }
}

function formatDatetimeFull(dtString, includeTimezone = false) {
    if (!dtString || dtString === 'Unknown') return 'Unknown';
    try {
        if (typeof dtString !== 'string') dtString = String(dtString);

        // ISO 8601 (contains 'T')
        if (dtString.includes('T')) {
            const m = dtString.match(/(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
            if (!m) return dtString;
            const [, y, mo, d, h, mi] = m;
            if (includeTimezone) {
                const dt = new Date(dtString.replace('Z', '+00:00'));
                if (isNaN(dt)) return dtString;
                const tz = tzName(dt);
                return formatDateFields(dt.getFullYear(), dt.getMonth(), dt.getDate(),
                    dt.getHours(), dt.getMinutes()) + (tz ? ` ${tz}` : '');
            }
            // Python strftime uses the datetime's own (source-tz) fields.
            return formatDateFields(+y, +mo - 1, +d, +h, +mi);
        }

        // EXIF format YYYY:MM:DD HH:MM:SS
        const em = dtString.match(/(\d{4}):(\d{1,2}):(\d{1,2}) (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
        if (em) {
            const [, y, mo, d, h, mi] = em;
            return formatDateFields(+y, +mo - 1, +d, +h, +mi);
        }
    } catch (e) {
        console.warn('datetime format failed:', e);
    }
    return dtString;
}

function formatClaimGenerator(generator) {
    if (!generator) return 'Unknown';
    if (generator.includes('/')) {
        const parts = generator.split('/');
        const software = parts[0].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const version = parts.length > 1 ? parts[1] : '';
        return version ? `${software} ${version}` : software;
    }
    return generator;
}

function convertExifValue(value) {
    if (value instanceof Date) {
        return `${value.getFullYear()}:${pad2(value.getMonth() + 1)}:${pad2(value.getDate())} ` +
            `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
    }
    if (Array.isArray(value)) return value.map(convertExifValue);
    return value;
}

async function extractExif(arrayBuffer, filename, format, fileSizeBytes) {
    const result = {
        filename,
        format,
        width: null,
        height: null,
        file_size_bytes: fileSizeBytes,
        file_size_mb: Math.round((fileSizeBytes / (1024 * 1024)) * 100) / 100,
        exif: {},
        gps: {},
        color_profile: null,
    };

    let parsed;
    try {
        parsed = await exifrParse(arrayBuffer, {
            // translateValues off for the EXIF IFD only: script.js looks up
            // ExposureMode/MeteringMode/Flash/WhiteBalance by numeric code,
            // while every other segment keeps translated values.
            exif: { translateValues: false },
            gps: true, ifd1: true, interop: true,
            makerNote: false, userComment: true, xmp: false,
            iptc: true, icc: true, jfif: false, ihdr: false,
            translateValues: true, reviveValues: true, sanitize: true,
        });
    } catch (e) {
        console.warn('EXIF parse failed:', e);
        return result;
    }
    if (!parsed) return result;

    for (const tag of EXIF_TAGS) {
        if (parsed[tag] !== undefined) {
            result.exif[EXIF_ALIASES[tag] || tag] = convertExifValue(parsed[tag]);
        }
    }

    // ICC profile description (e.g. "sRGB IEC61966-2.1") when embedded.
    if (parsed.ProfileDescription) {
        result.color_profile = String(parsed.ProfileDescription);
    }

    // GPS: exifr already yields decimal degrees with hemisphere applied.
    let lat = parsed.latitude;
    let lon = parsed.longitude;
    if (lat === undefined && Array.isArray(parsed.GPSLatitude) && parsed.GPSLatitude.length >= 3) {
        const dms = parsed.GPSLatitude;
        lat = dms[0] + dms[1] / 60 + dms[2] / 3600;
        if (parsed.GPSLatitudeRef === 'S') lat = -lat;
    }
    if (lon === undefined && Array.isArray(parsed.GPSLongitude) && parsed.GPSLongitude.length >= 3) {
        const dms = parsed.GPSLongitude;
        lon = dms[0] + dms[1] / 60 + dms[2] / 3600;
        if (parsed.GPSLongitudeRef === 'W') lon = -lon;
    }
    if (typeof lat === 'number' && typeof lon === 'number') {
        result.gps = { latitude: String(lat), longitude: String(lon) };
    }

    // Stash the raw parse so callers can pull IPTC fields without re-parsing.
    result._rawExif = parsed;
    return result;
}

function extractIptc(parsedExif) {
    const iptc = {};
    if (!parsedExif) return iptc;
    for (const [key, exifrName] of Object.entries(IPTC_MAP)) {
        let value = parsedExif[exifrName];
        if (value === undefined) continue;
        if (key === 'keywords' && Array.isArray(value)) {
            value = value.join(', ');
        } else if (Array.isArray(value)) {
            value = value[0];
        }
        if (value !== undefined && value !== null && value !== '') {
            iptc[key] = String(value);
        }
    }
    return iptc;
}

function formatPhotographyMetadata(exifData, iptcData) {
    if (!exifData) return {};
    const exif = exifData.exif || {};

    const fmt1 = (n) => {
        let s = n.toFixed(1);
        if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s;
    };

    let aperture = 'Unknown';
    const fNum = exif.FNumber;
    if (typeof fNum === 'number') {
        aperture = `f/${fmt1(fNum)}`;
    } else if (Array.isArray(fNum) && fNum.length >= 2 && typeof fNum[0] === 'number') {
        aperture = `f/${fmt1(fNum[0] / fNum[1])}`;
    }

    let shutterSpeed = 'Unknown';
    const expTime = exif.ExposureTime;
    if (typeof expTime === 'number') {
        if (expTime < 1) shutterSpeed = `1/${Math.trunc(1 / expTime)}s`;
        else shutterSpeed = `${expTime.toFixed(2)}s`;
    } else if (Array.isArray(expTime) && expTime.length >= 2) {
        if (expTime[0] === 1) shutterSpeed = `1/${expTime[1]}s`;
        else shutterSpeed = `${(expTime[0] / expTime[1]).toFixed(2)}s`;
    }

    let focalLength = 'Unknown';
    const fl = exif.FocalLength;
    const fmt2 = (n) => {
        let s = n.toFixed(2);
        if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s;
    };
    if (typeof fl === 'number') focalLength = `${fmt2(fl)}mm`;
    else if (Array.isArray(fl) && fl.length >= 2 && typeof fl[0] === 'number') {
        focalLength = `${fmt2(fl[0] / fl[1])}mm`;
    }

    let iso = exif.ISOSpeedRatings !== undefined ? exif.ISOSpeedRatings : 'Unknown';
    if (Array.isArray(iso)) iso = iso.length ? iso[0] : 'Unknown';
    if (typeof iso === 'number') iso = Math.trunc(iso);
    if (iso === 'Unknown') iso = 'Unknown';

    const csv = exif.ColorSpace;
    const colorSpace = csv === 1 ? 'sRGB' : csv === 65535 ? 'Uncalibrated' : 'Unknown';
    const colorProfile = exifData.color_profile || 'Unknown';

    return {
        camera_make: exif.Make !== undefined ? exif.Make : 'Unknown',
        camera_model: exif.Model !== undefined ? exif.Model : 'Unknown',
        lens_model: exif.LensModel !== undefined ? exif.LensModel : 'Unknown',
        aperture,
        shutter_speed: shutterSpeed,
        iso: iso === 'Unknown' ? 'Unknown' : String(iso),
        focal_length: focalLength,
        date_original: formatDatetimeFull(exif.DateTimeOriginal !== undefined ? exif.DateTimeOriginal : 'Unknown'),
        date_digitized: formatDatetimeFull(exif.DateTimeDigitized !== undefined ? exif.DateTimeDigitized : 'Unknown'),
        artist: exif.Artist !== undefined ? exif.Artist : 'Unknown',
        description: exif.ImageDescription
            || (iptcData && (iptcData.description || iptcData.title))
            || 'No description available',
        color_space: colorSpace,
        color_profile: colorProfile,
    };
}

function formatProvenanceForWeb(c2paData) {
    const provenance = [];
    if (!c2paData) return provenance;

    const basic = c2paData.basic_info || {};
    if (basic.claim_generator) {
        provenance.push({ name: 'Claim Generator', generator: formatClaimGenerator(basic.claim_generator) });
    }

    const sigInfo = c2paData.signature_info || {};
    if (sigInfo.issuer) {
        provenance.push({ name: 'Issued By', issuer: sigInfo.issuer });
    }

    if (sigInfo.time) {
        provenance.push({ name: 'Issued On', date: formatDatetimeFull(sigInfo.time, true) });

        const authorInfo = c2paData.author_info || {};
        if ('name' in authorInfo) provenance.push({ name: 'Title', title: authorInfo.name });
        if ('description' in authorInfo) provenance.push({ name: 'Description', data: authorInfo.description });
        if ('keywords' in authorInfo) {
            let keywords = authorInfo.keywords;
            if (Array.isArray(keywords)) keywords = keywords.join(', ');
            provenance.push({ name: 'Keywords', data: keywords });
        }

        if ('author' in authorInfo) {
            const authors = authorInfo.author;
            if (Array.isArray(authors) && authors.length > 0) {
                const author = authors[0] || {};
                const worksFor = author.worksFor;
                const authorData = {
                    name: author.name !== undefined ? author.name : 'Unknown',
                    identifier: author.identifier ?? null,
                    url: author.url ?? null,
                    sameAs: author.sameAs ?? [],
                    email: author.email ?? null,
                    telephone: author.telephone ?? null,
                    address: author.address ?? null,
                    jobTitle: author.jobTitle ?? null,
                    worksFor: worksFor && typeof worksFor === 'object' ? (worksFor.name ?? null) : (worksFor ?? null),
                    social_links: authorInfo.social_links || {},
                };
                provenance.push({ name: 'Author', author: authorData.name, author_details: authorData });
            }
        }

        if ('copyrightHolder' in authorInfo) {
            const holders = authorInfo.copyrightHolder;
            if (Array.isArray(holders) && holders.length > 0) {
                provenance.push({ name: 'Copyright', copyright: (holders[0] || {}).name || 'Unknown' });
            }
        }

        if ('publisher' in authorInfo) {
            const publisher = authorInfo.publisher;
            if (publisher && typeof publisher === 'object') {
                provenance.push({ name: 'Publisher', publisher: publisher.name || 'Unknown' });
            }
        }
    }

    for (const action of c2paData.actions || []) {
        const actionItem = {
            name: 'Action',
            action: action.action,
            software: action.softwareAgent ?? null,
            parameters: action.parameters || {},
        };
        if (action.when) actionItem.when = formatDatetimeFull(action.when, true);
        provenance.push(actionItem);
    }

    if (sigInfo && Object.keys(sigInfo).length) {
        provenance.push({ name: 'Verification', verification: 'Signature Valid' });
    }

    return provenance;
}

// ---------------------------------------------------------------------------
// Public API — same response shapes as the FastAPI endpoints
// ---------------------------------------------------------------------------

async function buildExifEntry(uri, bytes, contentType) {
    const displayName = displayNameForUri(uri);
    const format = detectFormat(bytes, contentType, uri);
    const mime = `image/${format === 'JPEG' ? 'jpeg' : format.toLowerCase()}`;

    const dims = await imageDimensions(bytes, mime);
    const exifData = await extractExif(bytes, displayName, format, bytes.byteLength);
    exifData.width = dims.width;
    exifData.height = dims.height;

    // IPTC lives in the same exifr parse — re-parse cheaply is wasteful, so
    // extractExif stashes the raw parse on the result.
    const iptcData = extractIptc(exifData._rawExif);

    const photography = formatPhotographyMetadata(exifData, iptcData);
    const gpsData = exifData.gps || {};
    const formattedGps = {};
    if (gpsData.latitude !== undefined && gpsData.longitude !== undefined) {
        formattedGps.latitude = gpsData.latitude;
        formattedGps.longitude = gpsData.longitude;
    }

    const entry = {
        filename: displayName,
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
    return { [displayName]: entry };
}

export async function exifMetadata(uri, timeoutMs = 30000) {
    const { bytes, contentType } = await fetchImageBytes(uri, timeoutMs);
    return buildExifEntry(uri, bytes, contentType);
}

export async function c2paMetadata(uri, timeoutMs = 30000) {
    const { bytes, contentType } = await fetchImageBytes(uri, timeoutMs);
    const format = detectFormat(bytes, contentType, uri);
    const mime = `image/${format === 'JPEG' ? 'jpeg' : format.toLowerCase()}`;

    const c2paData = await extractC2paData(bytes, mime);
    const provenance = formatProvenanceForWeb(c2paData);
    const thumbnails = c2paData ? await extractThumbnails(c2paData) : {};

    return {
        provenance,
        c2pa_data: c2paData ? stripInternals(c2paData) : null,
        author_info: c2paData ? c2paData.author_info : null,
        thumbnails,
        digital_source_type: c2paData ? c2paData.digital_source_type : null,
    };
}

function stripInternals(c2paData) {
    const { _reader, _manifest, ...rest } = c2paData;
    return rest;
}

export async function c2paMini(uri, timeoutMs = 15000) {
    const more = `${location.origin}${location.pathname.replace(/\/?$/, '/')}?uri=${encodeURIComponent(uri)}`;
    const unverified = {
        creator: null, issued_by: null, issued_on: null,
        status: 'Unverified', digital_source_type: null, more,
    };
    try {
        const { bytes, contentType } = await fetchImageBytes(uri, timeoutMs);
        const format = detectFormat(bytes, contentType, uri);
        const mime = `image/${format === 'JPEG' ? 'jpeg' : format.toLowerCase()}`;
        const c2paData = await extractC2paData(bytes, mime);
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
            status: 'Authenticity Verified',
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
    const mime = contentType || `image/${format === 'JPEG' ? 'jpeg' : format.toLowerCase()}`;

    const dims = await imageDimensions(bytes, mime);
    const exifData = await extractExif(bytes, displayName, format, bytes.byteLength);
    exifData.width = dims.width;
    exifData.height = dims.height;
    const iptcData = extractIptc(exifData._rawExif);

    const c2paData = await extractC2paData(bytes, mime);
    const thumbnails = c2paData ? await extractThumbnails(c2paData) : {};
    const provenance = formatProvenanceForWeb(c2paData);

    const gpsData = exifData.gps || {};
    const formattedGps = {};
    if (gpsData.latitude !== undefined && gpsData.longitude !== undefined) {
        formattedGps.latitude = gpsData.latitude;
        formattedGps.longitude = gpsData.longitude;
    }

    const entry = {
        filename: displayName,
        format: exifData.format,
        width: exifData.width,
        height: exifData.height,
        file_size_bytes: exifData.file_size_bytes,
        file_size_mb: exifData.file_size_mb,
        photography: formatPhotographyMetadata(exifData, iptcData),
        exif: exifData.exif,
        gps: formattedGps,
        iptc: iptcData,
        thumbnails,
        provenance,
        digital_source_type: c2paData ? c2paData.digital_source_type : null,
        author_info: c2paData ? c2paData.author_info : {},
        image_data: `data:image/${format === 'JPEG' ? 'jpeg' : format.toLowerCase()};base64,${bytesToBase64(bytes)}`,
    };

    return { [displayName]: entry };
}

// Expose for the classic script.js bundle (index.html loads this first).
if (typeof window !== 'undefined') {
    window.C2paApi = { exifMetadata, c2paMetadata, c2paMini, uploadMetadata };
}
