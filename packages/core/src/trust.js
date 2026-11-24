// Trust-anchor settings + trust-state resolution.
//
// Settings object shape (verified against c2pa-rs / c2pa-web / c2pa-wasm):
//   { version: 1,
//     trust:   { trust_anchors: "<concatenated PEM>", trust_config: "<store.cfg>" },
//     verify:  { verify_trust: true } }
//
// Two trust profiles exist because the C2PA spec requires validators to
// distinguish trust via the official C2PA Trust List from trust via the
// frozen Interim Trust List (ITL). Adobe currently signs from the ITL.

export function buildSettings({ c2pa, itl, config }, profile) {
    const anchors = profile === 'c2pa_and_itl'
        ? `${c2pa || ''}\n${itl || ''}`
        : (c2pa || '');
    return {
        version: 1,
        trust: {
            trust_anchors: anchors,
            trust_config: config || '',
        },
        verify: { verify_trust: true },
    };
}

// Metadata block surfaced under result.trust.lists.
export function trustListsMeta(anchors) {
    const meta = (anchors && anchors.meta) || {};
    const lists = meta.lists || {};
    const c2pa = lists.c2pa || {};
    const itl = lists.itl || {};
    return {
        c2pa: { commit: c2pa.commit ?? null, date: c2pa.commit_date ?? null },
        itl: { fetched_at: itl.fetched_at ?? null },
    };
}

async function disposeQuietly(handle) {
    if (handle && handle.dispose) {
        try { await handle.dispose(); } catch { }
    }
}

// Read the asset under the trust profiles and keep the winning reader.
// Returns { handle, trust } where handle is the engine.read result to use
// for data extraction (null when there is no manifest) and trust is
// { state, basis }:
//   Trusted + c2pa list        -> { state:'Trusted', basis:'c2pa_trust_list' }
//   Trusted only via ITL       -> { state:'Trusted', basis:'interim_trust_list' }
//   Valid but on no list       -> { state:'Valid',   basis:'none' }
//   Invalid / other            -> { state:<state>,   basis:null }
//   no manifest                -> { state:null,      basis:null }
// Only Valid-but-untrusted pays for the second read; Trusted-under-c2pa and
// Invalid paths do a single read. The losing reader is always disposed.
export async function readWithTrustProfiles(engine, bytes, mime, anchors) {
    const first = await engine.read(bytes, mime, buildSettings(anchors, 'c2pa'));
    if (!first) {
        return { handle: null, trust: { state: null, basis: null } };
    }

    const state1 = first.store && first.store.validation_state ? first.store.validation_state : null;

    if (state1 === 'Trusted') {
        return { handle: first, trust: { state: 'Trusted', basis: 'c2pa_trust_list' } };
    }

    if (state1 === 'Valid') {
        const second = await engine.read(bytes, mime, buildSettings(anchors, 'c2pa_and_itl'));
        const state2 = second && second.store && second.store.validation_state
            ? second.store.validation_state : null;
        if (state2 === 'Trusted') {
            await disposeQuietly(first);
            return { handle: second, trust: { state: 'Trusted', basis: 'interim_trust_list' } };
        }
        await disposeQuietly(second);
        return { handle: first, trust: { state: 'Valid', basis: 'none' } };
    }

    return { handle: first, trust: { state: state1, basis: null } };
}

// Standalone verdict for callers that only need the trust state.
// Disposes every reader it opens.
export async function resolveTrust(engine, bytes, mime, anchors) {
    const { handle, trust } = await readWithTrustProfiles(engine, bytes, mime, anchors);
    await disposeQuietly(handle);
    return trust;
}

// Human-readable label for the provenance "Signer Trust" row.
// Returns null for states where a trust verdict is not meaningful
// (Invalid signature, no manifest) so no row is rendered.
export function signerTrustLabel(trust) {
    if (!trust) return null;
    if (trust.state === 'Trusted' && trust.basis === 'c2pa_trust_list') {
        return 'Trusted — C2PA Trust List';
    }
    if (trust.state === 'Trusted' && trust.basis === 'interim_trust_list') {
        return 'Trusted — Interim Trust List (legacy)';
    }
    if (trust.state === 'Valid' && trust.basis === 'none') {
        return 'Signer not on a trust list';
    }
    return null;
}
