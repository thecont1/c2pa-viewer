// migrate-local.mjs — apply the D1 migrations to the local dev database.
//
// Harnesses re-seed on every run, and wrangler's local D1 persists between
// runs — so reapplication must be idempotent. 0001/0002 use IF NOT EXISTS
// throughout and are always safe. 0003 uses ALTER TABLE ADD COLUMN, which
// sqlite cannot make conditional, so it is applied only when its signature
// column is absent.
//
// wrangler d1 execute is invoked with cwd=apiDir so migration paths resolve
// exactly as the harnesses expect.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function applyLocalMigrations(apiDir) {
    const wrangler = join(apiDir, '..', 'node_modules', '.bin', 'wrangler');
    const run = (args) => {
        const res = spawnSync(wrangler, ['d1', 'execute', 'c2pa-verify-api', '--local', ...args], {
            cwd: apiDir,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
        });
        if (res.status !== 0) throw new Error(`d1 execute failed: ${res.stdout}\n${res.stderr}`);
        return res.stdout;
    };

    run(['--file', 'migrations/0001_init.sql']);
    run(['--file', 'migrations/0002_jobs.sql']);

    const out = run(['--command', 'PRAGMA table_info(keys);', '--json']);
    const parsed = JSON.parse(out);
    const cols = ((parsed[0] && parsed[0].results) || []).map((r) => r.name);
    if (!cols.includes('stripe_customer_id')) {
        run(['--file', 'migrations/0003_billing.sql']);
    }

    // 0004/0005 are IF NOT EXISTS throughout — unconditionally safe.
    run(['--file', 'migrations/0004_quota_receipts.sql']);
    run(['--file', 'migrations/0005_turnstile_tokens.sql']);

    // 0006 rebuilds the keys table to swap the tier CHECK constraint;
    // re-running it is harmless but wasteful, so gate on the old constraint.
    const schema = run(['--command', "SELECT sql FROM sqlite_master WHERE name = 'keys';", '--json']);
    const schemaParsed = JSON.parse(schema);
    const tableSql = ((schemaParsed[0] && schemaParsed[0].results) || []).map((r) => r.sql).join('');
    if (tableSql.includes("'pro'")) {
        run(['--file', 'migrations/0006_tier_names.sql']);
    }

    // 0007 uses ALTER TABLE ADD COLUMN — apply only when its signature
    // column is absent (same constraint as 0003).
    const out7 = run(['--command', 'PRAGMA table_info(jobs);', '--json']);
    const jobsCols = ((JSON.parse(out7)[0] && JSON.parse(out7)[0].results) || []).map((r) => r.name);
    if (!jobsCols.includes('cap_bytes')) {
        run(['--file', 'migrations/0007_job_caps.sql']);
    }
}
