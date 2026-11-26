// Port of packages/core/src/analyze.js — the analyzeBytes orchestration.

use serde_json::{json, Map, Value};
use sha2::Digest;

use crate::c2pa_extract::{empty_c2pa_result, read_c2pa_asset};
use crate::detect::{detect_format, image_mime};
use crate::dimensions::header_dimensions;
use crate::exif::parse_exif;
use crate::photo::format_photography_metadata;
use crate::trust::Anchors;

// The EXIF_TAGS allowlist order — insertion order is contractual.
const EXIF_TAGS: [&str; 24] = [
    "Make", "Model", "XResolution", "YResolution", "Software", "ModifyDate",
    "Artist", "Copyright", "DateTimeOriginal", "CreateDate",
    "ImageDescription", "UserComment", "ApertureValue", "MeteringMode",
    "Flash", "FocalLength", "ColorSpace", "SensingMethod", "ExposureMode",
    "WhiteBalance", "ISO", "FNumber", "ExposureTime", "LensModel",
];

fn alias(tag: &str) -> &str {
    match tag {
        "ISO" => "ISOSpeedRatings",
        "CreateDate" => "DateTimeDigitized",
        "ModifyDate" => "DateTime",
        other => other,
    }
}

fn orientation_number(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => {
            let lower = s.to_lowercase();
            let mapped = match lower.as_str() {
                "horizontal (normal)" => Some(1),
                "mirror horizontal" => Some(2),
                "rotate 180" => Some(3),
                "mirror vertical" => Some(4),
                "mirror horizontal and rotate 270 cw" => Some(5),
                "rotate 90 cw" => Some(6),
                "mirror horizontal and rotate 90 cw" => Some(7),
                "rotate 270 cw" => Some(8),
                _ => None,
            };
            mapped.or_else(|| s.parse::<i64>().ok())
        }
        _ => None,
    }
}

pub struct AnalyzeArgs<'a> {
    pub bytes: &'a [u8],
    pub mime: &'a str,
    pub filename: &'a str,
    pub content_type: &'a str,
    pub anchors: &'a Anchors,
    pub trust_profile: &'a str,
}

