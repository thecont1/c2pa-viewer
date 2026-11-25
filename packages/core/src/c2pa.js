// C2PA manifest extraction, thumbnails, provenance formatting.
// Ported from src/compute.js; the engine seam replaces the c2pa-web singleton.
//
// Engine contract (see analyze.js):
//   engine.init?.()                    -> Promise<void>  (rejects on init failure)
//   engine.read(bytes, mime, settings) -> Promise<null | {
//       store,                         // ManifestStore-shaped object
//       resourceToBytes(id) -> Promise<Uint8Array>,
//       dispose() -> void | Promise<void>,
//     }>
// `null` means "no manifest". Read-level problems may throw — analyzeBytes
// catches them and emits the empty result, matching the old behaviour where
// only SDK init failures propagated.

import { extractSocialLinks } from './social.js';
import { getDigitalSourceType } from './dst.js';
import { formatClaimGenerator, formatDatetimeFull } from './format.js';
import { readWithTrustProfiles, trustListsMeta, signerTrustLabel } from './trust.js';

export function bytesToBase64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export function activeManifest(store) {
    const label = store && store.active_manifest;
    const manifests = (store && store.manifests) || {};
    if (!label) return null;
    if (typeof manifests.get === 'function') {
        const m = manifests.get(label);
        return m === undefined ? null : m;
    }
    if (!(label in manifests)) return null;
    return manifests[label];
}

// ---------------------------------------------------------------------------
// ManifestStore -> c2paData (was extractC2paData)
// ---------------------------------------------------------------------------

function extractManifestData(store) {
    const manifest = activeManifest(store);
    if (!manifest) return null;

    const result = {
        basic_info: {
            title: manifest.title ?? null,
            format: manifest.format ?? null,
            instance_id: manifest.instance_id ?? null,
            claim_generator: manifest.claim_generator ?? null,
        },
        signature_info: manifest.signature_info || {},
        validation_state: store.validation_state ?? null,
        assertions: [],
        ingredients: [],
        actions: [],
        author_info: {},
        digital_source_type: null,
    };

    // C2PA actions live in either the c2pa.actions.v2 assertion or the
    // original unversioned c2pa.actions one. v2 supersedes v1, so when both
    // are present the v2 assertion wins; otherwise accept whichever exists.
    const actionAssertions = (manifest.assertions || []).filter(
        (a) => a && (a.label === 'c2pa.actions.v2' || a.label === 'c2pa.actions')
    );
    const v2 = actionAssertions.find((a) => a.label === 'c2pa.actions.v2');
    const actionsSource = v2 || actionAssertions[0] || null;

    for (const assertion of manifest.assertions || []) {
        const label = assertion.label || 'Unknown';
        const assertionData = assertion.data || {};
        result.assertions.push({ label, data: assertionData });

        if (actionsSource && assertion === actionsSource) {
            for (const action of assertionData.actions || []) {
                result.actions.push({
                    action: action.action ?? null,
                    when: action.when ?? null,
                    softwareAgent: action.softwareAgent ?? null,
                    parameters: action.parameters || {},
                });
            }
        } else if (label === 'stds.schema-org.CreativeWork') {
            result.author_info = assertionData;
            result.author_info.social_links = extractSocialLinks(assertionData);
        }
    }

    for (const ingredient of manifest.ingredients || []) {
        result.ingredients.push({
            title: ingredient.title ?? null,
            format: ingredient.format ?? null,
            relationship: ingredient.relationship ?? null,
            instance_id: ingredient.instance_id ?? null,
        });
    }

    const [code, label2] = getDigitalSourceType(result);
    result.digital_source_type = { code, label: label2 };
    return result;
}

async function extractThumbnails(manifest, resourceToBytes) {
    const thumbnails = {};
    if (!manifest || !resourceToBytes) return thumbnails;

    const claimThumb = manifest.thumbnail;
    if (claimThumb && typeof claimThumb === 'object' && claimThumb.identifier) {
        try {
            const bytes = await resourceToBytes(claimThumb.identifier);
            thumbnails.claim_thumbnail = bytesToBase64(bytes);
        } catch (e) {
            console.warn('claim thumbnail failed:', e);
        }
    }

    const ingredients = manifest.ingredients || [];
    if (ingredients.length > 0) {
        const ingThumb = ingredients[0] && ingredients[0].thumbnail;
        if (ingThumb && typeof ingThumb === 'object' && ingThumb.identifier) {
            try {
                const bytes = await resourceToBytes(ingThumb.identifier);
                thumbnails.ingredient_thumbnail = bytesToBase64(bytes);
            } catch (e) {
                console.warn('ingredient thumbnail failed:', e);
            }
        }
    }
    return thumbnails;
}

