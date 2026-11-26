# Technical Specification — c2pa-viewer

Engineer-facing detail for building, deploying, and understanding the system.
For the product overview, see [README.md](README.md).

## Deployment topology

Production runs as a static site on **Cloudflare Pages** — all metadata
extraction happens in the browser (`@contentauth/c2pa-web` WASM + `exifr`), with a
Pages Function image proxy at `/api/img` for cross-origin fetches. `server.py` remains
as a self-hostable FastAPI reference implementation producing the same JSON shapes.

## Technology Stack

- **Frontend compute**: `c2pa-compute.js` (bundled from `src/compute.js` via `bun build`)
  - [@contentauth/c2pa-web](https://github.com/contentauth/c2pa-web) — C2PA manifest parsing in a Web Worker (8.4 MB `vendor/c2pa_bg.wasm`)
  - [exifr](https://github.com/MattKetmo/exifr) — EXIF/GPS/IPTC extraction
- **Edge**: Cloudflare Pages static hosting + Pages Function (`functions/api/img.js`) image proxy
- **Verification API**: Cloudflare Worker (`api/`, Hono) — REST `/v1` + MCP `/mcp` + async jobs

## How to Run Locally

### Prerequisites
- [Bun](https://bun.sh) 1.4+

### Setup and serve

```bash
git clone https://github.com/thecont1/c2pa-viewer.git
cd c2pa-viewer
bun install
bun run build
```

The viewer is a fully static site — serve the repo root with any static file
server, e.g. `bunx serve .` or `python3 -m http.server`, then open
`http://localhost:3000/?uri=https://example.com/image.jpg` (port depends on
the server). The golden test harness (`bun scripts/golden.mjs`) also serves
the full app on port 8899 while capturing.

### Tests

```bash
bun run test        # golden + parity + openapi + contract + mcp chain
bun run test:api    # API smoke matrix
```

## Build & Deploy (Cloudflare Pages)

```bash
bun install
bun run deploy      # build + stage + wrangler pages deploy
```

Do **not** deploy the repository root: `wrangler pages deploy` ignores
`.gitignore`, so it would upload `node_modules/` and local files like
`.env` or `config.json`. `bun run stage` (or `scripts/stage-site.sh`)
copies only the required public assets — `index.html`, `script.js`,
`styles.css`, the logo, `c2pa-compute.js`, `_headers`,
`functions/api/img.js`, `vendor/c2pa_bg.wasm` — into `.deploy-stage/`,
which is what gets deployed. To deploy manually:

```bash
bun run build && bun run stage
bunx wrangler pages deploy .deploy-stage --project-name=c2pa-viewer
```

`c2pa-compute.js` and `vendor/` are committed build artifacts — rerun `bun run build`
after editing `src/compute.js`. Security headers live in `_headers`; the image proxy
lives in `functions/api/img.js` (GET `/api/img?url=<https-url>`, streams upstream bytes
with `Access-Control-Allow-Origin: *`, 80 MB cap, private-host SSRF guard).

The browser fetches the image directly first; when the origin lacks CORS headers it
falls back to `/api/img`, which re-fetches upstream with browser-like headers —
mirroring the old `ImagePathContext` behaviour.

## Main Entry Points

| File | Description |
|------|-------------|
| `index.html` | Main HTML file for the application |
| `src/compute.js` | Browser compute port of the API logic (source of truth for the static build) |
| `c2pa-compute.js` | Bundled compute (built artifact, committed) |
| `functions/api/img.js` | Pages Function image proxy |
| `styles.css` | CSS styling |
| `script.js` | Frontend JavaScript for rendering metadata |

## Architecture Notes

### API Design
The API separates EXIF extraction from C2PA verification for performance:
- **EXIF/IPTC extraction** is fast (simple binary parsing, ~10-50ms)
- **C2PA verification** is slower (cryptographic signature verification, ~100-500ms+)

This separation allows clients to request only the data they need.

### Digital Source Type Detection
The system detects image origin from C2PA data:
1. Checks `claim_generator` for AI tools (Firefly, DALL-E, Midjourney, etc.)
2. Checks actions for AI-related operations (`text_to_image`, generative fills)
3. Checks ingredient formats for camera types (DNG, RAW → "Digital Camera (RAW)")
4. Falls back to "Digital Camera" for standard C2PA images

### Verification API tiers and quotas

| Tier | Price | Verifications / month | Async jobs |
|---|---|---|---|
| Free | $0 | 500 | No — sync only |
| Sync Only | $3.99/mo or $44.99/yr per unit | 10,000 per unit, in multiples up to 100× | No — sync only |
| Sync+Async | $9.99/mo or $99.99/yr per unit | 25,000 per unit, in multiples up to 100× | Yes, with signed webhooks |

- Sync verification caps at 20 MiB per asset; async defaults to 20 MiB, with
  larger per-key caps privately negotiated (`keys.max_job_bytes`).
- Hard caps enforced atomically per key by a Durable Object; sync verifications
  count on success, async jobs count at acceptance; failures and test keys are
  never metered; reset at the UTC month boundary.
- Webhooks: HMAC-signed, at-least-once delivery, retried after non-2xx,
  transport errors or timeout, up to four attempts — deduplicate by `job_id`.

## File Structure
```
c2pa-viewer/
├── index.html           # Main HTML file
├── styles.css           # Stylesheet
├── script.js            # Frontend JavaScript for rendering metadata
├── src/compute.js       # Browser adapter over the shared core
├── packages/core/       # Platform-free verification/formatting core
├── c2pa-compute.js      # Bundled compute (built artifact, committed)
├── functions/api/img.js # Pages Function image proxy
├── api/                 # Verification API worker (REST + MCP + jobs)
├── trust/               # Vendored C2PA + ITL trust anchors
└── README.md            # Product overview for lay users
```
