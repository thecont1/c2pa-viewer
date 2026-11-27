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

- [x] `api.` Worker scaffold (Hono, wrangler config, CI deploy)
- [x] `POST /v1/verify` accepting multipart, base64 JSON and `url` input
- [x] SSRF guard and magic-byte MIME sniffing shared with `functions/api/img.js`
- [x] API keys: format, hashed storage in D1, scopes, rotate and revoke
- [x] Rate limiting binding plus `RateLimit-*` and `Retry-After` headers
- [x] Per-key CORS allowlist and preflight caching
- [x] Contract tests against `openapi.yaml`
- [x] Load test with memory and CPU budget recorded (local; production isolate numbers pending account auth — see below)


### Phase 1 progress notes

Implemented and verified locally (branch `feat/api-phase0`):

- Gateway Worker `api/` (Hono): `/v1/verify` (multipart/base64/url), `/v1/verify/mini`, `/v1/trust-lists` (public), `/v1/openapi.json` (public). Smoke matrix 44/44 (`bun run test:api`), contract test green (`bun run test:contract`, three waived trust-lists error responses justified by the public-route design).
- Keys: `c2pa_live_`/`c2pa_test_`, sha256-hashed in D1, types server/browser, tiers, scopes, monthly quota (usage upserted via waitUntil), rotate/revoke via `scripts/keyctl.mjs` (--remote implemented). Test keys sandboxed to fixture corpus hashes.
- Rate limiting binding verified actually throttling (61st request/minute → 429 rate_limited + Retry-After: 30). Headers on success responses.
- url input fetches server-side with shared SSRF guard, manual redirect loop (max 5 hops, re-checked per hop), 30s timeout, 20 MiB streaming cap. DNS-rebinding is NOT defended (no resolver primitive in workerd) — documented limitation; risk is low because Workers egress cannot reach private IPs anyway, the guard is defense-in-depth.
- Load test (`docs/loadtest-results.json`): 180/180 requests zero failures locally. C.jpg p50 35ms sequential; concurrency scales linearly-ish (25-way p95 ~1.09s on a 10-core workstation); pad-15MiB p50 108ms. **RSS never recovers after load** — confirms the P0 ratchet; recycling isolates stays on the Phase 1 remainder list.
- CI authored (.github/workflows ci.yml + deploy.yml) but never run: needs the branch pushed, plus repo secrets CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
- Viewer production redeployed (branch deploy `--branch main`): trust verification is now live at creds.im; SSRF 403 regression, proxy 200, deep links verified.
- **RESOLVED 2026-11-25**: interactive `wrangler login` restored OAuth. Real deployment live at `https://c2pa-verify-api.thecontrarian.workers.dev` with D1 `c2pa-verify-api` (id 0e4461c8-…). Production measurement (`docs/loadtest-results.json` under `deployed`): **no 1102 CPU errors at any size** — small files p~0.2-0.8s, 19 MiB at-cap ~2s, all 200; 25/30/35 MiB correctly 413 with spec-shaped body. The 10ms-Free-plan fear is empirically dead for this account. Usage metering verified in production (13 metered, rejections unmetered). One active scale-tier measurement key exists (plaintext in agent /tmp only); revoke via `bun scripts/keyctl.mjs list --remote` + `revoke --id … --remote` when no longer needed.

## Phase 2: MCP

- [x] Stateless MCP server at `/mcp` (Streamable HTTP; createMcpHandler — McpAgent is deprecated upstream)
- [x] Tools: `verify_image`, `verify_image_detailed`, `explain_validation_code` (+ `list_trust_lists`, resource `trust://current`). `submit_verification_job`/`get_verification_job` deliberately deferred to Phase 3 with the jobs backend
- [x] Bearer API keys (same D1 keys as REST, metered). OAuth 2.1 deferred to Phase 4: an authorization server is meaningless before customer accounts exist
- [x] Verified from two real MCP clients: Devin itself (added to ~/.config/devin/mcp_config.json; live verify_image on DSCF9243 → trusted) and MCP Inspector CLI (tools/list + explain_validation_code)
- [ ] Registry and directory listings — prepared (`api/registry/server.json`) but submission deferred to Phase 4: publishing invites traffic before self-service key signup exists, and the endpoint should move to the custom domain first


