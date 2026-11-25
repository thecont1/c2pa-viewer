// SSRF guard — canonical copy, shared by two consumers:
//   - functions/api/img.js (Pages image proxy) imports this module directly;
//     scripts/stage-site.sh stages this file into .deploy-stage/packages/ so
//     the relative import resolves identically in the staged deploy tree.
//   - api/src/urlfetch.js (the c2pa-verify-api Worker) for server-side fetches.
//
// Pure logic, no I/O. Verbatim port of the guard originally inlined in
// functions/api/img.js — keep behaviour identical in both directions.

// Basic SSRF guard. Private-range checks apply only to IP literals —
// DNS names like 10.images.example.org must not match.
export function isBlockedHost(hostname) {
    const h = hostname.toLowerCase().replace(/\.$/, '');
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h === 'metadata.google.internal') return true;

    // IPv4 literal (URL parser has already normalized exotic forms like
    // 0x7f000001 or 2130706433 into dotted quads)
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
        const [a, b] = h.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            (a === 100 && b >= 64 && b <= 127);
    }

    // IPv6 literals (hostname keeps its brackets): loopback, unspecified,
    // link-local, ULA, and IPv4-mapped addresses
    if (h.startsWith('[')) {
        if (h === '[::1]' || h === '[::]' || h.startsWith('[::ffff:') ||
            h.startsWith('[fc') || h.startsWith('[fd')) return true;
        // Link-local unicast is fe80::/10 (RFC 4291): the first hextet ranges
        // fe80–febf, not just the fe80 prefix literal. Compressed forms can
        // never start link-local (a leading :: means the first hextet is 0).
        const firstHextet = h.slice(1).split(':')[0];
        if (/^[0-9a-f]{1,4}$/.test(firstHextet)) {
            const n = parseInt(firstHextet, 16);
            if ((n & 0xffc0) === 0xfe80) return true;
        }
    }
    return false;
}
