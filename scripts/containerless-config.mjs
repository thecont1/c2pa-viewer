// containerless-config.mjs — shared helper for local test harnesses.
//
// wrangler dev builds declared container images before serving, which is a
// cold multi-minute Rust build on CI runners. The local harnesses exercise
// the HTTP control plane only — job execution is covered by smoke-jobs.mjs
// against production — so they spawn wrangler with a generated copy of
// wrangler.jsonc that drops the containers section (and the export links to
// it). Paths in the config are relative to api/, so the file is written
// beside wrangler.jsonc.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function writeContainerlessWranglerConfig(apiDir) {
    const { default: config } = await import(join(apiDir, 'wrangler.jsonc'));
    const copy = JSON.parse(JSON.stringify(config));
    delete copy.containers;
    if (copy.exports) {
        for (const entry of Object.values(copy.exports)) {
            if (entry && typeof entry === 'object') delete entry.container;
        }
    }
    const out = join(apiDir, '.wrangler-contract.gen.json');
    writeFileSync(out, JSON.stringify(copy, null, 2));
    return out;
}