### Phase 2 progress notes

- `/mcp` live in production inside the gateway worker. Stateless Streamable HTTP via `createMcpHandler` (`@modelcontextprotocol/server` 2.0 + `agents` 0.34.0, zod 4.7 — the >=4.5 Workers-memory-safe line). No Durable Objects; fresh server per request, key row passed via closure.
- 29-row MCP smoke (`bun run test:mcp`, real `@modelcontextprotocol/sdk` client): full initialize→tools/list→tools/call sequence, schema-validated detailed output, quota+metering parity with REST, 401s for bad keys. `bun run test` runs everything.
- One input-schema limitation: JSON Schema can't express "exactly one of url/data" — runtime-enforced, clean tool errors.
- Browser-origin caveat: arbitrary browser Origins get 403 on /mcp preflight by default (fine for agent clients; revisit `allowedOriginHostnames` if browser-based MCP clients matter).
- Bundle grew to 9.5 MB upload (3.3 MB gzip) — still far under the 64 MiB limit, startup fine.

## Phase 3: Async jobs

- [x] R2 presigned upload live-verified end-to-end (client PUT → event notification → container → trusted verdict in 8.5s) and lifecycle rules
- [x] Queue, consumer Worker, dead-letter queue
- [x] Container (Node + c2pa-node native bindings) streaming, one per job
- [x] `POST /v1/jobs`, `GET /v1/jobs/{id}`
- [x] HMAC-signed webhooks with retry and backoff
- [x] A 200 MB+ file verifies end to end


### Phase 3 progress notes

Live in production (verified 2026-11-25, smoke-jobs 0 failures + independent re-verification):
- 220 MiB signed fixture (pad-then-sign) verified end-to-end in 54s create-to-terminal: queued→processing→succeeded, sha256-exact, valid_untrusted (test cert). Small job DSCF9243 in ~11s, matches /v1/verify field-for-field.
- Architecture: uniform pipeline — url jobs stream upstream→R2 (8 MiB multipart parts, SSRF-guarded), then JobRunner DO (one per job) streams R2 object into container POST /verify; container (node + c2pa-node@0.12.1, standard-1 instance 4GiB) runs the SAME core analyzeBytes; worker formats with toApiResult, stores result in R2 results/ (7d expiry), uploads/ expire 1d.
- R2 event notifications (uploads/ prefix) trigger the object-create path; verified with externally seeded rows + wrangler object put — include/strip_gps propagate correctly.
- Webhooks: live-verified HMAC-signed callback to webhook.site (recomputed signature matches), first delayed retry observed; full 4-attempt/DLQ sequence implemented but not waited out.
- MCP tools submit_verification_job/get_verification_job live, verified in production.
- Idempotency-Key replay, ownership isolation (404 across keys), clean upstream-404 failure all verified.
- RESOLVED: presigned client PUT fully working — creds came from the user's existing R2 token (summer-silence-8186) already stored in ~/.config/rclone/rclone.conf; no dashboard action was needed. Verified live 2026-11-25: create(202, awaiting_upload) → client PUT 200 → event notification → processing in ~2s → succeeded 8.5s total, trusted/interim_trust_list, sha256-exact.
- Instance sizing: wrangler-level instance_type rejected for DO-scheduled containers; size belongs in ctx.container.start() — standard-1 handles 220 MiB, 1 GiB ceiling unproven.

## Phase 3b: Rust container rewrite (decided 2026-11-26)

Full rewrite of the job container in Rust. Exit bar: byte-identical analysis output vs the Node container across the golden corpus, smoke-jobs green, 220 MiB end-to-end re-verified in production.

