// API key primitives — pure JS, no workerd/web dependencies, so both the
// Worker (auth.js) and the admin CLI (scripts/keyctl.mjs) import this module.
//
// Key format:  c2pa_live_<32 base62 chars>  /  c2pa_test_<32 base62 chars>
// Storage:     sha256 hex of the full key in keys.key_hash — plaintext is
//              never stored nor logged.
// display_prefix: key kind prefix + first 8 secret chars, e.g.
//              "c2pa_live_ab12cd34" — safe to show in lists/logs.

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SECRET_LEN = 32;

// Rejection-sampled base62 random string (256 % 62 != 0, so bytes >= 248
// are discarded to avoid modulo bias).
export function randomBase62(len = SECRET_LEN) {
    const out = [];
    while (out.length < len) {
        const buf = new Uint8Array(len * 2);
        crypto.getRandomValues(buf);
        for (const b of buf) {
            if (b >= 248) continue;
            out.push(BASE62[b % 62]);
            if (out.length === len) break;
        }
    }
    return out.join('');
}

// Generate a new key. kind: 'live' | 'test'. Hashing is async — use
// sha256HexText(plaintext); only the hash and displayPrefix may be persisted.
export function generateKey(kind = 'live') {
    const secret = randomBase62(SECRET_LEN);
    const plaintext = `c2pa_${kind}_${secret}`;
    return {
        plaintext,
        displayPrefix: plaintext.slice(0, `c2pa_${kind}_`.length + 8),
    };
}

// sha256 hex of a text string — used for key hashing (keys-mw/keyctl) and
// trust-file digests (index.js trust-lists endpoint).
export async function sha256HexText(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function keyKind(key) {
    if (typeof key !== 'string') return null;
    if (key.startsWith('c2pa_live_')) return 'live';
    if (key.startsWith('c2pa_test_')) return 'test';
    return null;
}

export function parseJsonArray(text) {
    if (!text) return [];
    try {
        const v = JSON.parse(text);
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

// Look up a key row by plaintext key (D1). Returns null when unknown.
export async function lookupKey(db, plaintext) {
    const hash = await sha256HexText(plaintext);
    return db.prepare('SELECT * FROM keys WHERE key_hash = ?').bind(hash).first();
}