// The shape c2paMetadata returns when there is no manifest (or extraction
// failed): callers rely on these exact null/empty fields.
export function emptyC2paResult() {
    return {
        provenance: [],
        c2pa_data: null,
        author_info: null,
        thumbnails: {},
        digital_source_type: null,
    };
}

// Normalize one validation_results entry to the public Code shape
// {code, explanation, url?} — url is omitted when absent.
function cleanCode(entry) {
    const out = {
        code: entry && entry.code !== undefined ? entry.code : null,
        explanation: entry && entry.explanation !== undefined ? entry.explanation : null,
    };
    if (entry && entry.url) out.url = entry.url;
    return out;
}

// Manifest-store validation detail -> { state, results }.
// results buckets come from store.validation_results.activeManifest verbatim;
// any code present in the flat store.validation_status list but missing from
// all buckets is appended to `failure` (validation_status only carries
// problem-level codes — verified against the fixture corpus).
export function extractValidation(store) {
    if (!store) return null;
    const vr = (store.validation_results && store.validation_results.activeManifest) || {};
    const results = {
        success: (vr.success || []).map(cleanCode),
        informational: (vr.informational || []).map(cleanCode),
        failure: (vr.failure || []).map(cleanCode),
    };
    const seen = new Set(
        [...results.success, ...results.informational, ...results.failure]
            .map((e) => `${e.code}${e.url || ''}`)
    );
    for (const st of store.validation_status || []) {
        if (!st || st.code === undefined || st.code === null) continue;
        const key = `${st.code}${st.url || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.failure.push(cleanCode(st));
    }
    return {
        state: store.validation_state ?? null,
        results,
    };
}

// Read + extract everything analyzeBytes needs for one asset in a single
// pass. Returns { result, validation, manifestLabel }:
//   result        — the c2paMetadata-shaped object (may be the empty shape)
//   validation    — extractValidation(store), null when no manifest
//   manifestLabel — store.active_manifest, null when no manifest
// `settings` is passed through to engine.read when no trust anchors are
// given; `trust.anchors` switches to the trust-profile reads.
// `trustProfile` ('c2pa'|'c2pa_and_itl', default 'c2pa_and_itl') selects
// which lists may produce a Trusted verdict — 'c2pa' skips the ITL read.
export async function readC2paAsset({ bytes, mime, engine, settings = null, trust = null, trustProfile = 'c2pa_and_itl' }) {
    const anchors = trust && trust.anchors ? trust.anchors : null;

    let handle;
    let trustInfo = null;
    if (anchors) {
        const res = await readWithTrustProfiles(engine, bytes, mime, anchors, trustProfile);
        handle = res.handle;
        trustInfo = { ...res.trust, lists: trustListsMeta(anchors) };
    } else {
        handle = await engine.read(bytes, mime, settings);
    }

    if (!handle) {
        const empty = emptyC2paResult();
        if (anchors) empty.trust = trustInfo;
        return { result: empty, validation: null, manifestLabel: null };
    }

    const { store, resourceToBytes, dispose } = handle;
    try {
        const manifestLabel = store && store.active_manifest ? store.active_manifest : null;
        const validation = extractValidation(store);

        const manifest = activeManifest(store);
        if (!manifest) {
            const empty = emptyC2paResult();
            if (anchors) empty.trust = trustInfo;
            return { result: empty, validation, manifestLabel };
        }

        const c2paData = extractManifestData(store);
        if (!c2paData) {
            const empty = emptyC2paResult();
            if (anchors) empty.trust = trustInfo;
            return { result: empty, validation, manifestLabel };
        }

        const thumbnails = await extractThumbnails(manifest, resourceToBytes);

        const result = {
            provenance: formatProvenanceForWeb(c2paData),
            c2pa_data: c2paData,
            author_info: c2paData.author_info,
            thumbnails,
            digital_source_type: c2paData.digital_source_type,
        };
        // The trust key exists only when trust anchors were supplied —
        // without them the result shape is identical to the pre-trust one.
        if (anchors) {
            result.trust = trustInfo;
            // Surface the verdict as a provenance row just ahead of the
            // trailing Verification entry (which renderers pin last).
            const label = signerTrustLabel(trustInfo);
            if (label) {
                result.provenance.splice(
                    Math.max(0, result.provenance.length - 1), 0,
                    { name: 'Signer Trust', trust: label }
                );
            }
        }
        return { result, validation, manifestLabel };
    } finally {
        if (dispose) {
            try { await dispose(); } catch { }
        }
    }
}

// Read + extract the full c2pa result for one asset. `settings` is passed
// through to engine.read when no trust anchors are given; `trust.anchors`
// switches to the trust-profile reads and adds a `trust` key to the result.
export async function buildC2paResult(args) {
    const { result } = await readC2paAsset(args);
    return result;
}

// ---------------------------------------------------------------------------
// Verification labels + provenance (verbatim ports)
// ---------------------------------------------------------------------------

// C2PA validation states that permit a "verified" label. Anything else —
// including Invalid and absent states — must not claim verification.
export function isVerifiedState(validationState) {
    return validationState === 'Valid' || validationState === 'Trusted';
}

export function verificationLabel(validationState) {
    if (validationState === 'Valid' || validationState === 'Trusted') return 'Signature Valid';
    if (validationState === 'Invalid') return 'Signature Invalid';
    return 'Not Verified';
}

export function formatProvenanceForWeb(c2paData) {
    const provenance = [];
    if (!c2paData) return provenance;

    const basic = c2paData.basic_info || {};
    if (basic.claim_generator) {
        provenance.push({ name: 'Claim Generator', generator: formatClaimGenerator(basic.claim_generator) });
    }

    const sigInfo = c2paData.signature_info || {};
    if (sigInfo.issuer) {
        provenance.push({ name: 'Issued By', issuer: sigInfo.issuer });
    }

    if (sigInfo.time) {
        provenance.push({ name: 'Issued On', date: formatDatetimeFull(sigInfo.time, true) });

        const authorInfo = c2paData.author_info || {};
        if ('name' in authorInfo) provenance.push({ name: 'Title', title: authorInfo.name });
        if ('description' in authorInfo) provenance.push({ name: 'Description', data: authorInfo.description });
        if ('keywords' in authorInfo) {
            let keywords = authorInfo.keywords;
            if (Array.isArray(keywords)) keywords = keywords.join(', ');
            provenance.push({ name: 'Keywords', data: keywords });
        }

        if ('author' in authorInfo) {
            const authors = authorInfo.author;
            if (Array.isArray(authors) && authors.length > 0) {
                const author = authors[0] || {};
                const worksFor = author.worksFor;
                const authorData = {
                    name: author.name !== undefined ? author.name : 'Unknown',
                    identifier: author.identifier ?? null,
                    url: author.url ?? null,
                    sameAs: author.sameAs ?? [],
                    email: author.email ?? null,
                    telephone: author.telephone ?? null,
                    address: author.address ?? null,
                    jobTitle: author.jobTitle ?? null,
                    worksFor: worksFor && typeof worksFor === 'object' ? (worksFor.name ?? null) : (worksFor ?? null),
                    social_links: authorInfo.social_links || {},
                };
                provenance.push({ name: 'Author', author: authorData.name, author_details: authorData });
            }
        }

        if ('copyrightHolder' in authorInfo) {
            const holders = authorInfo.copyrightHolder;
            if (Array.isArray(holders) && holders.length > 0) {
                provenance.push({ name: 'Copyright', copyright: (holders[0] || {}).name || 'Unknown' });
            }
        }

        if ('publisher' in authorInfo) {
            const publisher = authorInfo.publisher;
            if (publisher && typeof publisher === 'object') {
                provenance.push({ name: 'Publisher', publisher: publisher.name || 'Unknown' });
            }
        }
    }

    for (const action of c2paData.actions || []) {
        const actionItem = {
            name: 'Action',
            action: action.action,
            software: action.softwareAgent ?? null,
            parameters: action.parameters || {},
        };
        if (action.when) actionItem.when = formatDatetimeFull(action.when, true);
        provenance.push(actionItem);
    }

    provenance.push({
        name: 'Verification',
        verification: verificationLabel(c2paData.validation_state)
    });

    return provenance;
}
