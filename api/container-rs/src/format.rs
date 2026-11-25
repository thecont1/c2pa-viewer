// Port of packages/core/src/format.js — date/claim-generator formatting.
// Dates render in UTC, matching the container/workerd runtime behaviour
// (both run with TZ=UTC, and the goldens were captured under that rule).

use chrono::{Datelike, Timelike};

pub const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn pad2(n: i64) -> String {
    format!("{:02}", n)
}

fn format_date_fields(y: i64, mo: i64, d: i64, h: i64, mi: i64) -> String {
    let h12 = if h % 12 == 0 { 12 } else { h % 12 };
    let ampm = if h >= 12 { "PM" } else { "AM" };
    format!(
        "{} {}, {} at {}:{} {}",
        MONTHS[(mo as usize).min(11)], pad2(d), y, h12, pad2(mi), ampm
    )
}

// formatDatetimeFull(dtString, includeTimezone) — in JS the timezone-aware
// branch converts into runtime-local fields; in the container TZ is UTC, so
// parsing and rendering in UTC is the same result. includeTimezone appends
// " UTC" (what Intl short timeZoneName yields for UTC in workerd/locale en-US).
pub fn format_datetime_full(dt_string: &str, include_timezone: bool) -> String {
    if dt_string.is_empty() || dt_string == "Unknown" {
        return "Unknown".to_string();
    }
    // ISO 8601 (contains 'T')
    if dt_string.contains('T') {
        if let Some((y, mo, d, h, mi)) = parse_iso_like(dt_string) {
            if include_timezone {
                return format!(
                    "{} UTC",
                    format_date_fields(y, mo - 1, d, h, mi)
                );
            }
            return format_date_fields(y, mo - 1, d, h, mi);
        }
        return dt_string.to_string();
    }
    // EXIF format YYYY:MM:DD HH:MM:SS
    if let Some((y, mo, d, h, mi)) = parse_exif_like(dt_string) {
        return format_date_fields(y, mo - 1, d, h, mi);
    }
    dt_string.to_string()
}

// /(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})/ over an ISO string.
fn parse_iso_like(s: &str) -> Option<(i64, i64, i64, i64, i64)> {
    let bytes = s.as_bytes();
    let mut idx = None;
    for i in 0..bytes.len().saturating_sub(9) {
        if bytes[i].is_ascii_digit() {
            idx = Some(i);
            break;
        }
    }
    let i = idx?;
    let re = iso_regex();
    let caps = re.captures(&s[i..])?;
    let g = |n: usize| caps.get(n).map(|m| m.as_str().parse::<i64>().unwrap_or(0));
    Some((g(1)?, g(2)?, g(3)?, g(4)?, g(5)?))
}

fn parse_exif_like(s: &str) -> Option<(i64, i64, i64, i64, i64)> {
    let re = exif_regex();
    let caps = re.captures(s)?;
    let g = |n: usize| caps.get(n).map(|m| m.as_str().parse::<i64>().unwrap_or(0));
    Some((g(1)?, g(2)?, g(3)?, g(4)?, g(5)?))
}

fn iso_regex() -> &'static regex::Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?").unwrap()
    })
}

fn exif_regex() -> &'static regex::Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(\d{4}):(\d{1,2}):(\d{1,2}) (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?").unwrap()
    })
}

// formatClaimGenerator — split on '/', humanize the software part.
pub fn format_claim_generator(generator: &str) -> String {
    if generator.is_empty() {
        return "Unknown".to_string();
    }
    if generator.contains('/') {
        let parts: Vec<&str> = generator.split('/').collect();
        let software = titlecase_words(&parts[0].replace('_', " "));
        let version = if parts.len() > 1 { parts[1] } else { "" };
        if !version.is_empty() {
            format!("{} {}", software, version)
        } else {
            software
        }
    } else {
        generator.to_string()
    }
}

// JS: .replace(/\b\w/g, c => c.toUpperCase()) — uppercase the first letter of
// every word boundary (after space, start, or non-word char).
fn titlecase_words(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut boundary = true;
    for c in s.chars() {
        if boundary && c.is_ascii_lowercase() {
            out.push(c.to_ascii_uppercase());
        } else {
            out.push(c);
        }
        boundary = !c.is_alphanumeric();
    }
    out
}

// Keep chrono imports used in future timezone work referenced.
#[allow(dead_code)]
fn _unused(d: &chrono::DateTime<chrono::Utc>) -> (u32, u32) {
    (d.year() as u32, d.second())
}
