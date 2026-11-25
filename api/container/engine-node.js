// c2pa-node engine adapter for the @c2pa-viewer/core engine seam.
// c2pa-node 0.12.x accepts camelCase Settings inside a Context; core passes the
// legacy snake_case c2pa-wasm settings shape, so this adapter performs the exact
// field mapping at the seam.

import { Reader, Context } from '@contentauth/c2pa-node';

function convertSettings(settings) {
    const legacy = settings && typeof settings === 'object' ? settings : {};
    const verifyTrust = legacy.verify && legacy.verify.verify_trust !== false;
    return {
        trust: {
            trustAnchors: legacy.trust ? legacy.trust.trust_anchors : undefined,
            trustConfig: legacy.trust ? legacy.trust.trust_config : undefined,
            verifyTrustList: verifyTrust,
        },
        verify: {
            verifyTrust,
        },
    };
}

function manifestCount(store) {
    return store && store.manifests ? Object.keys(store.manifests).length : 0;
}

export const nodeEngine = {
    async read(bytes, mime, settings) {
        let reader = await Reader.fromAsset({
            buffer: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
            mimeType: mime || 'image/jpeg',
        }, new Context(convertSettings(settings)));
        if (!reader) return null;
        const store = reader.json();
        if (!store || manifestCount(store) === 0) {
            reader = null;
            return null;
        }
        return {
            store,
            resourceToBytes: async (id) => {
                if (!reader) throw new Error('reader is disposed');
                const out = await reader.resourceToAsset(id, { buffer: null });
                return new Uint8Array(out.buffer);
            },
            // c2pa-node 0.12.1 exposes no explicit free(): NeonReader is a JS-boxed
            // native object whose Finalize/drop is garbage-collection driven. Clearing
            // the strong reference here is the only supported disposal path; the
            // one-job-one-container process lifetime bounds any residual native memory.
            dispose: async () => { reader = null; },
        };
    },
};
