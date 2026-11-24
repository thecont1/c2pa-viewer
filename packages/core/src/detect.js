// Format detection ported verbatim from src/compute.js (was server.py).

export function detectFormat(bytes, contentType, uri) {
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

// `image/jpeg`-style MIME for a detectFormat() result.
export function imageMime(format) {
    return `image/${format === 'JPEG' ? 'jpeg' : format.toLowerCase()}`;
}
