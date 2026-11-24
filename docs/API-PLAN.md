# c2pa-viewer API service: plan

Goal: offer the C2PA verifier as a commercial, machine-consumable service (REST, MCP, WebMCP) on Cloudflare, with no VM.

Architecture in one line: a Gateway Worker (Hono) does auth, rate limiting and CORS, then runs C2PA WASM for small files inline or sends large files through R2 + Queue to a Container running native c2pa-rs. One platform-free core produces the response JSON for every engine, and REST, MCP and WebMCP are thin layers over it.

Tick a box only when its exit criterion is demonstrably met.

## Phase 0: Foundations

- [x] **P0.1 Worker spike.** The raw `@contentauth/c2pa-wasm` `WasmReader` runs inside a Workers runtime (`wrangler dev`). Cold start and peak memory are measured at ~5, ~15 and ~25 MB assets, and the sync-size cap is chosen from the numbers.
- [x] **P0.2 Trust anchors.** The official C2PA trust list is located, loaded through `loadSettings`, and a signed fixture can reach `Trusted` (or the reason it cannot is documented). Trust-list loading is a reusable module.
- [x] **P0.3 Shared core.** Formatting logic is extracted from `src/compute.js` into a platform-free `packages/core` (no DOM, no Worker bindings, no fetch). The viewer bundle still builds and behaves the same.
- [x] **P0.4 OpenAPI first.** `openapi.yaml` (3.1) describes `/v1/verify`, `/v1/jobs`, `/v1/jobs/{id}`, `/v1/verify/mini`, `/v1/trust-lists`, errors, auth and rate-limit headers, and lints clean.
- [x] **P0.5 Parity.** A fixture corpus (A.jpg unsigned, C.jpg signed, C_with_CAWG_data.jpg, cloud.jpg, DSCF9243.jpg, plus an invalid or tampered fixture) produces identical JSON from the browser viewer path and the Worker path. A test runs this automatically.
- [x] **P0 exit.** All of the above ticked, findings written to the "Phase 0 findings" section below, committed on `feat/api-phase0`.

### Phase 0 findings

**P0.1 Worker spike** (`docs/spike-results.json`, harness in `api/spike/`)
- `@contentauth/c2pa-wasm@0.11.6` `WasmReader` runs on real Workers. It needs `initSync({ module })` with a CompiledWasm import and a ~55-line `FileReaderSync` polyfill (`api/spike/src/engine-wasm.js`); no other missing globals on the read path.
- Peak memory is about 4x the input size, and isolate memory only ratchets up (wasm linear memory never shrinks). Deployed ceiling: 25 and 30 MiB inputs passed 3/3, 35 and 40 MiB failed 3/3 with the 1102 "exceeded resource limits" page (128 MB isolate limit).
- **Decision: sync cap is 20 MiB** (headroom for the ratchet across requests on a warm isolate). Anything larger goes through `/v1/jobs`. Phase 1 should also consider recycling isolates after big reads.
- `performance.now()` and `Date.now()` do not advance during synchronous CPU on deployed workerd, so in-Worker timings are 0. Use client-side wall time or Workers analytics.
- Caveat: the deployed run used a temporary preview account, not the production account's plan. Re-run `scripts/spike-measure.mjs --url` once the real API Worker exists.
- cloud.jpg (remote manifest) resolves on Workers: outbound fetch to the manifest host works.

**P0.2 Trust**
- Settings are per reader: `WasmReader.fromBlob(mime, blob, contextJson)` / c2pa-web `reader.fromBlob(fmt, blob, settings)`. The global `loadSettings` has no effect on readers.
- With the official C2PA list alone, Adobe-signed files stay Valid but untrusted; they chain to the frozen Interim Trust List (ITL). Trusted needs the ITL. The result therefore reports `trust.basis` (`c2pa_trust_list` | `interim_trust_list` | `none`), as the C2PA spec requires validators to distinguish them.
- Vendored in `trust/` with `meta.json` (C2PA list pinned at upstream commit 285d98e4b575, 2026-11-20); refresh with `scripts/update-trust-lists.mjs`. The viewer fetches them from `vendor/trust/` and fails loudly if they cannot be loaded.
- Not yet proven: Trusted via the official C2PA list alone, because no fixture is signed by a conforming product from that list (for example a Pixel or Samsung photo). Add one when available.
- Test-cert fixtures (C.jpg, C_with_CAWG_data.jpg) are Valid/untrusted under every profile, as expected.

