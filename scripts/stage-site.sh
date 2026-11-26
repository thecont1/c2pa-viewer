#!/usr/bin/env bash
# Stage ONLY the public site assets for `wrangler pages deploy`.
# wrangler does not respect .gitignore, so deploying the repo root would
# upload node_modules and any local files (.env, config.json, server.py...).
# This allowlist makes leaks impossible by construction.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf .deploy-stage
mkdir -p .deploy-stage/functions/api .deploy-stage/vendor .deploy-stage/vendor/trust .deploy-stage/dashboard \
   .deploy-stage/packages/core/src

cp dashboard/index.html dashboard/dashboard.js dashboard/dashboard.css .deploy-stage/dashboard/
cp index.html script.js styles.css content_credentials_logo.svg \
   c2pa-compute.js _headers .deploy-stage/
cp functions/api/img.js .deploy-stage/functions/api/img.js
# img.js imports ../../packages/core/src/ssrf.js — the same relative path must
# resolve inside the staged tree (verified with `wrangler pages dev`).
cp packages/core/src/ssrf.js .deploy-stage/packages/core/src/ssrf.js
cp vendor/c2pa_bg.wasm .deploy-stage/vendor/c2pa_bg.wasm
cp trust/C2PA-TRUST-LIST.pem trust/ITL-anchors.pem trust/store.cfg trust/meta.json \
   .deploy-stage/vendor/trust/

echo "Staged $(find .deploy-stage -type f | wc -l | tr -d ' ') files in .deploy-stage/"
