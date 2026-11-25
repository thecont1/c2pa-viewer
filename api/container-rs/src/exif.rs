// Port of packages/core/src/exif.js + the exifr behaviors it depends on.
//
// exifr parses JPEG APP1/EXIF (TIFF structure), Photoshop APP13 (IPTC IIM)
// and APP2 (ICC profile). Its options in this pipeline:
//   exif: { translateValues: false } — enum tags in the EXIF IFD stay numeric
//   translateValues: true everywhere else — IFD0 Orientation becomes a string
//   reviveValues: true — rationals become floats, EXIF dates become Date,
//     and convertExifValue then renders those Dates back to EXIF-format
//     strings (TZ round-trip is identity in a UTC container)
//
// Only the EXIF_TAGS allowlist (+ Orientation, GPS, width/height fallback
// keys, IPTC_MAP fields, ICC ProfileDescription) is surfaced, so this parser
// targets exactly that surface rather than the whole TIFF spec.

use serde_json::{json, Value};
use std::collections::BTreeMap;

pub struct ParsedExif {
    /// Tag name -> revived JSON value, keyed with exifr's output names
    /// (ISO, CreateDate, ModifyDate canonical forms — before aliasing).
    pub tags: BTreeMap<String, Value>,
    pub iptc: BTreeMap<String, Vec<String>>,
    pub icc_description: Option<String>,
    pub gps_latitude: Option<f64>,
    pub gps_longitude: Option<f64>,
}

// ---------------------------------------------------------------- TIFF -----

struct TiffParser<'a> {
    data: &'a [u8],
    little: bool,
}

impl<'a> TiffParser<'a> {
    fn u16(&self, off: usize) -> u32 {
        if off + 2 > self.data.len() {
            return 0;
        }
        if self.little {
            u16::from_le_bytes([self.data[off], self.data[off + 1]]) as u32
        } else {
            u16::from_be_bytes([self.data[off], self.data[off + 1]]) as u32
        }
    }
    fn u32(&self, off: usize) -> u32 {
        if off + 4 > self.data.len() {
            return 0;
        }
        if self.little {
            u32::from_le_bytes([self.data[off], self.data[off + 1], self.data[off + 2], self.data[off + 3]])
        } else {
            u32::from_be_bytes([self.data[off], self.data[off + 1], self.data[off + 2], self.data[off + 3]])
        }
    }

    fn type_size(t: u32) -> usize {
        match t {
            1 | 2 | 6 | 7 => 1,
            3 | 8 => 2,
            4 | 9 | 11 => 4,
            5 | 10 | 12 => 8,
            _ => 1,
        }
    }

    /// Read one IFD entry value as a revived JSON value.
    fn entry_value(&self, ttype: u32, count: u32, value_off: usize) -> Option<Value> {
        let unit = Self::type_size(ttype);
        let total = unit * count as usize;
        // Value bytes: inline (<=4) or at the pointed offset.
        let base = if total <= 4 {
            value_off
        } else {
            self.u32(value_off) as usize
        };
        if base + total > self.data.len() {
            return None;
        }
        let vals: Vec<Value> = (0..count as usize)
            .map(|i| {
                let o = base + i * unit;
                match ttype {
                    // BYTE / SBYTE
                    1 => Value::from(self.data[o] as u64),
                    6 => Value::from(self.data[o] as i8 as i64),
                    // SHORT / SSHORT
                    3 => Value::from(self.u16(o) as u64),
                    8 => {
                        let v = self.u16(o) as i16;
                        Value::from(v as i64)
                    }
                    // LONG / SLONG
                    4 => Value::from(self.u32(o) as u64),
                    9 => Value::from(self.u32(o) as i32 as i64),
                    // RATIONAL / SRATIONAL — revived to float
                    5 | 10 => {
                        let (num, den) = if ttype == 5 {
                            (self.u32(o) as f64, self.u32(o + 4) as f64)
                        } else {
                            (self.u32(o) as i32 as f64, self.u32(o + 4) as i32 as f64)
                        };
                        if den == 0.0 {
                            Value::Null
                        } else {
                            json!(num / den)
                        }
                    }
                    // FLOAT / DOUBLE
                    11 => {
                        let bits = self.u32(o);
                        json!(f32::from_bits(bits) as f64)
                    }
                    12 => {
                        let mut b = [0u8; 8];
                        b.copy_from_slice(&self.data[o..o + 8]);
                        let v = if self.little {
                            f64::from_le_bytes(b)
                        } else {
                            f64::from_be_bytes(b)
                        };
                        json!(v)
                    }
                    _ => Value::Null,
                }
            })
            .collect();
        match ttype {
            2 => {
                // ASCII — joined with NUL separators stripped per string
                let raw = &self.data[base..base + total];
                let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
                let s = raw[..end].iter().map(|&c| if c == 0 { '\0' } else { c as char }).collect::<String>();
                Some(Value::String(s))
            }
            7 => {
                // UNDEFINED — exifr returns a Uint8Array; for UserComment the
                // caller handles decoding. Return bytes as array of numbers.
                let raw = &self.data[base..base + total];
                Some(Value::Array(raw.iter().map(|&b| Value::from(b as u64)).collect()))
            }
            _ => {
                if count == 1 {
                    vals.into_iter().next()
                } else {
                    Some(Value::Array(vals))
                }
            }
        }
    }

