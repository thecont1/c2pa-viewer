# c2pa-viewer API service: plan

Goal: offer the C2PA verifier as a commercial, machine-consumable service (REST, MCP, WebMCP) on Cloudflare, with no VM.

Architecture in one line: a Gateway Worker (Hono) does auth, rate limiting and CORS, then runs C2PA WASM for small files inline or sends large files through R2 + Queue to a Container running native c2pa-rs. One platform-free core produces the response JSON for every engine, and REST, MCP and WebMCP are thin layers over it.

Tick a box only when its exit criterion is demonstrably met.

## Phase 0: Foundations

- [ ] **P0.1 Worker spike.** The raw `@contentauth/c2pa-wasm` `WasmReader` runs inside a Workers runtime (`wrangler dev`). Cold start and peak memory are measured at ~5, ~15 and ~25 MB assets, and the sync-size cap is chosen from the numbers.
- [ ] **P0.2 Trust anchors.** The official C2PA trust list is located, loaded through `loadSettings`, and a signed fixture can reach `Trusted` (or the reason it cannot is documented). Trust-list loading is a reusable module.
- [ ] **P0.3 Shared core.** Formatting logic is extracted from `src/compute.js` into a platform-free `packages/core` (no DOM, no Worker bindings, no fetch). The viewer bundle still builds and behaves the same.
- [ ] **P0.4 OpenAPI first.** `openapi.yaml` (3.1) describes `/v1/verify`, `/v1/jobs`, `/v1/jobs/{id}`, `/v1/verify/mini`, `/v1/trust-lists`, errors, auth and rate-limit headers, and lints clean.
- [ ] **P0.5 Parity.** A fixture corpus (A.jpg unsigned, C.jpg signed, C_with_CAWG_data.jpg, cloud.jpg, DSCF9243.jpg, plus an invalid or tampered fixture) produces identical JSON from the browser viewer path and the Worker path. A test runs this automatically.
- [ ] **P0 exit.** All of the above ticked, findings written to the "Phase 0 findings" section below, committed on `feat/api-phase0`.

### Phase 0 findings

_(filled in as the checkpoints complete)_

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
- Sync size cap: set from P0.1 measurements
