// Client side of the QuotaCounter DO. Enforcement semantics:
//
//   - keys.quota_monthly NULL  — unlimited: every helper is a no-op
//     (reserve returns { token: null }, commit/release/charge return true)
//   - reserve/commit/release   — sync verification lifecycle: reserve at
//     admission, commit on success (in runVerification, awaited — NOT
//     waitUntil — so the commit always lands before the middleware's
//     finally-release, which then harmlessly no-ops), release on failure
//   - charge                   — fused count for async job acceptance
//
// Failure policy: a missing binding or a DO error fails CLOSED for reserve/
// charge (internal_error — same posture as the rate-limit binding) but
// commit/release failures only log. A lost commit under-charges; a lost
// release self-heals at token expiry.

import { currentMonth } from './db.js';

function stub(env, keyId) {
    if (!env.QUOTA_COUNTER) return null;
    return env.QUOTA_COUNTER.get(env.QUOTA_COUNTER.idFromName(keyId));
}

async function call(env, keyRow, payload) {
    const s = stub(env, keyRow.id);
    if (!s) throw new Error('QUOTA_COUNTER binding missing — worker misconfigured');
    const resp = await s.fetch('https://quota-counter/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key_id: keyRow.id, month: currentMonth(), ...payload }),
    });
    if (!resp.ok) throw new Error(`quota counter ${payload.op} failed: HTTP ${resp.status}`);
    return resp.json();
}

export function quotaLimited(keyRow) {
    return keyRow && keyRow.quota_monthly !== null && keyRow.quota_monthly !== undefined;
}

// Reserve one verification slot. Returns { token } on success (token null
// when the key is unlimited), null when the quota is exhausted. Throws on
// infrastructure failure — callers map that to internal_error.
export async function reserveQuota(env, keyRow) {
    if (!quotaLimited(keyRow)) return { token: null };
    const r = await call(env, keyRow, { op: 'reserve', limit: keyRow.quota_monthly });
    if (!r.ok) return null;
    return { token: r.token };
}

// Terminal success transition + D1 ledger write (inside the DO). Awaited by
// design — must land before any release attempt for the same token.
// Unlimited keys enforce nothing but still meter: a completed verification
// increments usage counts and bytes so the ledger reflects real consumption.
export async function commitQuota(env, keyRow, token, bytes) {
    if (!token) {
        if (keyRow && !quotaLimited(keyRow) && env.QUOTA_COUNTER) {
            try {
                await call(env, keyRow, { op: 'meter', bytes: bytes || 0 });
            } catch (e) {
                console.error('quota meter failed:', e);
            }
        }
        return;
    }
    try {
        await call(env, keyRow, { op: 'commit', token, bytes: bytes || 0 });
    } catch (e) {
        console.error('quota commit failed:', e);
    }
}

export async function releaseQuota(env, keyRow, token) {
    if (!token) return;
    try {
        await call(env, keyRow, { op: 'release', token });
    } catch (e) {
        console.error('quota release failed:', e);
    }
}

// Fused check+count for async job acceptance. Returns true when charged
// (or key unlimited), false when the quota is exhausted.
export async function chargeQuota(env, keyRow, bytes) {
    if (!quotaLimited(keyRow)) {
        // Same metering discipline as the sync path — job submissions by
        // unlimited keys are verifications too.
        if (keyRow && env.QUOTA_COUNTER) {
            try {
                await call(env, keyRow, { op: 'meter', bytes: bytes || 0 });
            } catch (e) {
                console.error('quota meter failed:', e);
            }
        }
        return true;
    }
    const r = await call(env, keyRow, { op: 'charge', limit: keyRow.quota_monthly, bytes: bytes || 0 });
    return r.ok === true;
}
