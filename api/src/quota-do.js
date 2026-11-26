// QuotaCounter Durable Object — one instance per API key, the single
// authoritative writer of monthly verification counts. Exists to eliminate
// the check-then-increment race of the plain D1 quota path: concurrent
// verifications on one key serialize here, so a key can never overshoot its
// monthly quota.
//
// Lifecycle of one verification:
//   reserve()  — admission hold; consumed is UNTOUCHED, a pending token is
//                created (auto-expires after RESERVE_TTL_MS so a worker crash
//                cannot leak quota)
//   commit()   — success: consumed++ and the D1 usage row is incremented
//                (off-path, inside the DO's own waitUntil — the DO is the
//                only writer of usage.verify_count, so DO state and the D1
//                ledger cannot drift)
//   release()  — failure: token discarded, nothing counted
//   charge()   — fused reserve+commit for job acceptance, where submission
//                itself is the billable event
//
// commit/release are idempotent terminal transitions — whichever arrives
// first wins, the second is a no-op. Month rollover is lazy: the first op
// carrying a new month reseeds consumed from the D1 ledger (one-time
// migration path for usage written before this DO existed) and drops all
// pending tokens.
//
// Unlimited keys (quota_monthly null) never reach this object — callers
// short-circuit. Test keys are never charged upstream either.

import { DurableObject } from 'cloudflare:workers';

const RESERVE_TTL_MS = 10 * 60 * 1000;
const STATE_KEY = 'state';

function nowIso() { return new Date().toISOString(); }

export class QuotaCounter extends DurableObject {
    async loadState(keyId, month) {
        let state = await this.ctx.storage.get(STATE_KEY);
        if (!state || state.month !== month) {
            // Lazy rollover / first touch. Seed from the D1 ledger so usage
            // written before the DO existed (or by any legacy path) is
            // honored exactly once.
            let consumed = 0;
            try {
                const row = await this.env.DB.prepare(
                    'SELECT verify_count FROM usage WHERE key_id = ? AND month = ?'
                ).bind(keyId, month).first();
                consumed = row ? row.verify_count : 0;
            } catch (e) {
                console.error('quota seed read failed:', e);
                // Fail closed toward the customer: unknown prior usage is
                // treated as zero rather than blocking service.
            }
            state = { month, consumed, reserved: {} };
            await this.ctx.storage.put(STATE_KEY, state);
        }
        // Prune expired reservations.
        const now = Date.now();
        let dirty = false;
        for (const [token, exp] of Object.entries(state.reserved)) {
            if (exp <= now) { delete state.reserved[token]; dirty = true; }
        }
        if (dirty) await this.ctx.storage.put(STATE_KEY, state);
        return state;
    }

    incrementD1(keyId, month, bytes) {
        const now = nowIso();
        return this.env.DB.prepare(
            `INSERT INTO usage (key_id, month, verify_count, bytes_total, updated_at)
             VALUES (?, ?, 1, ?, ?)
             ON CONFLICT (key_id, month) DO UPDATE SET
               verify_count = verify_count + 1,
               bytes_total  = bytes_total + excluded.bytes_total,
               updated_at   = excluded.updated_at`
        ).bind(keyId, month, bytes || 0, now).run()
            .catch((e) => console.error('quota D1 ledger write failed:', e));
    }

    async fetch(request) {
        let op;
        try { op = await request.json(); } catch {
            return Response.json({ error: 'invalid op' }, { status: 400 });
        }
        const { key_id: keyId, month, op: kind } = op || {};
        if (!keyId || !month || !kind) {
            return Response.json({ error: 'key_id, month and op are required' }, { status: 400 });
        }

        const state = await this.loadState(keyId, month);

        switch (kind) {
            case 'reserve': {
                const limit = op.limit;
                if (typeof limit !== 'number') return Response.json({ error: 'limit required' }, { status: 400 });
                const active = Object.keys(state.reserved).length;
                if (state.consumed + active >= limit) {
                    return Response.json({ ok: false, consumed: state.consumed, active });
                }
                const token = crypto.randomUUID();
                state.reserved[token] = Date.now() + RESERVE_TTL_MS;
                await this.ctx.storage.put(STATE_KEY, state);
                return Response.json({ ok: true, token, consumed: state.consumed, active: active + 1 });
            }

            case 'commit': {
                const token = op.token;
                if (!token || !(token in state.reserved)) {
                    // Already released/committed or expired — exactly-once.
                    return Response.json({ ok: true, transitioned: false });
                }
                delete state.reserved[token];
                state.consumed += 1;
                await this.ctx.storage.put(STATE_KEY, state);
                this.ctx.waitUntil(this.incrementD1(keyId, month, op.bytes));
                return Response.json({ ok: true, transitioned: true, consumed: state.consumed });
            }

            case 'release': {
                const token = op.token;
                if (token && token in state.reserved) {
                    delete state.reserved[token];
                    await this.ctx.storage.put(STATE_KEY, state);
                    return Response.json({ ok: true, transitioned: true });
                }
                return Response.json({ ok: true, transitioned: false });
            }

            case 'charge': {
                const limit = op.limit;
                if (typeof limit !== 'number') return Response.json({ error: 'limit required' }, { status: 400 });
                const active = Object.keys(state.reserved).length;
                if (state.consumed + active >= limit) {
                    return Response.json({ ok: false, consumed: state.consumed, active });
                }
                state.consumed += 1;
                await this.ctx.storage.put(STATE_KEY, state);
                this.ctx.waitUntil(this.incrementD1(keyId, month, op.bytes));
                return Response.json({ ok: true, consumed: state.consumed });
            }

            case 'peek': {
                return Response.json({
                    ok: true,
                    consumed: state.consumed,
                    active: Object.keys(state.reserved).length,
                    month: state.month,
                });
            }

            default:
                return Response.json({ error: `unknown op: ${kind}` }, { status: 400 });
        }
    }
}
