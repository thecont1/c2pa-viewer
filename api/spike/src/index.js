import { WasmReader } from '@contentauth/c2pa-wasm';
import { analyzeBytes, toApiResult } from '../../../packages/core/src/index.js';
import { wasmEngine, ensureInit, makeBlob, errMessage, manifestCount } from './engine-wasm.js';

// Trust lists are bundled as text modules (wrangler `rules`, see wrangler.jsonc).
import c2paTrustPem from '../../../trust/C2PA-TRUST-LIST.pem';
import itlTrustPem from '../../../trust/ITL-anchors.pem';
import trustConfig from '../../../trust/store.cfg';
import trustMeta from '../../../trust/meta.json';

const TRUST_ANCHORS = {
  c2pa: c2paTrustPem,
  itl: itlTrustPem,
  config: trustConfig,
  meta: trustMeta,
};

const ENGINE_INFO = { name: 'c2pa-wasm', version: '0.11.6' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    // Full analysis: same JSON shape as the viewer's c2paMetadata, plus the
    // EXIF entry under `exif`. Runs the trust-profile reads against the
    // vendored C2PA + Interim trust lists.
    if (url.pathname === '/verify' && request.method === 'POST') {
      const mime = request.headers.get('x-mime') || 'image/jpeg';
      const filename = request.headers.get('x-filename') || 'image';
      const bytes = new Uint8Array(await request.arrayBuffer());
      try {
        const { exif, c2pa } = await analyzeBytes({
          bytes,
          mime,
          filename,
          contentType: mime,
          engine: wasmEngine,
          trust: { anchors: TRUST_ANCHORS },
          include: { exif: true, c2pa: true },
        });
        return Response.json({ ...c2pa, exif });
      } catch (e) {
        return Response.json({ ok: false, error: errMessage(e) }, { status: 500 });
      }
    }

    // Public-API-shaped result: runs analyzeBytes then maps through
    // toApiResult. Test harness for the /v1 contract — same wire input as
    // /verify (raw body + x-mime/x-filename) plus query options:
    //   ?include=exif,iptc,gps,thumbnails,raw_manifest  (default exif,iptc)
    //   ?strip_gps=false
    //   ?trust=c2pa|c2pa_and_itl  (default c2pa_and_itl; selects the trust
    //     profile exactly like the production /v1/verify surface)
    if (url.pathname === '/v1-verify' && request.method === 'POST') {
      const mime = request.headers.get('x-mime') || 'image/jpeg';
      const filename = request.headers.get('x-filename') || 'image';
      const bytes = new Uint8Array(await request.arrayBuffer());
      const include = (url.searchParams.get('include') || 'exif,iptc')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const stripGps = url.searchParams.get('strip_gps') !== 'false';
      try {
        const trustParam = url.searchParams.get('trust');
        const analysis = await analyzeBytes({
          bytes,
          mime,
          filename,
          contentType: mime,
          engine: wasmEngine,
          trust: { anchors: TRUST_ANCHORS },
          trustProfile: trustParam === 'c2pa' ? 'c2pa' : 'c2pa_and_itl',
          include: { exif: true, c2pa: true },
        });
        return Response.json(toApiResult(analysis, {
          id: `ver_${crypto.randomUUID()}`,
          engine: ENGINE_INFO,
          include,
          strip_gps: stripGps,
        }));
      } catch (e) {
        return Response.json({ ok: false, error: errMessage(e) }, { status: 500 });
      }
    }

    if (url.pathname !== '/read' || request.method !== 'POST') {
      return Response.json({ ok: false, error: 'not found' }, { status: 404 });
    }

    const mime = request.headers.get('x-mime') || 'image/jpeg';
    // Optional per-call reader settings as a JSON string (same context_json
    // argument WasmReader.fromBlob takes). Replaces the old /settings global.
    const settingsJson = request.headers.get('x-settings') || null;
    const bytes = await request.arrayBuffer();

    const state = ensureInit();
    // `cold` is true only for the request that actually ran initSync.
    const wasCold = state.ms === null;
    let initMs = state.ms;
    try {
      initMs = await state.promise;
    } catch (e) {
      return Response.json({
        ok: false,
        bytes: bytes.byteLength,
        cold: wasCold,
        init_ms: null,
        read_ms: null,
        error: `init failed: ${errMessage(e)}`,
      });
    }

    const t0 = performance.now();
    let reader = null;
    try {
      const blob = makeBlob(bytes, mime);
      reader = await WasmReader.fromBlob(mime, blob, settingsJson);
      const store = reader.manifestStore();
      const readMs = performance.now() - t0;

      if (!store || manifestCount(store) === 0) {
        return Response.json({
          ok: true,
          bytes: bytes.byteLength,
          cold: wasCold,
          init_ms: initMs,
          read_ms: readMs,
          validation_state: store ? (store.validation_state ?? null) : null,
          active_manifest: store ? (store.active_manifest ?? null) : null,
          manifest_count: 0,
        });
      }

      return Response.json({
        ok: true,
        bytes: bytes.byteLength,
        cold: wasCold,
        init_ms: initMs,
        read_ms: readMs,
        validation_state: store.validation_state ?? null,
        active_manifest: store.active_manifest ?? reader.activeLabel() ?? null,
        manifest_count: manifestCount(store),
        ...(url.searchParams.get('full') ? { store } : {}),
      });
    } catch (e) {
      const msg = errMessage(e);
      // c2pa-rs reports a missing JUMBF box as C2pa(JumbfNotFound);
      // c2pa-web maps that to a null reader. Treat it as a clean
      // "no manifest" result rather than an error.
      if (/jumbfnotfound/i.test(msg)) {
        return Response.json({
          ok: true,
          bytes: bytes.byteLength,
          cold: wasCold,
          init_ms: initMs,
          read_ms: performance.now() - t0,
          validation_state: null,
          active_manifest: null,
          manifest_count: 0,
        });
      }
      return Response.json({
        ok: false,
        bytes: bytes.byteLength,
        cold: wasCold,
        init_ms: initMs,
        read_ms: performance.now() - t0,
        error: msg,
      });
    } finally {
      if (reader) {
        try {
          reader.free();
        } catch {}
      }
    }
  },
};
