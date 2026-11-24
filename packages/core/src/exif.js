// EXIF/IPTC extraction via exifr (works on ArrayBuffer in browsers,
// workerd and Node). Ported verbatim from src/compute.js.

import { parse as exifrParse } from 'exifr';

// exifr's output names differ from the EXIF tag names server.py used;
// EXIF_ALIASES maps them back so response shapes stay identical.
export const EXIF_TAGS = [
    'Make', 'Model', 'XResolution', 'YResolution', 'Software', 'ModifyDate',
    'Artist', 'Copyright', 'DateTimeOriginal', 'CreateDate',
    'ImageDescription', 'UserComment', 'ApertureValue', 'MeteringMode',
    'Flash', 'FocalLength', 'ColorSpace', 'SensingMethod', 'ExposureMode',
    'WhiteBalance', 'ISO', 'FNumber', 'ExposureTime', 'LensModel',
];

export const EXIF_ALIASES = {
    ISO: 'ISOSpeedRatings',
    CreateDate: 'DateTimeDigitized',
    ModifyDate: 'DateTime',
};

export const IPTC_MAP = {
    title: 'ObjectName',
    description: 'Caption',
    keywords: 'Keywords',
    author: 'Byline',
    city: 'City',
    location: 'Sublocation',
    copyright: 'CopyrightNotice',
};

function pad2(n) { return String(n).padStart(2, '0'); }

export function convertExifValue(value) {
    if (value instanceof Date) {
        return `${value.getFullYear()}:${pad2(value.getMonth() + 1)}:${pad2(value.getDate())} ` +
            `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
    }
    if (Array.isArray(value)) return value.map(convertExifValue);
    return value;
}

export async function extractExif(arrayBuffer, filename, format, fileSizeBytes) {
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

export function extractIptc(parsedExif) {
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