/// buildExifEntry — EXIF/dimensions/IPTC/GPS extraction entry object.
pub fn build_exif_entry(bytes: &[u8], mime: &str, filename: &str, content_type: &str) -> Map<String, Value> {
    let format = detect_format(bytes, content_type, filename);
    let parsed = parse_exif(bytes, format);

    // Dimensions: header parse first, EXIF fallback second.
    let header_dims = header_dimensions(bytes);
    let pick = |keys: &[&str]| -> Option<f64> {
        for k in keys {
            if let Some(v) = parsed.tags.get(*k) {
                match v {
                    Value::Number(n) => {
                        if let Some(f) = n.as_f64() {
                            if f > 0.0 {
                                return Some(f);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        None
    };
    let (mut width, mut height) = match header_dims {
        Some((w, h)) => (Some(w as f64), Some(h as f64)),
        None => (
            pick(&["width", "imageWidth", "ImageWidth", "PixelXDimension", "ExifImageWidth"]),
            pick(&["height", "imageHeight", "ImageHeight", "PixelYDimension", "ExifImageHeight"]),
        ),
    };

    // Orientation transpose.
    let orientation = orientation_number(parsed.tags.get("Orientation"));
    if let Some(o) = orientation {
        if (5..=8).contains(&o) {
            std::mem::swap(&mut width, &mut height);
        }
    }

    // The exif allowlist in order, with output-key aliasing.
    let mut exif_map = Map::new();
    for tag in EXIF_TAGS {
        if let Some(v) = parsed.tags.get(tag) {
            exif_map.insert(alias(tag).to_string(), v.clone());
        }
    }

    // IPTC — first value for scalars, joined for keywords.
    let iptc_map_def: [(&str, &str); 7] = [
        ("title", "ObjectName"),
        ("description", "Caption"),
        ("keywords", "Keywords"),
        ("author", "Byline"),
        ("city", "City"),
        ("location", "Sublocation"),
        ("copyright", "CopyrightNotice"),
    ];
    let mut iptc_out = Map::new();
    for (key, raw_name) in iptc_map_def {
        if let Some(values) = parsed.iptc.get(raw_name) {
            if values.is_empty() {
                continue;
            }
            let v = if key == "keywords" {
                values.join(", ")
            } else {
                values[0].clone()
            };
            if !v.is_empty() {
                iptc_out.insert(key.to_string(), json!(v));
            }
        }
    }

    // GPS — decimal degrees as JS number strings.
    let mut gps = Map::new();
    if let (Some(lat), Some(lon)) = (parsed.gps_latitude, parsed.gps_longitude) {
        gps.insert("latitude".into(), json!(js_number_string(lat)));
        gps.insert("longitude".into(), json!(js_number_string(lon)));
    }

    let file_size_mb = ((bytes.len() as f64 / (1024.0 * 1024.0)) * 100.0).round() / 100.0;

    // photography formatting borrows the exif map + color profile — the
    // entry-shaped probe map used to clone the entire exif map for nothing.
    let color_profile_value = parsed.icc_description.clone().map(|s| json!(s)).unwrap_or(Value::Null);
    let photography = format_photography_metadata(&exif_map, &color_profile_value, &iptc_out);

    let _ = mime;
    let mut entry = Map::new();
    entry.insert("filename".into(), json!(filename));
    entry.insert("format".into(), json!(format));
    entry.insert("width".into(), width.map(jsnum).unwrap_or(Value::Null));
    entry.insert("height".into(), height.map(jsnum).unwrap_or(Value::Null));
    entry.insert("file_size_bytes".into(), json!(bytes.len() as u64));
    entry.insert("file_size_mb".into(), jsnum(file_size_mb));
    entry.insert("photography".into(), Value::Object(photography));
    entry.insert("exif".into(), Value::Object(exif_map));
    entry.insert("gps".into(), Value::Object(gps));
    entry.insert("iptc".into(), Value::Object(iptc_out));
    entry
}


// JSON value for a JS number: integral f64s serialize as integers, matching
// JSON.stringify semantics (JS has no int/float distinction).
pub fn jsnum(f: f64) -> Value {
    if f == f.trunc() && f.abs() < 9.0e15 {
        return json!(f as i64);
    }
    json!(f)
}

// JS String(number) — shortest round-trip decimal; integers drop the dot.
// ECMAScript switches to exponent notation below 1e-6 and at 1e21; Rust's
// Display never does, so very small coordinates (a metre-scale GPS rounding
// near the equator) would diverge from the reference output without this.
pub fn js_number_string(f: f64) -> String {
    if f == f.trunc() && f.abs() < 1e15 {
        return format!("{}", f as i64);
    }
    let a = f.abs();
    if a != 0.0 && (a < 1e-6 || a >= 1e21) {
        // Rust {:e} already produces JS-shaped exponents: no plus sign, no
        // zero padding — "1e-7", "-2.5e-8".
        return format!("{:e}", f);
    }
    format!("{}", f)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// analyzeBytes — strict=true (container semantics: failures propagate).
pub async fn analyze(args: &AnalyzeArgs<'_>) -> Result<Value, String> {
    let bytes = args.bytes;

    let asset = json!({
        "sha256": sha256_hex(bytes),
        "mime": if args.mime.is_empty() { Value::Null } else { json!(args.mime) },
        "bytes": bytes.len() as u64,
    });

    let exif_entry = build_exif_entry(bytes, args.mime, args.filename, args.content_type);

    let outcome = read_c2pa_asset(bytes, args.mime, args.anchors, args.trust_profile).await?;

    let manifest = match outcome.manifest_label {
        Some(label) => json!({"label": label}),
        None => Value::Null,
    };

    let image_mime_hint = image_mime(detect_format(bytes, args.content_type, args.filename));
    let _ = image_mime_hint;

    Ok(json!({
        "exif": Value::Object(exif_entry),
        "c2pa": outcome.result,
        "validation": outcome.validation.unwrap_or(Value::Null),
        "asset": asset,
        "manifest": manifest,
    }))
}

pub fn empty_c2pa() -> Value {
    empty_c2pa_result()
}