    /// Iterate entries of the IFD at `ifd_off`; calls back (tag, type, count, value_offset).
    fn scan_ifd<F: FnMut(u32, u32, u32, usize)>(&self, ifd_off: usize, mut f: F) -> Option<usize> {
        if ifd_off + 2 > self.data.len() {
            return None;
        }
        let count = self.u16(ifd_off) as usize;
        for i in 0..count {
            let e = ifd_off + 2 + i * 12;
            if e + 12 > self.data.len() {
                break;
            }
            let tag = self.u16(e);
            let ttype = self.u16(e + 2);
            let cnt = self.u32(e + 4);
            f(tag, ttype, cnt, e + 8);
        }
        let next_off_pos = ifd_off + 2 + count * 12;
        if next_off_pos + 4 <= self.data.len() {
            Some(self.u32(next_off_pos) as usize)
        } else {
            None
        }
    }
}

// Orientation translation (IFD0 is in the translated segment).
fn orientation_string(n: u64) -> Option<&'static str> {
    match n {
        1 => Some("Horizontal (normal)"),
        2 => Some("Mirror horizontal"),
        3 => Some("Rotate 180"),
        4 => Some("Mirror vertical"),
        5 => Some("Mirror horizontal and rotate 270 CW"),
        6 => Some("Rotate 90 CW"),
        7 => Some("Mirror horizontal and rotate 90 CW"),
        8 => Some("Rotate 270 CW"),
        _ => None,
    }
}

const EXIF_IFD_POINTER: u32 = 0x8769;
const GPS_IFD_POINTER: u32 = 0x8825;

struct RawTag {
    ttype: u32,
    count: u32,
    value_off: usize,
}

fn collect_ifd(p: &TiffParser, off: usize, out: &mut BTreeMap<u32, RawTag>) {
    let mut entries: Vec<(u32, u32, u32, usize)> = Vec::new();
    p.scan_ifd(off, |tag, ttype, cnt, voff| entries.push((tag, ttype, cnt, voff)));
    for (tag, ttype, cnt, voff) in entries {
        out.insert(tag, RawTag { ttype, count: cnt, value_off: voff });
    }
}

