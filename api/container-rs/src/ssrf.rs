// Port of packages/core/src/ssrf.js — blocked-host SSRF guard.

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
    // IPv4 literal (the URL parser has normalized exotic forms upstream).
    if is_ipv4_literal(&h) {
        let parts: Vec<u32> = h.split('.').map(|p| p.parse().unwrap_or(0)).collect();
        let (a, b) = (parts[0], parts[1]);
        return a == 0
            || a == 10
            || a == 127
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 169 && b == 254)
            || (a == 100 && (64..=127).contains(&b));
    }
    if h.starts_with('[') {
        if h == "[::1]" || h == "[::]" || h.starts_with("[::ffff:") || h.starts_with("[fc") || h.starts_with("[fd") {
            return true;
        }
        let first_hextet = h[1..].split(':').next().unwrap_or("");
        if !first_hextet.is_empty()
            && first_hextet.len() <= 4
            && first_hextet.chars().all(|c| c.is_ascii_hexdigit())
        {
            if let Ok(n) = u32::from_str_radix(first_hextet, 16) {
                if (n & 0xffc0) == 0xfe80 {
                    return true;
                }
            }
        }
    }
    false
}

fn is_ipv4_literal(h: &str) -> bool {
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
}
