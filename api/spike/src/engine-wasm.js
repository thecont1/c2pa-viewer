// c2pa-wasm engine adapter — implements the @c2pa-viewer/core engine seam
// on top of the raw @contentauth/c2pa-wasm WasmReader for the Workers runtime.
//
// Engine contract:
//   init()                              -> Promise<void> (rejects on init failure)
//   read(bytes, mime, settings|null)    -> Promise<null | {
//       store, resourceToBytes(id), dispose() }>
// `null` means "no manifest". `settings` is a plain object; it is serialized
// to the JSON string WasmReader.fromBlob expects as its context_json arg.

import { initSync, WasmReader } from '@contentauth/c2pa-wasm';
import wasmModule from '@contentauth/c2pa-wasm/c2pa.wasm';

// --- workerd polyfill -------------------------------------------------------
// The wasm-bindgen glue reads Blobs via `new FileReaderSync().readAsArrayBuffer(blob)`,
// a synchronous browser API that does not exist in workerd. We only ever pass Blobs
// we constructed ourselves from an ArrayBuffer we already hold, so a WeakMap gives
// us a synchronous stand-in for the read.
const blobBytes = new WeakMap();

class FileReaderSyncPolyfill {
  constructor() {
    this.result = null;
    this.error = null;
    this.readyState = 0;
  }
  _resolve(blob) {
    if (blobBytes.has(blob)) return blobBytes.get(blob);
    if (blob instanceof ArrayBuffer) return blob;
    if (ArrayBuffer.isView(blob)) {
      return blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
    }
    throw new Error('FileReaderSyncPolyfill: unknown blob source');
  }
  // web-sys binds FileReaderSync.readAs*() as returning the result value
  // directly (the JS method's return), so we return it in addition to
  // setting .result for spec-shaped callers.
  readAsArrayBuffer(blob) {
    this.result = this._resolve(blob);
    this.readyState = 2;
    return this.result;
  }
  readAsText(blob) {
    this.result = new TextDecoder().decode(this._resolve(blob));
    this.readyState = 2;
    return this.result;
  }
  readAsBinaryString(blob) {
    const u8 = new Uint8Array(this._resolve(blob));
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    this.result = s;
    this.readyState = 2;
    return this.result;
  }
  readAsDataURL(blob) {
    const bytes = this._resolve(blob);
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    this.result = `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
    this.readyState = 2;
    return this.result;
  }
}

if (typeof globalThis.FileReaderSync === 'undefined') {
  globalThis.FileReaderSync = FileReaderSyncPolyfill;
}

export function makeBlob(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  blobBytes.set(blob, bytes);
  return blob;
}

// ---------------------------------------------------------------------------

// Init once per isolate. initSync accepts a WebAssembly.Module directly;
// the package's default init() would try to fetch/instantiate via URL,
// which does not work for a CompiledWasm module binding.
let initState = null; // { promise, ms }

export function ensureInit() {
  if (!initState) {
    const t0 = performance.now();
    const promise = Promise.resolve().then(() => {
      initSync({ module: wasmModule });
      return performance.now() - t0;
    });
    initState = { promise, ms: null };
    promise.then(
      (ms) => {
        initState.ms = ms;
      },
      () => {
        initState = null; // allow retry on next request
      }
    );
  }
  return initState;
}

export function errMessage(e) {
  if (e instanceof Error) return e.message || e.name || String(e);
  return String(e);
}

export function manifestCount(store) {
  const m = store && store.manifests;
  if (!m) return 0;
  if (typeof m.size === 'number' && typeof m.keys === 'function') return m.size;
  return Object.keys(m).length;
}

function isNoManifestError(e) {
  // c2pa-rs reports a missing JUMBF box as C2pa(JumbfNotFound);
  // c2pa-web maps that to a null reader. Treat it as a clean "no manifest".
  return /jumbfnotfound/i.test(errMessage(e));
}

export const wasmEngine = {
  init: () => ensureInit().promise,

  async read(bytes, mime, settings) {
    await ensureInit().promise;
    const format = mime || 'image/jpeg';
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const blob = makeBlob(u8, format);

    let reader = null;
    try {
      reader = await WasmReader.fromBlob(
        format,
        blob,
        settings ? JSON.stringify(settings) : null
      );
    } catch (e) {
      if (isNoManifestError(e)) return null;
      throw e;
    }
    if (!reader) return null;

    let store;
    try {
      store = reader.manifestStore();
    } catch (e) {
      try { reader.free(); } catch { }
      if (isNoManifestError(e)) return null;
      throw e;
    }

    if (!store || manifestCount(store) === 0) {
      try { reader.free(); } catch { }
      return null;
    }

    return {
      store,
      // c2pa-wasm's resourceToBytes is synchronous; the core awaits it,
      // which is fine for a non-Promise return.
      resourceToBytes: (id) => reader.resourceToBytes(id),
      dispose: () => {
        try { reader.free(); } catch { }
      },
    };
  },
};
