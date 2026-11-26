// Port of packages/core/src/trust.js — trust-profile reads + SSRF scan.

use serde_json::json;

use crate::ssrf::is_blocked_host;

#[derive(Clone)]
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
            // The separator must accept backslash-mixed forms: JSON producers
            // may escape slashes as \/, so a manifest can carry
            // "http:\/\/evil\/..." — the WHATWG parser treats \ as / for
            // special schemes, but the scan never reaches it when it insists
            // on a literal //. Require a colon then at least two separator
            // bytes drawn from {/, \} with at least one slash.
            if is_http && i + sep + 2 < n && bytes[i + sep] == b':' {
                let mut k = i + sep + 1;
                let mut slashes = 0usize;
                while k < n && (bytes[k] == b'/' || bytes[k] == b'\\') {
                    if bytes[k] == b'/' {
                        slashes += 1;
                    }
                    k += 1;
                }
                if slashes < 1 || k - (i + sep + 1) < 2 {
                    i += 1;
                    continue;
                }
                let mut end = k;
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
                // urls with unparseable/empty hosts are ignored — the scanner is
                // a pre-filter over raw bytes, not the fetch decision itself
                i = end;
                continue;
            }
        }
        i += 1;
    }
    false
}

// Host extraction for a URL literal via the WHATWG parser — normalization
// matters for the SSRF check: percent-encoded octets are decoded, backslashes
// collapse to slashes, userinfo is separated correctly, and exotic IPv4 forms
// (decimal, hex, octal) canonicalize to dotted-quad before evaluation.
fn url_host(literal: &str) -> Option<String> {
    let parsed = url::Url::parse(literal).ok()?;
    // host_str() already carries the bracketed form for IPv6 literals —
    // wrapping it again produced [[::1]], which the bracket-strip in
    // is_blocked_host cannot parse, failing closed on EVERY IPv6 literal
    // including legitimate public ones.
    Some(parsed.host_str()?.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_blocks_plain_loopback() {
        assert!(has_blocked_remote_url(br#""url": "http://127.0.0.1/x""#));
    }

    #[test]
    fn scan_blocks_json_escaped_slashes() {
        // JSON producers may escape / as \/ — the scan must see through it.
        assert!(has_blocked_remote_url(br#""url": "http:\/\/127.0.0.1\/secret""#));
        assert!(has_blocked_remote_url(br#""url": "http:\/\/169.254.169.254\/latest""#));
    }

    #[test]
    fn scan_allows_public_hosts_both_forms() {
        assert!(!has_blocked_remote_url(br#""url": "http://example.com/x""#));
        assert!(!has_blocked_remote_url(br#""url": "https:\/\/example.com\/x""#));
    }

    #[test]
    fn scan_blocks_private_and_nat64_forms() {
        assert!(has_blocked_remote_url(br#""u":"https://10.0.0.1/""#));
        assert!(has_blocked_remote_url(br#""u":"https://[64:ff9b::7f00:1]/""#));
        assert!(has_blocked_remote_url(br#""u":"https://[::1]/""#));
    }

    #[test]
    fn scan_allows_public_ipv6() {
        // 2606:4700:4700::1111 is Cloudflare public DNS — globally routable.
        assert!(!has_blocked_remote_url(br#""u":"https://[2606:4700:4700::1111]/""#));
    }

    #[test]
    fn scan_192_0_narrowing() {
        assert!(crate::ssrf::is_blocked_host("192.0.0.1"));   // protocol assignments /24
        assert!(crate::ssrf::is_blocked_host("192.0.2.1"));   // TEST-NET-1 documentation
        assert!(!crate::ssrf::is_blocked_host("192.0.3.1"));  // ordinary public space
    }
}

