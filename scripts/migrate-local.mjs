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

    // 0004 is IF NOT EXISTS throughout — unconditionally safe.
    run(['--file', 'migrations/0004_quota_receipts.sql']);
}
