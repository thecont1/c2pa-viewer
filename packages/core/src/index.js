// @c2pa-viewer/core — platform-free metadata analysis.
// No DOM, window, document, fetch, Blob/FileReader or wasm imports here.
// The C2PA engine is injected by each host (browser c2pa-web adapter,
// Cloudflare Worker c2pa-wasm adapter, ...).

export { analyzeBytes, buildExifEntry } from './analyze.js';
export { detectFormat, imageMime } from './detect.js';
export { bytesDimensions } from './dimensions.js';
export {
    bytesToBase64,
    activeManifest,
    emptyC2paResult,
    buildC2paResult,
    isVerifiedState,
    verificationLabel,
    formatProvenanceForWeb,
} from './c2pa.js';
export { extractExif, extractIptc, convertExifValue, EXIF_TAGS, EXIF_ALIASES, IPTC_MAP } from './exif.js';
export { formatPhotographyMetadata } from './photo.js';
export { formatDatetimeFull, formatClaimGenerator } from './format.js';
export { extractSocialLinks } from './social.js';
export { getDigitalSourceType, DIGITAL_SOURCE_TYPE_LABELS } from './dst.js';
export { buildSettings, resolveTrust, trustListsMeta, signerTrustLabel } from './trust.js';
