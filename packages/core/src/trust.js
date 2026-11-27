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

export function buildSettings({ c2pa, itl, config }, profile, { remoteFetch = true } = {}) {
    const anchors = profile === 'c2pa_and_itl'
        ? `${c2pa || ''}\n${itl || ''}`
        : (c2pa || '');
    return {
        version: 1,
        trust: {
            trust_anchors: anchors,
            trust_config: config || '',
        },
        verify: { verify_trust: true, remote_manifest_fetch: remoteFetch },
    };
}

// --- remote-manifest SSRF guard ---------------------------------------------
// An asset with no embedded store can reference its manifest at an arbitrary
// remote URL, and the reader fetches it during verification. That URL is
// attacker-controlled and never passes the isBlockedHost destination check
// the `url` input path applies — a crafted asset can aim verification-time
// fetches at loopback, link-local metadata endpoints, or private addresses.
// The SDK exposes no per-fetch hook, only the per-read remote_manifest_fetch
// toggle, so the guard scans the asset bytes for URL literals (remote
// manifest references are plaintext: XMP packets, CBOR box payloads) and
// disables remote fetching for the read when any of them is a blocked host.
// Public manifest hosts — e.g. the documented cloud.jpg cai-manifests.adobe.com
// flow — are unaffected. Namespace constant URLs (ns.adobe.com etc.) are never
// blocked hosts, so ordinary XMP metadata does not trip the guard.
import { isBlockedHost } from './ssrf.js';

const urlDecoder = new TextDecoder();

function scanUrlLiterals(bytes, visit) {
    // Manual scan — regex would require a full latin1 copy of the asset.
    const n = bytes.byteLength;
    // URL schemes are case-insensitive; compare lowercase so HTTP:// cannot
    // slip past the guard.
    const lc = (c) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
    let i = 0;
    while (i < n - 8) {
        if (lc(bytes[i]) === 0x68) { // 'h'
            const isHttp = lc(bytes[i + 1]) === 0x74 && lc(bytes[i + 2]) === 0x74 && lc(bytes[i + 3]) === 0x70;
            const isHttps = isHttp && lc(bytes[i + 4]) === 0x73;
            const sep = isHttps ? 5 : 4;
            if (isHttp && bytes[i + sep] === 0x3a) {
                // After the colon, skip any run of / and \ — including an
                // EMPTY run. The WHATWG parser treats every one of these as
                // an authority for special schemes: //, \/, \, one slash,
                // and even zero separators (http:127.0.0.1 parses to host
                // 127.0.0.1). JSON producers escape slashes as \/, so a
                // scan that insists on a literal // never sees the form the
                // parser resolves to loopback. Requiring the colon only
                // costs a few extra URL parses on prose like "the http:
                // protocol" — cheap, and a blocked hit only DISABLES remote
                // fetching, which is the fail-safe direction.
                let k = i + sep + 1;
                while (k < n && (bytes[k] === 0x2f || bytes[k] === 0x5c)) k++;
                let end = k;
                while (end < n && end - i < 2083) {
                    const c = bytes[end];
                    // URL token ends at whitespace, quotes, angle brackets, controls.
                    if (c <= 0x20 || c === 0x22 || c === 0x27 || c === 0x3c || c === 0x3e || c === 0x60 || c >= 0x7f) break;
                    end++;
                }
                if (end > k) {
                    visit(urlDecoder.decode(bytes.subarray(i, end)));
                    i = end;
                    continue;
                }
            }
        }
        i++;
    }
}

export function hasBlockedRemoteUrl(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let blocked = false;
    scanUrlLiterals(u8, (literal) => {
        if (blocked) return;
        try {
            if (isBlockedHost(new URL(literal).hostname)) blocked = true;
        } catch { /* not a parseable URL — the SDK cannot fetch it either */ }
    });
    return blocked;
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
//
// `profile` selects which trust lists may produce a Trusted verdict:
//   'c2pa_and_itl' (default) — official C2PA Trust List, falling back to the
//       combined C2PA+ITL read for Valid-but-untrusted manifests.
//   'c2pa' — official C2PA Trust List only; the ITL second read is SKIPPED,
//       so a signer present only on the Interim Trust List resolves to
//       { state:'Valid', basis:'none' }.
export async function readWithTrustProfiles(engine, bytes, mime, anchors, profile = 'c2pa_and_itl') {
    // One scan per asset; the toggle applies to every read of these bytes.
    const remoteFetch = !hasBlockedRemoteUrl(bytes);
    const opts = { remoteFetch };
    const first = await engine.read(bytes, mime, buildSettings(anchors, 'c2pa', opts));
    if (!first) {
        return { handle: null, trust: { state: null, basis: null } };
    }

    const state1 = first.store && first.store.validation_state ? first.store.validation_state : null;

    if (state1 === 'Trusted') {
        return { handle: first, trust: { state: 'Trusted', basis: 'c2pa_trust_list' } };
    }

    if (state1 === 'Valid' && profile === 'c2pa') {
        // Official-list-only profile: no ITL fallback read.
        return { handle: first, trust: { state: 'Valid', basis: 'none' } };
    }

    if (state1 === 'Valid') {
        let second;
        try {
            second = await engine.read(bytes, mime, buildSettings(anchors, 'c2pa_and_itl', opts));
        } catch (e) {
            // The fallback read rejected: readC2paAsset never receives `first`,
            // so its finally cannot free it — dispose it here before rethrowing.
            await disposeQuietly(first);
            throw e;
        }
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
