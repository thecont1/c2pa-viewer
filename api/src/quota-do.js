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
        // DO async interleaving race: two concurrent first-touch ops can both
        // observe missing state and each write a fresh object, the second
        // clobbering the first's reservations. Cache the loaded object — one
        // shared reference means mutations are visible to every interleaved op
        // — and serialize the storage read itself through a promise guard.
        if (this._stateCache && this._stateCache.month === month) {
            return this._prune(this._stateCache);
        }
        if (!this._stateLoad) {
            this._stateLoad = this._loadStateInner(keyId, month)
                .finally(() => { this._stateLoad = null; });
        }
        return this._stateLoad;
    }

    async _loadStateInner(keyId, month) {
        let state = await this.ctx.storage.get(STATE_KEY);
        if (!state || state.month !== month) {
            // Lazy rollover / first touch. Seed from the D1 ledger so usage
            // written before the DO existed (or by any legacy path) is
            // honored exactly once.
            // Seed failure must NOT persist consumed=0: one transient D1 error
            // would permanently zero the month and hand out the quota again.
            // Propagate instead — state stays uninitialized and the next op
            // retries the seed.
            const row = await this.env.DB.prepare(
                'SELECT verify_count FROM usage WHERE key_id = ? AND month = ?'
            ).bind(keyId, month).first();
            const consumed = row ? row.verify_count : 0;
            // Rollover carries pending reservations forward: they self-expire
            // within RESERVE_TTL_MS, and dropping them would lose the proof a
            // commit needs when a verification straddles midnight UTC.
            const carry = state && state.reserved ? { ...state.reserved } : {};
            state = { month, consumed, reserved: carry };
            await this.ctx.storage.put(STATE_KEY, state);
        }
        this._stateCache = state;
        return this._prune(state);
    }

    async _prune(state) {
        // Prune expired reservations.
        const now = Date.now();
        let dirty = false;
        for (const [token, entry] of Object.entries(state.reserved)) {
            const exp = typeof entry === 'number' ? entry : entry.exp;
            if (exp <= now) { delete state.reserved[token]; dirty = true; }
        }
        if (dirty) await this._put(state);
        return state;
    }

    async _put(state) {
        this._stateCache = state;
        await this.ctx.storage.put(STATE_KEY, state);
    }

    // D1 ledger write with persistent retry. The DO is the only writer of
    // usage.verify_count; a discarded failure strands the divergence forever
    // because the reservation is already finalized. Failed entries persist in
    // DO storage and flush on every subsequent op.
    async incrementD1(keyId, month, bytes) {
        const entry = { keyId, month, bytes: bytes || 0, id: crypto.randomUUID() };
        await this._ledgerChain(async () => {
            const pending = (await this.ctx.storage.get('pendingLedger')) || [];
            pending.push(entry);
            await this.ctx.storage.put('pendingLedger', pending);
            await this._flushLedgerInner();
        });
    }

    // DO async interleaving applies to the ledger too: two concurrent commits
    // enqueueing at once each read the pre-write list and one entry is lost;
    // two concurrent flushes both write the same entry to D1. Every access
    // is chained through one promise so mutations fully serialize.
    _ledgerChain(fn) {
        const run = (this._ledgerTail || Promise.resolve()).then(fn);
        this._ledgerTail = run.catch(() => { });
        return run;
    }

    _flushLedger() {
        return this._ledgerChain(() => this._flushLedgerInner());
    }

    async _flushLedgerInner() {
        const pending = (await this.ctx.storage.get('pendingLedger')) || [];
        if (!pending.length) return;
        const remaining = [];
        for (const entry of pending) {
            try {
                await this.env.DB.prepare(
                    `INSERT INTO usage (key_id, month, verify_count, bytes_total, updated_at)
                     VALUES (?, ?, 1, ?, ?)
                     ON CONFLICT (key_id, month) DO UPDATE SET
                       verify_count = verify_count + 1,
                       bytes_total  = bytes_total + excluded.bytes_total,
                       updated_at   = excluded.updated_at`
                ).bind(entry.keyId, entry.month, entry.bytes, nowIso()).run();
            } catch (e) {
                console.error('quota D1 ledger write failed (will retry):', e);
                remaining.push(entry);
            }
        }
        if (remaining.length !== pending.length) {
            await this.ctx.storage.put('pendingLedger', remaining);
        }
        if (remaining.length) {
            // nothing further scheduled here — the next op flushes again; the
            // entries cannot be lost because they live in DO storage
        }
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
        this.ctx.waitUntil(this._flushLedger().catch((e) => console.error('ledger flush error:', e)));

        switch (kind) {
            case 'reserve': {
                const limit = op.limit;
                if (typeof limit !== 'number') return Response.json({ error: 'limit required' }, { status: 400 });
                const active = Object.keys(state.reserved).length;
                if (state.consumed + active >= limit) {
                    return Response.json({ ok: false, consumed: state.consumed, active });
                }
                const token = crypto.randomUUID();
                state.reserved[token] = { exp: Date.now() + RESERVE_TTL_MS, month: state.month };
                await this._put(state);
                return Response.json({ ok: true, token, consumed: state.consumed, active: active + 1 });
            }

            case 'commit': {
                const token = op.token;
                if (!token || !(token in state.reserved)) {
                    // Already released/committed or expired — exactly-once.
                    return Response.json({ ok: true, transitioned: false });
                }
                const entry = state.reserved[token];
                delete state.reserved[token];
                state.consumed += 1;
                await this._put(state);
                // The ledger month is the reservation's own month — a commit
                // straddling midnight UTC counts where the verification started.
                const ledgerMonth = entry && typeof entry === 'object' && entry.month ? entry.month : month;
                this.ctx.waitUntil(this.incrementD1(keyId, ledgerMonth, op.bytes));
                return Response.json({ ok: true, transitioned: true, consumed: state.consumed });
            }

            case 'release': {
                const token = op.token;
                if (token && token in state.reserved) {
                    delete state.reserved[token];
                    await this._put(state);
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
                await this._put(state);
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