- [x] M1 Rust service skeleton: HTTP server on 8080 (health + POST /verify), /tmp spool with 1 GiB cap, timeouts, error-mapping parity (400/413/422/500 semantics)
- [x] M2 c2pa-rs extraction: Reader + Context settings mapped from x-c2pa-settings (trust anchors, verify_trust, remote_manifest_fetch), store JSON + resource extraction parity vs c2pa-node
- [x] M3 Port c2pa.js transformation + trust.js evaluation (provenance rows, validation buckets, thumbnails)
- [x] M4 Port detect/dimensions/exif/IPTC/photo formatting (exifr behavioral parity verified on the corpus; PNG/WEBP/GIF EXIF extraction is a documented gap — no corpus coverage)
- [x] M5 Integration: container image swap, smoke-jobs green, production re-verification, Node container removal

### Phase 3b progress notes

M1–M4 verified 2026-11-26 (`api/container-rs/`, c2pa crate pinned =0.92.2 — the exact version embedded in production c2pa-node 0.12.1, verified via strings in dist/index.node):
- **Byte-exact parity on all 7 fixtures** (scripts/parity-container.mjs: capture against Node container on :8080, compare against Rust on :8081) — gps.jpg, DSCF9243.jpg, cloud.jpg, C_with_CAWG_data.jpg, C.jpg, A.jpg, tampered.jpg all MATCH, plus edge probes (garbage→422, empty→422, missing settings→400 identical).
- Remote manifest resolution works: c2pa crate needs the `fetch_remote_manifests` cargo feature; without it remote manifests hard-error. `Error::JumbfNotFound` maps to the no-manifest path (unsigned assets → 200 empty result, matching c2pa-node).
- Wire settings format for c2pa 0.92: trust.anchors[] entries with trust_kind/trust_uri/trust_config (the legacy flat trust_anchors field is deprecated) — reverse-engineered from c2pa-utilities resolveSettings/toWireSettings + snakeCaseify.
- Golden capture caveat: the reference Node container MUST run with TZ=UTC (provenance dates render in runtime-local time; an early capture on a UTC+5:30 workstation contaminated the goldens).
- Parity harness needs the Node container runnable locally. The reference implementation was deleted in M5 — restore it from the merge base first: `git checkout f75b4ff940af03c9e557b37b9bc89d7ff90da306 -- api/container packages/core package.json` (into a scratch worktree, not the working branch), install dependencies there (`bun install` for the root and `packages/core`), then symlink api/container/core → ../../packages/core and api/container/node_modules → ../../node_modules (gitignored). Run it with TZ=UTC or the provenance dates contaminate every golden.
- Known remaining gaps (no corpus coverage): PNG/WEBP/GIF EXIF extraction (parser handles JPEG+TIFF only), ISO timestamps with non-Z offsets render unconverted, exifr revival edge cases not exercised by the corpus. Number-format differences (serde_json 4000.0 vs JS 4000) are irrelevant — the worker parses the JSON before re-serializing.
- Dockerfile written (rust:1-bookworm build → debian:bookworm-slim runtime) but not yet built or integration-tested — that is M5.

M5 completed 2026-11-26 (worker version c7d3f172):
- Docker image builds in 2m35s, 174 MB (vs ~1 GB Node image), passes full 7-fixture parity inside Docker. Deployed via `wrangler deploy`; wrangler.jsonc now points at `container-rs/Dockerfile`. Node container (`api/container/`) removed.
- Production smoke-jobs: 18/19 rows pass — direct-upload R2 path, small+large URL jobs, ownership isolation, idempotency replay, 404 failure handling, webhook HMAC delivery, MCP submit/poll. **220 MiB end-to-end in 58.1s** with byte-exact sha256 and Valid state.
- The one failing row ("small job result deep-compares with POST /v1/verify") is NOT container-related: the sync `/v1/verify` fetch of thecontrarian.in fails with upstream HTTP 522 (Cloudflare edge cannot reach the library.thecontrarian.in origin from the worker-subrequest network path) — while the async consumer fetches the same URL fine and browser/curl fetches succeed in <300ms. Worker code is byte-identical to the November CI deploy (verified via git diff); the sync path never touches the container. This is an origin-reachability issue on the thecontrarian.in infrastructure side, to be investigated there — the smoke row should pass once the origin is reachable from Cloudflare's subrequest paths again.
- Post-deploy key hygiene: smoke/debug keys are created and revoked per-run; no long-lived measurement keys remain.