/// Parse TIFF data (already located — starts at the II/MM bom).
fn parse_tiff(data: &[u8], parsed: &mut ParsedExif) {
    if data.len() < 8 {
        return;
    }
    let little = match &data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return,
    };
    let p = TiffParser { data, little };
    let ifd0_off = p.u32(4) as usize;
    let mut ifd0: BTreeMap<u32, RawTag> = BTreeMap::new();
    collect_ifd(&p, ifd0_off, &mut ifd0);

    let mut exif_ifd: BTreeMap<u32, RawTag> = BTreeMap::new();
    if let Some(ptr) = ifd0.get(&EXIF_IFD_POINTER) {
        if let Some(Value::Number(n)) = p.entry_value(ptr.ttype, ptr.count, ptr.value_off) {
            if let Some(off) = n.as_u64() {
                collect_ifd(&p, off as usize, &mut exif_ifd);
            }
        }
    }
    let mut gps_ifd: BTreeMap<u32, RawTag> = BTreeMap::new();
    if let Some(ptr) = ifd0.get(&GPS_IFD_POINTER) {
        if let Some(Value::Number(n)) = p.entry_value(ptr.ttype, ptr.count, ptr.value_off) {
            if let Some(off) = n.as_u64() {
                collect_ifd(&p, off as usize, &mut gps_ifd);
            }
        }
    }

    // --- IFD0 tags (translated values apply here) ---
    let str_tag = |map: &BTreeMap<u32, RawTag>, tag: u32| -> Option<Value> {
        let t = map.get(&tag)?;
        p.entry_value(t.ttype, t.count, t.value_off)
    };

    let put = |parsed: &mut ParsedExif, name: &str, v: Option<Value>| {
        if let Some(v) = v {
            if !v.is_null() {
                parsed.tags.insert(name.to_string(), v);
            }
        }
    };

    // numeric scalar helper
    let num_val = |v: &Value| -> Option<f64> {
        match v {
            Value::Number(n) => n.as_f64(),
            Value::Array(a) if !a.is_empty() => a[0].as_f64(),
            _ => None,
        }
    };

    // IFD0 direct mappings: (tag, exifr output name)
    for (tag, name) in [
        (0x010F, "Make"),
        (0x0110, "Model"),
        (0x011A, "XResolution"),
        (0x011B, "YResolution"),
        (0x0131, "Software"),
        (0x0132, "ModifyDate"),
        (0x013B, "Artist"),
        (0x8298, "Copyright"),
        (0x010E, "ImageDescription"),
        (0x0100, "ImageWidth"),
        (0x0101, "ImageHeight"),
    ] {
        put(parsed, name, str_tag(&ifd0, tag));
    }
    // Orientation — translated string, IFD0 lives in the translated segment.
    if let Some(v) = str_tag(&ifd0, 0x0112) {
        if let Some(n) = num_val(&v) {
            if let Some(s) = orientation_string(n as u64) {
                parsed.tags.insert("Orientation".to_string(), Value::String(s.to_string()));
            }
        }
    }

    // --- EXIF IFD tags (untranslated numerics stay numeric) ---
    for (tag, name) in [
        (0x9003, "DateTimeOriginal"),
        (0x9004, "CreateDate"),
        (0x9202, "ApertureValue"),
        (0x9207, "MeteringMode"),
        (0x9209, "Flash"),
        (0x920A, "FocalLength"),
        (0xA001, "ColorSpace"),
        (0xA217, "SensingMethod"),
        (0xA402, "ExposureMode"),
        (0xA403, "WhiteBalance"),
        (0x8827, "ISO"),
        (0x829D, "FNumber"),
        (0x829A, "ExposureTime"),
        (0xA434, "LensModel"),
        (0xA002, "PixelXDimension"),
        (0xA003, "PixelYDimension"),
    ] {
        put(parsed, name, str_tag(&exif_ifd, tag));
    }

    // UserComment (0x9286): 8-byte charset prefix then text; exifr decodes
    // ASCII/Unicode — the common case is ASCII after b"ASCII\0\0\0".
    if let Some(t) = exif_ifd.get(&0x9286) {
        if let Some(Value::Array(bytes)) = p.entry_value(t.ttype, t.count, t.value_off) {
            let raw: Vec<u8> = bytes.iter().filter_map(|v| v.as_u64().map(|n| n as u8)).collect();
            if raw.len() > 8 {
                let body = &raw[8..];
                let text = if raw.starts_with(b"ASCII") {
                    body.iter().take_while(|&&c| c != 0).map(|&c| c as char).collect::<String>()
                } else if raw.starts_with(b"UNICODE") {
                    // UCS-2 big-endian per the EXIF spec
                    body.chunks_exact(2)
                        .map(|c| u16::from_be_bytes([c[0], c[1]]))
                        .take_while(|&c| c != 0)
                        .map(|c| char::from_u32(c as u32).unwrap_or('\u{fffd}'))
                        .collect::<String>()
                } else {
                    String::new()
                };
                let trimmed = text.trim().to_string();
                if !trimmed.is_empty() {
                    parsed.tags.insert("UserComment".to_string(), Value::String(trimmed));
                }
            }
        }
    }

    // --- GPS ---
    let gps_num = |tag: u32| -> Option<f64> {
        let t = gps_ifd.get(&tag)?;
        num_val(&p.entry_value(t.ttype, t.count, t.value_off)?)
    };
    let gps_arr = |tag: u32| -> Option<Vec<f64>> {
        let t = gps_ifd.get(&tag)?;
        match p.entry_value(t.ttype, t.count, t.value_off)? {
            Value::Array(a) => Some(a.iter().filter_map(|v| v.as_f64()).collect()),
            Value::Number(n) => Some(vec![n.as_f64()?]),
            _ => None,
        }
    };
    let gps_str = |tag: u32| -> Option<String> {
        let t = gps_ifd.get(&tag)?;
        p.entry_value(t.ttype, t.count, t.value_off)?.as_str().map(|s| s.to_string())
    };
    if let (Some(dms), Some(r)) = (gps_arr(0x0002), gps_str(0x0001)) {
        if dms.len() >= 3 {
            let mut lat = dms[0] + dms[1] / 60.0 + dms[2] / 3600.0;
            if r == "S" {
                lat = -lat;
            }
            parsed.gps_latitude = Some(lat);
        }
    }
    if let (Some(dms), Some(r)) = (gps_arr(0x0004), gps_str(0x0003)) {
        if dms.len() >= 3 {
            let mut lon = dms[0] + dms[1] / 60.0 + dms[2] / 3600.0;
            if r == "W" {
                lon = -lon;
            }
            parsed.gps_longitude = Some(lon);
        }
    }
    let _ = gps_num;
}

