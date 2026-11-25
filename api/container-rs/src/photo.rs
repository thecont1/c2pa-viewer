// Port of packages/core/src/photo.js — photography metadata formatting.

use serde_json::{json, Map, Value};

use crate::format::format_datetime_full;

// JS n.toFixed(1) then strip trailing zeros and a dangling dot.
fn fmt1(n: f64) -> String {
    let s = format!("{:.1}", n);
    strip_zeros(s)
}

fn fmt2(n: f64) -> String {
    let s = format!("{:.2}", n);
    strip_zeros(s)
}

fn strip_zeros(s: String) -> String {
    if s.contains('.') {
        let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
        return s;
    }
    s
}

fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn as_pair(v: &Value) -> Option<(f64, f64)> {
    if let Value::Array(a) = v {
        if a.len() >= 2 {
            if let (Some(x), Some(y)) = (a[0].as_f64(), a[1].as_f64()) {
                return Some((x, y));
            }
        }
    }
    None
}

fn str_or_unknown(v: Option<&Value>) -> Value {
    match v {
        Some(Value::String(s)) => Value::String(s.clone()),
        Some(other) if !other.is_null() => other.clone(),
        _ => Value::String("Unknown".to_string()),
    }
}

pub fn format_photography_metadata(exif_entry: &Map<String, Value>, iptc: &Map<String, Value>) -> Map<String, Value> {
    let empty = Map::new();
    let exif = exif_entry
        .get("exif")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty);

    let mut out = Map::new();

    // aperture
    let aperture = match exif.get("FNumber") {
        Some(v) if as_f64(v).is_some() => format!("f/{}", fmt1(as_f64(v).unwrap())),
        Some(v) if as_pair(v).is_some() => {
            let (a, b) = as_pair(v).unwrap();
            format!("f/{}", fmt1(a / b))
        }
        _ => "Unknown".to_string(),
    };

    // shutter speed
    let shutter = match exif.get("ExposureTime") {
        Some(v) if as_f64(v).is_some() => {
            let t = as_f64(v).unwrap();
            if t < 1.0 {
                format!("1/{}s", (1.0 / t).trunc())
            } else {
                format!("{:.2}s", t)
            }
        }
        Some(v) if as_pair(v).is_some() => {
            let (a, b) = as_pair(v).unwrap();
            if a == 1.0 {
                format!("1/{}s", b)
            } else {
                format!("{:.2}s", a / b)
            }
        }
        _ => "Unknown".to_string(),
    };

    // focal length
    let focal = match exif.get("FocalLength") {
        Some(v) if as_f64(v).is_some() => format!("{}mm", fmt2(as_f64(v).unwrap())),
        Some(v) if as_pair(v).is_some() => {
            let (a, b) = as_pair(v).unwrap();
            format!("{}mm", fmt2(a / b))
        }
        _ => "Unknown".to_string(),
    };

    // iso
    let iso_raw = exif.get("ISOSpeedRatings").cloned().unwrap_or(Value::String("Unknown".into()));
    let iso = match iso_raw {
        Value::Array(a) => a.first().cloned().unwrap_or(Value::String("Unknown".into())),
        v => v,
    };
    let iso = match iso {
        Value::Number(n) => n.as_f64().map(|f| (f.trunc() as i64).to_string()).unwrap_or_else(|| "Unknown".into()),
        Value::String(s) => s,
        _ => "Unknown".into(),
    };

    let color_space = match exif.get("ColorSpace") {
        Some(Value::Number(n)) => match n.as_u64() {
            Some(1) => "sRGB",
            Some(65535) => "Uncalibrated",
            _ => "Unknown",
        },
        _ => "Unknown",
    };

    let color_profile = exif_entry
        .get("color_profile")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();

    let date_str = |key: &str| -> String {
        match exif.get(key) {
            Some(Value::String(s)) => format_datetime_full(s, false),
            Some(other) => format_datetime_full(&other.to_string().trim_matches('"').to_string(), false),
            None => "Unknown".to_string(),
        }
    };

    let description = {
        let image_desc = exif.get("ImageDescription").and_then(|v| v.as_str()).unwrap_or("");
        if !image_desc.is_empty() {
            image_desc.to_string()
        } else {
            let iptc_desc = iptc.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let iptc_title = iptc.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if !iptc_desc.is_empty() {
                iptc_desc.to_string()
            } else if !iptc_title.is_empty() {
                iptc_title.to_string()
            } else {
                "No description available".to_string()
            }
        }
    };

    out.insert("camera_make".into(), str_or_unknown(exif.get("Make")));
    out.insert("camera_model".into(), str_or_unknown(exif.get("Model")));
    out.insert("lens_model".into(), str_or_unknown(exif.get("LensModel")));
    out.insert("aperture".into(), json!(aperture));
    out.insert("shutter_speed".into(), json!(shutter));
    out.insert("iso".into(), json!(iso));
    out.insert("focal_length".into(), json!(focal));
    out.insert("date_original".into(), json!(date_str("DateTimeOriginal")));
    out.insert("date_digitized".into(), json!(date_str("DateTimeDigitized")));
    out.insert("artist".into(), str_or_unknown(exif.get("Artist")));
    out.insert("description".into(), json!(description));
    out.insert("color_space".into(), json!(color_space));
    out.insert("color_profile".into(), json!(color_profile));
    out
}
