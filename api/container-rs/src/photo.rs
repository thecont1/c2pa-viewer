// Port of packages/core/src/photo.js — photography metadata formatting.

use serde_json::{json, Map, Value};

use crate::format::format_datetime_full;

// JS n.toFixed(1) then strip trailing zeros and a dangling dot.
// Rust's {:.N} rounds ties to even; ECMAScript toFixed rounds ties up —
// and since strictly-above-half rounds up too, the rule collapses to
// "round half away from zero". Exact decimal ties only occur for
// binary-exact values like 2.25, so round the exact decimal expansion as
// a string; scaling the input itself would introduce fresh rounding error.
fn round_fixed(n: f64, digits: usize) -> String {
    // 60 fractional digits fully expose any tie in the photographic range.
    let exact = format!("{:.60}", n);
    let (neg, exact) = match exact.strip_prefix('-') {
        Some(r) => (true, r.to_string()),
        None => (false, exact),
    };
    let mut parts = exact.splitn(2, '.');
    let int_part = parts.next().unwrap_or("0");
    let frac: Vec<u8> = parts.next().unwrap_or("").bytes().collect();
    let mut int_digits: Vec<u8> = int_part.bytes().collect();
    let mut kept: Vec<u8> = frac[..digits.min(frac.len())].to_vec();
    while kept.len() < digits {
        kept.push(b'0');
    }
    // The first dropped digit decides: 5 or above rounds up (ties away from
    // zero — there is nothing below a 5 that this digit position can hold,
    // because any nonzero digit beyond it still means strictly-over-half).
    let round_up = frac.len() > digits && frac[digits] >= b'5';
    if round_up {
        let mut carry = true;
        let mut i = kept.len();
        while carry && i > 0 {
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                carry = false;
            }
        }
        if carry {
            let mut j = int_digits.len();
            let mut icarry = true;
            while icarry && j > 0 {
                j -= 1;
                if int_digits[j] == b'9' {
                    int_digits[j] = b'0';
                } else {
                    int_digits[j] += 1;
                    icarry = false;
                }
            }
            if icarry {
                int_digits.insert(0, b'1');
            }
        }
    }
    let int_str: String = int_digits.iter().map(|&b| b as char).collect();
    let frac_str: String = kept.iter().map(|&b| b as char).collect();
    let out = if digits == 0 {
        int_str
    } else {
        format!("{}.{}", int_str, frac_str)
    };
    // Preserve the sign, except for a zero result (JS: (-0.001).toFixed(1)
    // is "0.0"... actually "-0.0", but the reference strips zeros anyway).
    if neg && out.bytes().any(|b| b.is_ascii_digit() && b != b'0') {
        format!("-{}", out)
    } else {
        out
    }
}

fn fmt1(n: f64) -> String {
    strip_zeros(round_fixed(n, 1))
}

fn fmt2(n: f64) -> String {
    strip_zeros(round_fixed(n, 2))
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

pub fn format_photography_metadata(exif: &Map<String, Value>, color_profile_value: &Value, iptc: &Map<String, Value>) -> Map<String, Value> {

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

    let color_profile = Some(color_profile_value)
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
