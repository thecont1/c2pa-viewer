// Port of packages/core/src/trust.js — trust-profile reads + SSRF scan.

use serde_json::json;

use crate::ssrf::is_blocked_host;

pub struct Anchors {
    pub c2pa: String,
    pub itl: String,
    pub config: String,
    pub meta: serde_json::Value,
}

/// scanUrlLiterals — find http(s):// literals in the asset bytes and check
/// their hosts against the SSRF guard. Mirrors the manual byte scan.
pub fn has_blocked_remote_url(bytes: &[u8]) -> bool {
    let n = bytes.len();
    if n < 9 {
        return false;
    }
    let lc = |c: u8| if c.is_ascii_uppercase() { c + 0x20 } else { c };
    let mut i = 0usize;
    while i + 8 < n {
        if lc(bytes[i]) == b'h' {
            let is_http = lc(bytes[i + 1]) == b't' && lc(bytes[i + 2]) == b't' && lc(bytes[i + 3]) == b'p';
            let is_https = is_http && lc(bytes[i + 4]) == b's';
            let sep = if is_https { 5 } else { 4 };
            if is_http
                && i + sep + 2 < n
                && bytes[i + sep] == b':'
                && bytes[i + sep + 1] == b'/'
                && bytes[i + sep + 2] == b'/'
            {
                let mut end = i + sep + 3;
                while end < n && end - i < 2083 {
                    let c = bytes[end];
                    if c <= 0x20 || c == 0x22 || c == 0x27 || c == 0x3c || c == 0x3e || c == 0x60 || c >= 0x7f {
                        break;
                    }
                    end += 1;
                }
                if let Ok(literal) = std::str::from_utf8(&bytes[i..end]) {
                    if let Some(host) = url_host(literal) {
                        if is_blocked_host(&host) {
                            return true;
                        }
                    }
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    false
}

// Minimal host extraction for a URL literal — enough for the SSRF check.
fn url_host(literal: &str) -> Option<String> {
    let after_scheme = literal.split("://").nth(1)?;
    let authority = after_scheme.split(&['/', '?', '#'][..]).next()?;
    // strip userinfo and port (IPv6 literals keep brackets)
    let hostport = authority.rsplit('@').next()?;
    if hostport.starts_with('[') {
        let end = hostport.find(']')? + 1;
        return Some(hostport[..end].to_string());
    }
    Some(hostport.split(':').next()?.to_string())
}

/// Build the c2pa 0.92 wire settings JSON for one read.
/// Mirrors what c2pa-node's resolveSettings produces: snake_cased
/// trust.anchors[] entries with trust_kind "manifest".
pub fn build_settings_json(anchors: &Anchors, profile: &str, remote_fetch: bool) -> String {
    let pem = if profile == "c2pa_and_itl" {
        format!("{}\n{}", anchors.c2pa, anchors.itl)
    } else {
        anchors.c2pa.clone()
    };
    let mut entry = json!({
        "trust_anchors": pem,
        "trust_uri": "manifest_system_anchors",
        "trust_kind": "manifest",
    });
    if !anchors.config.is_empty() {
        entry["trust_config"] = json!(anchors.config);
    }
    let settings = json!({
        "trust": {
            "anchors": [entry],
            "trust_config": anchors.config,
        },
        "verify": {
            "verify_trust": true,
            "remote_manifest_fetch": remote_fetch,
        },
    });
    settings.to_string()
}

pub struct TrustInfo {
    pub state: Option<String>,
    pub basis: Option<String>,
}

pub fn trust_lists_meta(anchors: &Anchors) -> serde_json::Value {
    let meta = &anchors.meta;
    let lists = meta.get("lists").cloned().unwrap_or(json!({}));
    let c2pa = lists.get("c2pa").cloned().unwrap_or(json!({}));
    let itl = lists.get("itl").cloned().unwrap_or(json!({}));
    json!({
        "c2pa": {
            "commit": c2pa.get("commit").cloned().unwrap_or(serde_json::Value::Null),
            "date": c2pa.get("commit_date").cloned().unwrap_or(serde_json::Value::Null),
        },
        "itl": {
            "fetched_at": itl.get("fetched_at").cloned().unwrap_or(serde_json::Value::Null),
        }
    })
}

pub fn signer_trust_label(state: Option<&str>, basis: Option<&str>) -> Option<&'static str> {
    match (state, basis) {
        (Some("Trusted"), Some("c2pa_trust_list")) => Some("Trusted — C2PA Trust List"),
        (Some("Trusted"), Some("interim_trust_list")) => Some("Trusted — Interim Trust List (legacy)"),
        (Some("Valid"), Some("none")) => Some("Signer not on a trust list"),
        _ => None,
    }
}
