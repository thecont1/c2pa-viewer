// D1 helpers: monthly usage metering + CORS origin scans.

export function currentMonth() {
    return new Date().toISOString().slice(0, 7); // 'YYYY-MM' (UTC)
}

// Read the usage row for (key_id, month). Returns
// { verify_count, bytes_total } — zeroes when no row exists yet.
export async function getUsage(db, keyId, month) {
    const row = await db.prepare(
        'SELECT verify_count, bytes_total FROM usage WHERE key_id = ? AND month = ?'
    ).bind(keyId, month).first();
    return {
        verify_count: row ? row.verify_count : 0,
        bytes_total: row ? row.bytes_total : 0,
    };
}

// Increment usage after a successful verification. Designed to run inside
// ctx.waitUntil — never awaited on the response path.
export async function incrementUsage(db, keyId, month, bytes) {
    const now = new Date().toISOString();
    await db.prepare(
        `INSERT INTO usage (key_id, month, verify_count, bytes_total, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (key_id, month) DO UPDATE SET
           verify_count = verify_count + 1,
           bytes_total  = bytes_total + excluded.bytes_total,
           updated_at   = excluded.updated_at`
    ).bind(keyId, month, bytes, now).run();
}

// Collect every distinct allowed origin across non-revoked browser keys.
// Used by the preflight handler, which runs before any key is presented.
export async function allAllowedOrigins(db) {
    const res = await db.prepare(
        "SELECT allowed_origins FROM keys WHERE revoked_at IS NULL AND allowed_origins IS NOT NULL AND allowed_origins != ''"
    ).all();
    const out = new Set();
    for (const row of res.results || []) {
        try {
            const arr = JSON.parse(row.allowed_origins);
            if (Array.isArray(arr)) for (const o of arr) out.add(o);
        } catch { /* ignore malformed rows */ }
    }
    return out;
}
