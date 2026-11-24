// Pure image-dimension reader: parses container headers directly so it works
// identically in browsers, workerd and Node — no createImageBitmap.
// Falls back to exifr's parsed width/height when headers don't yield dims.

import { parse as exifrParse } from 'exifr';

function jpegDimensions(u8) {
    // Walk JPEG segments until a Start-Of-Frame marker.
    let i = 2; // skip SOI (FFD8)
    while (i + 9 < u8.length) {
        if (u8[i] !== 0xFF) { i++; continue; }
        // skip fill bytes
        while (i < u8.length && u8[i] === 0xFF) i++;
        const marker = u8[i];
        i++;
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
        if (marker === 0xD9 || marker === 0xDA) break; // EOI / SOS
        if (i + 2 > u8.length) break;
        const len = (u8[i] << 8) | u8[i + 1];
        // SOF markers: C0-C3, C5-C7, C9-CB, CD-CF (exclude C4 DHT, C8 JPG, CC DAC)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            if (i + 7 > u8.length) break;
            const height = (u8[i + 3] << 8) | u8[i + 4];
            const width = (u8[i + 5] << 8) | u8[i + 6];
            return { width, height };
        }
        i += len;
    }
    return null;
}

function pngDimensions(u8) {
    // 8-byte signature then IHDR: len(4) 'IHDR' width(4BE) height(4BE)
    if (u8.length < 24) return null;
    if (u8[12] !== 0x49 || u8[13] !== 0x48 || u8[14] !== 0x44 || u8[15] !== 0x52) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

function gifDimensions(u8) {
    if (u8.length < 10) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
}

function webpDimensions(u8) {
    if (u8.length < 30) return null;
    // 'RIFF' .... 'WEBP' then chunk fourcc at offset 12
    const fourcc = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
    if (fourcc === 'VP8X') {
        // Canvas size minus one, 24-bit little-endian at offsets 24 and 27.
        const w = 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16));
        const h = 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16));
        return { width: w, height: h };
    }
    if (fourcc === 'VP8 ') {
        // Lossy bitstream: 3-byte frame tag, 3-byte start code, then
        // 14-bit little-endian width/height.
        if (u8[23] !== 0x9D || u8[24] !== 0x01 || u8[25] !== 0x2A) return null;
        const w = ((u8[26] | (u8[27] << 8)) & 0x3FFF);
        const h = ((u8[28] | (u8[29] << 8)) & 0x3FFF);
        return { width: w, height: h };
    }
    if (fourcc === 'VP8L') {
        // Lossless: signature byte 0x2f then 4 packed bytes.
        if (u8[20] !== 0x2F) return null;
        const b0 = u8[21], b1 = u8[22], b2 = u8[23], b3 = u8[24];
        const w = 1 + (((b1 & 0x3F) << 8) | b0);
        const h = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
        return { width: w, height: h };
    }
    return null;
}

const EXIF_DIM_KEYS_W = ['width', 'imageWidth', 'ImageWidth', 'PixelXDimension', 'ExifImageWidth'];
const EXIF_DIM_KEYS_H = ['height', 'imageHeight', 'ImageHeight', 'PixelYDimension', 'ExifImageHeight'];

function pickDim(parsed, keys) {
    if (!parsed) return null;
    for (const k of keys) {
        const v = parsed[k];
        if (typeof v === 'number' && v > 0) return v;
    }
    return null;
}

export async function bytesDimensions(bytes, mime) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let dims = null;
    try {
        if (u8[0] === 0xFF && u8[1] === 0xD8) dims = jpegDimensions(u8);
        else if (u8[0] === 0x89 && u8[1] === 0x50) dims = pngDimensions(u8);
        else if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) dims = gifDimensions(u8);
        else if (u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57 && u8[9] === 0x45) dims = webpDimensions(u8);
    } catch {
        dims = null;
    }
    if (dims && dims.width && dims.height) return dims;

    // Fallback: ask exifr (it understands many container formats).
    try {
        const ab = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
            ? u8.buffer
            : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        const parsed = await exifrParse(ab, {
            translateValues: true, reviveValues: true, sanitize: true,
        });
        const width = pickDim(parsed, EXIF_DIM_KEYS_W);
        const height = pickDim(parsed, EXIF_DIM_KEYS_H);
        if (width && height) return { width, height };
    } catch { }
    return { width: null, height: null };
}