// ------------------------------------------------------------- JPEG --------

/// Walk JPEG APP markers; return (exif_tiff, iptc_datasets, icc_desc).
fn parse_jpeg_segments(bytes: &[u8], parsed: &mut ParsedExif) {
    let mut i = 2usize;
    let mut icc_parts: Vec<Vec<u8>> = Vec::new();
    while i + 4 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        let len = ((bytes[i + 2] as usize) << 8) | bytes[i + 3] as usize;
        let seg_start = i + 4;
        let seg_end = (seg_start + len.saturating_sub(2)).min(bytes.len());
        let seg = &bytes[seg_start..seg_end];

        if marker == 0xE1 && seg.len() > 6 && &seg[0..6] == b"Exif\0\0" {
            parse_tiff(&seg[6..], parsed);
        }
        if marker == 0xED {
            parse_photoshop_irb(seg, parsed);
        }
        if marker == 0xE2 && seg.len() > 14 && &seg[0..12] == b"ICC_PROFILE\0" {
            icc_parts.push(seg[14..].to_vec());
        }
        i = seg_start + len.max(2) - 2;
        if len < 2 {
            break;
        }
    }
    if !icc_parts.is_empty() {
        let mut full = Vec::new();
        for part in icc_parts {
            full.extend_from_slice(&part);
        }
        parsed.icc_description = icc_profile_description(&full);
    }
}

// ------------------------------------------------- Photoshop IRB / IPTC ----

fn parse_photoshop_irb(seg: &[u8], parsed: &mut ParsedExif) {
    let mut i = 0usize;
    while i + 12 <= seg.len() {
        if &seg[i..i + 4] != b"8BIM" {
            i += 1;
            continue;
        }
        let resource_id = u16::from_be_bytes([seg[i + 4], seg[i + 5]]);
        // Pascal-string name: len byte then bytes, padded to even.
        let name_len = seg[i + 6] as usize;
        let name_total = 1 + name_len + if (1 + name_len) % 2 == 1 { 1 } else { 0 };
        let data_len_off = i + 6 + name_total;
        if data_len_off + 4 > seg.len() {
            break;
        }
        let data_len = u32::from_be_bytes([
            seg[data_len_off], seg[data_len_off + 1], seg[data_len_off + 2], seg[data_len_off + 3],
        ]) as usize;
        let data_start = data_len_off + 4;
        if data_start + data_len > seg.len() {
            break;
        }
        if resource_id == 0x0404 {
            parse_iptc(&seg[data_start..data_start + data_len], parsed);
        }
        i = data_start + data_len + (data_len % 2);
    }
}

