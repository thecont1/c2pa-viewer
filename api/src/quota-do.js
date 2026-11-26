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
        const state = await this._stateLoad;
        // The shared load may have been started by a caller requesting a
        // DIFFERENT month (midnight UTC rollover mid-initialization). Quota
        // decisions and token attribution must use the requested month —
        // recheck and load again rather than serve the wrong month's state.
        if (state.month === month) return state;
        return this.loadState(keyId, month);
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

    // Admission pressure counts only the CURRENT month's reservations.
    // Carried-over stragglers from last month stay in state.reserved (their
    // commits must still find their tokens) but must not inflate this
    // month's admission count — their ledger rows already landed in the
    // month they belong to. Legacy numeric entries carry no month and count
    // conservatively as current.
    _activeCount(state) {
        let n = 0;
        for (const entry of Object.values(state.reserved)) {
            if (entry && typeof entry === 'object' && entry.month && entry.month !== state.month) continue;
            n += 1;
        }
        return n;
    }

    async _put(state) {
        this._stateCache = state;
        await this.ctx.storage.put(STATE_KEY, state);
    }

    // D1 ledger writes are receipt-guarded exactly-once batches; failed
    // entries persist in DO storage (pendingLedger) and flush on every
    // subsequent op. Enqueueing happens atomically with the quota transition
    // inside each op — see commit/charge/meter.

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
                // Receipt-guarded exactly-once increment in one atomic batch:
                // a retry after an unacknowledged success finds the receipt
                // and the conditional increment no-ops. Statement order does
                // the work — the increment is conditioned on the receipt NOT
                // yet existing, the receipt insert lands after it.
                const now = nowIso();
                await this.env.DB.batch([
                    this.env.DB.prepare(
                        `INSERT OR IGNORE INTO usage (key_id, month, verify_count, bytes_total, updated_at)
                         VALUES (?, ?, 0, 0, ?)`
                    ).bind(entry.keyId, entry.month, now),
                    this.env.DB.prepare(
                        `UPDATE usage SET verify_count = verify_count + 1, bytes_total = bytes_total + ?, updated_at = ?
                         WHERE key_id = ? AND month = ?
                           AND NOT EXISTS (SELECT 1 FROM quota_receipts WHERE receipt_id = ?)`
                    ).bind(entry.bytes, now, entry.keyId, entry.month, entry.id),
                    this.env.DB.prepare(
                        `INSERT OR IGNORE INTO quota_receipts (receipt_id, key_id, month, created_at)
                         VALUES (?, ?, ?, ?)`
                    ).bind(entry.id, entry.keyId, entry.month, now),
                ]);
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
                // Rotation handoff: once finalize ran, new admissions on the
                // predecessor must stop — a reservation created after the
                // seed read would commit past the successor's counter. The
                // handoff expires on its own so a rotation that fails after
                // finalizing does not wedge the key forever.
                if (state.handoffUntil && state.handoffUntil > Date.now()) {
                    return Response.json({ ok: false, handoff: true, consumed: state.consumed, active: this._activeCount(state) });
                }
                const active = this._activeCount(state);
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
                // Expiry-precise: a token past its lifetime is rejected here,
                // not just when the prune happens to run. The verification
                // outlived its reservation — the slot was already reclaimed
                // for admission, so the late commit must not count.
                const exp = typeof entry === 'number' ? entry : entry && entry.exp;
                if (exp && exp <= Date.now()) {
                    delete state.reserved[token];
                    await this._put(state);
                    return Response.json({ ok: true, transitioned: false, expired: true });
                }
                delete state.reserved[token];
                // The ledger month is the reservation's own month — a commit
                // straddling midnight UTC counts where the verification started.
                const ledgerMonth = entry && typeof entry === 'object' && entry.month ? entry.month : month;
                // consumed tracks the CURRENT month only: a carried-over
                // reservation from last month must not inflate this month's
                // count — its ledger row already landed in the prior month.
                if (ledgerMonth === state.month) {
                    state.consumed += 1;
                }
                // The quota transition and the retry-queued ledger entry are
                // persisted in ONE atomic storage write — a crash between
                // them previously stranded the divergence forever because
                // the reservation was already finalized. The ledger chain
                // serializes the read-modify-write of the pending queue, so
                // the enqueue is race-free, and the receipt-guarded D1 batch
                // keeps retries exactly-once.
                const ledgerEntry = { keyId, month: ledgerMonth, bytes: op.bytes || 0, id: crypto.randomUUID() };
                await this._ledgerChain(async () => {
                    const pending = (await this.ctx.storage.get('pendingLedger')) || [];
                    pending.push(ledgerEntry);
                    await this.ctx.storage.put({ [STATE_KEY]: state, pendingLedger: pending });
                    this._stateCache = state;
                    await this._flushLedgerInner();
                });
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
                const active = this._activeCount(state);
                if (state.consumed + active >= limit) {
                    return Response.json({ ok: false, consumed: state.consumed, active });
                }
                state.consumed += 1;
                // Same atomic transition+enqueue discipline as commit: the
                // count and the retry-queued ledger entry persist or neither
                // does.
                const chargeEntry = { keyId, month, bytes: op.bytes || 0, id: crypto.randomUUID() };
                await this._ledgerChain(async () => {
                    const pending = (await this.ctx.storage.get('pendingLedger')) || [];
                    pending.push(chargeEntry);
                    await this.ctx.storage.put({ [STATE_KEY]: state, pendingLedger: pending });
                    this._stateCache = state;
                    await this._flushLedgerInner();
                });
                return Response.json({ ok: true, consumed: state.consumed });
            }

            case 'finalize': {
                // Key-rotation handoff: the successor's seed must account for
                // every verification the predecessor already accepted. Flush
                // the pending ledger synchronously so consumed reflects all
                // committed work, then report consumed plus the still-active
                // reservations — the seed conservatively pre-counts in-flight
                // verifications, so a late commit cannot slip past the
                // successor's counter. (Late commits still write the
                // predecessor's ledger row for audit; nobody reads it for
                // quota afterward.)
                await this._flushLedger().catch((e) => console.error('finalize flush failed:', e));
                state.handoffUntil = Date.now() + 2 * 60 * 1000;
                await this._put(state);
                return Response.json({
                    ok: true,
                    consumed: state.consumed,
                    active: Object.keys(state.reserved).length,
                    month: state.month,
                });
            }

            case 'unfinalize': {
                // Rotation failed after finalizing — lift the admission block
                // immediately rather than waiting out the expiry.
                if (state.handoffUntil) {
                    delete state.handoffUntil;
                    await this._put(state);
                }
                return Response.json({ ok: true });
            }

            case 'meter': {
                // Unlimited keys enforce nothing but still meter: a completed
                // verification always increments usage counts and bytes.
                state.consumed += 1;
                const meterEntry = { keyId, month: state.month, bytes: op.bytes || 0, id: crypto.randomUUID() };
                await this._ledgerChain(async () => {
                    const pending = (await this.ctx.storage.get('pendingLedger')) || [];
                    pending.push(meterEntry);
                    await this.ctx.storage.put({ [STATE_KEY]: state, pendingLedger: pending });
                    this._stateCache = state;
                    await this._flushLedgerInner();
                });
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