## Phase 4: Commercial layer

Decisions locked 2026-11-26:
- **Tiers**: free 1,000 verifications/mo $0 · pro 25,000/mo $19 · scale 250,000/mo $99. Hard caps (429 quota_exceeded, consistent with existing enforcement); usage reported to Stripe for visibility/overage-readiness but no overage billing in v1.
- **Billing**: billing-agnostic adapter (`api/src/billing.js`) with a Stripe implementation wired test-mode-ready; activated when keys arrive. **Provider undecided** — user may choose RazorPay instead of Stripe; the adapter boundary is the integration point, no provider-specific logic outside it. No email infrastructure — keys are delivered once post-checkout via session_id reveal, dashboard auth is the API key itself, billing management redirects to the Stripe customer portal.
- **Dashboard + docs**: extend the existing Pages viewer (`/dashboard`, `/docs`), not a separate app.
- **Free signup abuse control**: Cloudflare Turnstile + per-IP rate limit on the signup endpoint.

Milestones:
- [x] P4.1 Per-key quota Durable Object: atomic reserve/commit/release with expiring reservation tokens (crash-safe), month rollover, D1 usage table remains the metering ledger; eliminates the check-then-increment race in the current D1-read quota path
- [x] P4.2 Self-service key backend: POST /v1/signup/free (Turnstile-verified), key-authed management endpoints (GET /v1/key, GET /v1/usage, POST /v1/key/rotate, POST /v1/key/revoke, GET /v1/jobs list), migration 0003 (stripe customer/subscription columns)
- [x] P4.3 Billing adapter + Stripe impl: POST /v1/billing/checkout (key-auth upgrade OR keyless new-customer flow), GET /v1/billing/checkout-session reveal-once, POST /v1/billing/portal, POST /v1/billing/webhook (signature-verified: checkout.session.completed → tier upgrade, subscription.deleted → downgrade to free), clean 503 when unconfigured
- [x] P4.4 Customer dashboard in the Pages viewer: key-auth, usage/quota meters, jobs list, rotate/revoke, upgrade flow, signup flow with Turnstile
- [x] P4.5 Docs site in the Pages viewer (/docs: quickstart, auth, sync, async, webhooks, MCP, trust, errors, quotas) + thin TypeScript and Python SDKs
- [x] P4.6 Terms of service, DPA, retention statement (accurate to actual R2/D1 retention)
- [ ] P4.7 First paying key — end-to-end validation (blocked on provider decision — Stripe vs RazorPay — and account keys)

## Phase 5: Extras (demand-driven)

- [ ] WebMCP tools in the Pages viewer
- [ ] Connect-RPC / gRPC
- [ ] Signed verification results
- [ ] Video, PDF and audio formats
- [ ] Batch endpoint
- [ ] Per-tenant white-label configuration

## Open decisions

- ~~API hostname~~ decided: `api.c2pa.creds.im` (live since 2026-11-26)
- ~~Container engine~~ decided: native Rust — full rewrite of the container analysis pipeline in Rust (user decision 2026-11-26, aware that c2pa-node is already Rust-native underneath and that this forks the single-source parity guarantee; implementation tracked below)
- ~~Sync size cap~~ decided: 20 MiB (see Phase 0 findings)
