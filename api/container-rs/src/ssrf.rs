// Port of packages/core/src/ssrf.js — blocked-host SSRF guard.
//
// Hardened after review: hosts are evaluated in their WHATWG-normalized form
// (the `url` crate decodes percent-encoding, treats backslashes as slashes,
// and canonicalizes exotic IPv4 notations), and IPv6 is evaluated as a parsed
// address rather than string prefixes so embedded-IPv4 forms — mapped,
// compatible, NAT64 — cannot slip through in non-canonical notation.

use std::net::{Ipv4Addr, Ipv6Addr};

pub fn is_blocked_host(hostname: &str) -> bool {
    let mut h = hostname.to_lowercase();
    if h.ends_with('.') {
        h.pop();
    }
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    if h == "metadata.google.internal" {
        return true;
    }
    // Bracketed IPv6 literal — parse and evaluate the address itself.
    if h.starts_with('[') {
        let inner = match h.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            Some(inner) => inner,
            None => return true, // malformed bracket form: fail closed
        };
        return match inner.parse::<Ipv6Addr>() {
            Ok(addr) => is_blocked_ipv6(&addr),
            Err(_) => true, // unparseable bracketed host: fail closed
        };
    }
    if let Ok(addr) = h.parse::<Ipv4Addr>() {
        return is_blocked_ipv4(&addr);
    }
    false
}

fn is_blocked_ipv4(addr: &Ipv4Addr) -> bool {
    let [a, b, _, _] = addr.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0) // IETF protocol assignments incl. 192.0.0.0/24
        || (a == 198 && (b == 18 || b == 19)) // benchmark networks
        || a >= 224 // multicast/reserved — never a legitimate remote manifest host
}

fn is_blocked_ipv6(addr: &Ipv6Addr) -> bool {
    if addr.is_loopback() || addr.is_unspecified() {
        return true;
    }
    let segments = addr.segments();
    // unique local fc00::/7 and link-local fe80::/10
    if (segments[0] & 0xfe00) == 0xfc00 || (segments[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // IPv4-mapped ::ffff:0:0/96 and deprecated IPv4-compatible ::/96 — evaluate
    // the embedded IPv4 against the IPv4 rules.
    if let Some(v4) = addr.to_ipv4_mapped().or_else(|| addr.to_ipv4()) {
        return is_blocked_ipv4(&v4);
    }
    // NAT64 64:ff9b::/96 embeds the IPv4 in the final 32 bits.
    if segments[0] == 0x64 && segments[1] == 0xff9b && segments[2] == 0 && segments[3] == 0 {
        let v4 = Ipv4Addr::from(((segments[6] as u32) << 16) | segments[7] as u32);
        return is_blocked_ipv4(&v4);
    }
    false
}