**P0.3 Shared core**
- `packages/core` is platform-free; engines plug in through `engine.read(bytes, mime, settings)`. The viewer adapter wraps c2pa-web, the Worker adapter wraps c2pa-wasm.
- `scripts/golden.mjs` captured 20 pre-refactor outputs from the live viewer; post-refactor output is byte-identical apart from the new additive `trust` key and a "Signer Trust" provenance row. `bytesDimensions` matched `createImageBitmap` on every fixture.

**P0.4 OpenAPI** (`api/openapi.yaml`, mapper `packages/core/src/api-result.js`)
- Redocly lint: 0 errors, 1 allowlisted warning. All 18 embedded examples, 6 mini goldens, and live responses for 6 corpus files plus full-include variants validate against the schema (ajv 2020-12).
- GPS is stripped by default; GPS keys cannot reach `metadata.exif` by construction. No fixture contains GPS, so the on-wire strip is covered by a synthetic test only.

**P0.5 Parity**
- Worker `/verify` equals the browser goldens for all 6 fixtures (c2pa and exif deep-equal). The only normalized difference is human-formatted provenance dates, which render in the runtime's timezone (browser local vs UTC on workerd).
- **Follow-up for Phase 1:** provenance rows carry display strings, not ISO timestamps. The API should expose ISO values (`signer.signed_at` already does) and treat the display strings as non-contractual.

Run everything with `bun run test` (golden check + parity + OpenAPI).

## Phase 1: Sync API MVP

- [ ] `api.` Worker scaffold (Hono, wrangler config, CI deploy)
- [ ] `POST /v1/verify` accepting multipart, base64 JSON and `url` input
- [ ] SSRF guard and magic-byte MIME sniffing shared with `functions/api/img.js`
- [ ] API keys: format, hashed storage in D1, scopes, rotate and revoke
- [ ] Rate limiting binding plus `RateLimit-*` and `Retry-After` headers
- [ ] Per-key CORS allowlist and preflight caching
- [ ] Contract tests against `openapi.yaml`
- [ ] Load test (k6) with memory and CPU budget recorded

## Phase 2: MCP

- [ ] `McpAgent` at `/mcp` (Streamable HTTP)
- [ ] Tools: `verify_image`, `verify_image_detailed`, `submit_verification_job`, `get_verification_job`, `explain_validation_code`
- [ ] OAuth 2.1 plus bearer API keys
- [ ] Verified from at least two real MCP clients
- [ ] Registry and directory listings

## Phase 3: Async jobs

- [ ] R2 presigned upload and 24 h lifecycle rule
- [ ] Queue, consumer Worker, dead-letter queue
- [ ] Container with native c2pa-rs (streaming), returns raw manifest JSON
- [ ] `POST /v1/jobs`, `GET /v1/jobs/{id}`
- [ ] HMAC-signed webhooks with retry and backoff
- [ ] A 200 MB+ file verifies end to end

## Phase 4: Commercial layer

- [ ] Usage metering in D1 and per-key quota Durable Object
- [ ] Stripe metered billing
- [ ] Customer dashboard (keys, usage)
- [ ] Docs site and generated SDKs (TypeScript, Python)
- [ ] Terms of service, DPA, retention statement
- [ ] First paying key

## Phase 5: Extras (demand-driven)

- [ ] WebMCP tools in the Pages viewer
- [ ] Connect-RPC / gRPC
- [ ] Signed verification results
- [ ] Video, PDF and audio formats
- [ ] Batch endpoint
- [ ] Per-tenant white-label configuration

## Open decisions

- API hostname: `api.c2pa.thecontrarian.in` vs a neutral product domain
- Container engine: native Rust (preferred) vs Node `c2pa-node`
- ~~Sync size cap~~ decided: 20 MiB (see Phase 0 findings)
