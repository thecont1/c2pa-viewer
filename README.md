# C2PA Viewer

An image viewer web application that allows users to verify [C2PA content credentials](https://contentcredentials.org/) as well as view EXIF and IPTC information embedded within the image.

> **Deployment**: production runs as a static site on **Cloudflare Pages** — all metadata
> extraction happens in the browser (`@contentauth/c2pa-web` WASM + `exifr`), with a
> Pages Function image proxy at `/api/img` for cross-origin fetches. `server.py` remains
> as a self-hostable FastAPI reference implementation producing the same JSON shapes.

## Features

### 1. Image Viewer
- Displays the main image with a clean white background and subtle shadow effect
- Shows verification status badges:
  - **Content Credentials**: Green "Authenticity Verified" badge for C2PA-verified images
  - **Digital Source Type**: Shows image origin (e.g., "Digital Camera (RAW)", "Generative AI")
- Responsive design that works on all screen sizes

### 2. Metadata Extraction
- Extracts EXIF and IPTC metadata from images
- Displays photography information (camera make, model, lens, exposure settings)
- Shows detailed metadata sections:
  - Camera & Lens (make, model, serial numbers)
  - Exposure Settings (aperture, shutter speed, ISO, focal length)
  - Image Details (format, resolution, dimensions)
  - Photographer Information (artist, capture dates)

### 3. C2PA Verification
- Extracts and displays C2PA thumbnails (claim and ingredient images)
- Shows provenance history with timestamps and detailed edit actions
- Displays specific adjustment values (e.g., "Blacks: -5", "Clarity: +20")
- **Digital Source Type Detection**:
  - Detects camera capture (DNG, RAW files → "Digital Camera (RAW)")
  - Detects AI-generated content (Adobe Firefly, DALL-E, Midjourney → "Generative AI")
  - Shows orange badge for AI-generated, green badge for camera capture

### 4. API Integration
- RESTful API for metadata extraction
- Accepts image URIs as input
- Handles both local files and remote URLs
- CORS-enabled for cross-origin requests

## Verification API

The machine-consumable verification service (REST + MCP) is documented in
`api/openapi.yaml` and `docs/API-PLAN.md`. The endpoints formerly listed here
belonged to a Python/FastAPI implementation that has been removed; the viewer
itself is fully static and has no server-side API surface beyond the `/api/img`
proxy.

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

## Technology Stack

- **Frontend compute**: `c2pa-compute.js` (bundled from `src/compute.js` via `bun build`)
  - [@contentauth/c2pa-web](https://github.com/contentauth/c2pa-web) — C2PA manifest parsing in a Web Worker (8.4 MB `vendor/c2pa_bg.wasm`)
  - [exifr](https://github.com/MattKetmo/exifr) — EXIF/GPS/IPTC extraction
- **Edge**: Cloudflare Pages static hosting + Pages Function (`functions/api/img.js`) image proxy
- **Verification API**: Cloudflare Worker (`api/`, Hono) — REST `/v1` + MCP `/mcp` + async jobs

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
└── README.md            # This file
```

## License
This project is licensed under the [Business Source License 1.1](LICENSE.md): free for any use — including production — other than offering a competing hosted C2PA verification service, converting to Apache 2.0 four years after each version's first public release.
