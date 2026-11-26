// Port of packages/core/src/dimensions.js — container header dimension parsing.

fn jpeg_dimensions(u8: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2usize; // skip SOI
    while i + 9 < u8.len() {
        if u8[i] != 0xFF {
            i += 1;
            continue;
        }
        while i < u8.len() && u8[i] == 0xFF {
            i += 1;
        }
        if i >= u8.len() {
            break;
        }
        let marker = u8[i];
        i += 1;
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        if i + 2 > u8.len() {
            break;
        }
        let len = ((u8[i] as usize) << 8) | u8[i + 1] as usize;
        let sof = (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
        if sof {
            if i + 7 > u8.len() {
                break;
            }
            let height = ((u8[i + 3] as u32) << 8) | u8[i + 4] as u32;
            let width = ((u8[i + 5] as u32) << 8) | u8[i + 6] as u32;
            return Some((width, height));
        }
        i += len;
    }
    None
}

fn png_dimensions(u8: &[u8]) -> Option<(u32, u32)> {
    if u8.len() < 24 {
        return None;
    }
    if u8[12] != 0x49 || u8[13] != 0x48 || u8[14] != 0x44 || u8[15] != 0x52 {
        return None;
    }
    let width = u32::from_be_bytes([u8[16], u8[17], u8[18], u8[19]]);
    let height = u32::from_be_bytes([u8[20], u8[21], u8[22], u8[23]]);
    Some((width, height))
}

fn gif_dimensions(u8: &[u8]) -> Option<(u32, u32)> {
    if u8.len() < 10 {
        return None;
    }
    let width = u16::from_le_bytes([u8[6], u8[7]]) as u32;
    let height = u16::from_le_bytes([u8[8], u8[9]]) as u32;
    Some((width, height))
}

fn webp_dimensions(u8: &[u8]) -> Option<(u32, u32)> {
    if u8.len() < 30 {
        return None;
    }
    let fourcc = &u8[12..16];
    if fourcc == b"VP8X" {
        let w = 1 + (u8[24] as u32 | ((u8[25] as u32) << 8) | ((u8[26] as u32) << 16));
        let h = 1 + (u8[27] as u32 | ((u8[28] as u32) << 8) | ((u8[29] as u32) << 16));
        return Some((w, h));
    }
    if fourcc == b"VP8 " {
        if u8[23] != 0x9D || u8[24] != 0x01 || u8[25] != 0x2A {
            return None;
        }
        let w = ((u8[26] as u32 | ((u8[27] as u32) << 8)) & 0x3FFF) as u32;
        let h = ((u8[28] as u32 | ((u8[29] as u32) << 8)) & 0x3FFF) as u32;
        return Some((w, h));
    }
    if fourcc == b"VP8L" {
        if u8[20] != 0x2F {
            return None;
        }
        let (b0, b1, b2, b3) = (u8[21] as u32, u8[22] as u32, u8[23] as u32, u8[24] as u32);
        let w = 1 + (((b1 & 0x3F) << 8) | b0);
        let h = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
        return Some((w, h));
    }
    None
}

/// Header-parse dimensions for JPEG/PNG/GIF/WEBP. The exifr fallback path of
/// the JS original is handled by the caller (which already parses EXIF).
pub fn header_dimensions(u8: &[u8]) -> Option<(u32, u32)> {
    let b = |i: usize| u8.get(i).copied().unwrap_or(0);
    if b(0) == 0xFF && b(1) == 0xD8 {
        jpeg_dimensions(u8)
    } else if b(0) == 0x89 && b(1) == 0x50 {
        png_dimensions(u8)
    } else if b(0) == 0x47 && b(1) == 0x49 && b(2) == 0x46 {
        gif_dimensions(u8)
    } else if b(0) == 0x52 && b(1) == 0x49 && b(8) == 0x57 && b(9) == 0x45 {
        webp_dimensions(u8)
    } else {
        None
    }
}