fn parse_iptc(data: &[u8], parsed: &mut ParsedExif) {
    let map: [(u8, &str); 7] = [
        (5, "ObjectName"),
        (120, "Caption"),
        (25, "Keywords"),
        (80, "Byline"),
        (90, "City"),
        (92, "Sublocation"),
        (116, "CopyrightNotice"),
    ];
    let mut i = 0usize;
    while i + 5 <= data.len() {
        if data[i] != 0x1C {
            i += 1;
            continue;
        }
        let record = data[i + 1];
        let dataset = data[i + 2];
        let len = u16::from_be_bytes([data[i + 3], data[i + 4]]) as usize;
        let start = i + 5;
        if start + len > data.len() {
            break;
        }
        let raw = &data[start..start + len];
        let text: String = raw.iter().map(|&c| c as char).collect();
        for (ds, name) in map {
            if record == 2 && dataset == ds && !text.trim().is_empty() {
                if name == "Keywords" {
                    parsed
                        .iptc
                        .entry(name.to_string())
                        .or_default()
                        .push(text.clone());
                } else {
                    parsed.iptc.entry(name.to_string()).or_insert_with(|| vec![text.clone()]);
                }
            }
        }
        i = start + len;
    }
}

// --------------------------------------------------------- ICC -------------

fn icc_profile_description(icc: &[u8]) -> Option<String> {
    // ICC header 128 bytes, then tag count (4 BE), then records of
    // sig(4) offset(4) size(4). 'desc' tag: type 'desc' = ASCII at +8,
    // type 'mluc' = first UTF-16BE record.
    if icc.len() < 132 {
        return None;
    }
    let count = u32::from_be_bytes([icc[128], icc[129], icc[130], icc[131]]) as usize;
    for i in 0..count {
        let rec = 132 + i * 12;
        if rec + 12 > icc.len() {
            break;
        }
        if &icc[rec..rec + 4] == b"desc" {
            let off = u32::from_be_bytes([icc[rec + 4], icc[rec + 5], icc[rec + 6], icc[rec + 7]]) as usize;
            let size = u32::from_be_bytes([icc[rec + 8], icc[rec + 9], icc[rec + 10], icc[rec + 11]]) as usize;
            if off + size > icc.len() || size < 12 {
                return None;
            }
            let body = &icc[off..off + size];
            if &body[0..4] == b"desc" {
                let len = u32::from_be_bytes([body[8], body[9], body[10], body[11]]) as usize;
                let start = 12;
                let end = (start + len).min(body.len());
                let s: String = body[start..end]
                    .iter()
                    .take_while(|&&c| c != 0)
                    .map(|&c| c as char)
                    .collect();
                if !s.is_empty() {
                    return Some(s);
                }
            } else if &body[0..4] == b"mluc" {
                if body.len() < 28 {
                    return None;
                }
                let first_off = u32::from_be_bytes([body[20], body[21], body[22], body[23]]) as usize;
                let first_len = u32::from_be_bytes([body[24], body[25], body[26], body[27]]) as usize;
                let s: String = body
                    .get(first_off..first_off + first_len)?
                    .chunks_exact(2)
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .take_while(|&c| c != 0)
                    .map(|c| char::from_u32(c as u32).unwrap_or('\u{fffd}'))
                    .collect();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------- entry ----------

pub fn parse_exif(bytes: &[u8], format: &str) -> ParsedExif {
    let mut parsed = ParsedExif {
        tags: BTreeMap::new(),
        iptc: BTreeMap::new(),
        icc_description: None,
        gps_latitude: None,
        gps_longitude: None,
    };
    if format == "JPEG" {
        parse_jpeg_segments(bytes, &mut parsed);
    } else if format == "TIFF" {
        parse_tiff(bytes, &mut parsed);
    }
    // PNG/WEBP/GIF EXIF: not present in the fixture corpus; exifr supports
    // some of these — tracked as a parity gap until a fixture requires it.
    parsed
}
