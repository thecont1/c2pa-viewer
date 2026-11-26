#!/usr/bin/env bun
// keyctl — API key admin CLI for c2pa-verify-api.
//
//   bun scripts/keyctl.mjs create --name X [--type server|browser]
//        [--tier free|sync_only|sync_async] [--quota N] [--origins a,b]
//        [--scopes verify,mini] [--test] [--remote]
//   bun scripts/keyctl.mjs list [--remote]
//   bun scripts/keyctl.mjs revoke --id <uuid> [--remote]
//   bun scripts/keyctl.mjs rotate --id <uuid> [--remote]
//
// Commands run `wrangler d1 execute --local` by default against the local dev
// database (api/.wrangler/state). Pass --remote to operate on the real D1
// database configured in api/wrangler.jsonc.
//
// create/rotate print the full plaintext key ONCE — it is never stored
// (only sha256 hex) and cannot be recovered.

import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKey, sha256HexText } from '../api/src/keys-mw.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'api');
const DB_NAME = 'c2pa-verify-api';

// ------------------------------------------------------------ arg parsing --

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            if (['test', 'local', 'remote'].includes(key)) {
                args[key] = true;
            } else {
                args[key] = argv[++i];
            }
        } else {
            args._.push(a);
        }
    }
    return args;
}

function die(msg, code = 1) {
    console.error(`error: ${msg}`);
    process.exit(code);
}

// --------------------------------------------------------------- d1 shell --

function d1(sql, { json = false, remote = false } = {}) {
    const args = ['wrangler', 'd1', 'execute', DB_NAME, remote ? '--remote' : '--local', '--command', sql];
    if (json) args.push('--json');
    const res = spawnSync('bunx', args, { cwd: API_DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (res.error) throw res.error;
    if (res.status !== 0) {
        throw new Error(`wrangler d1 execute failed (exit ${res.status}):\n${res.stdout || ''}${res.stderr || ''}`);
    }
    if (json) {
        // --json prints an array of result sets, one per statement.
        return JSON.parse(res.stdout);
    }
    return res.stdout;
}

function d1Query(sql, { remote = false } = {}) {
    const out = d1(sql, { json: true, remote });
    return (out[0] && out[0].results) || [];
}

// SQL string literal escaping (single quotes doubled).
function q(v) {
    if (v === null || v === undefined) return 'NULL';
    return `'${String(v).replaceAll("'", "''")}'`;
}

// -------------------------------------------------------------- commands --

async function create(args) {
    const name = args.name;
    if (!name) die('create requires --name');
    const type = args.type || 'server';
    if (!['server', 'browser'].includes(type)) die('--type must be server|browser');
    const tier = args.tier || 'free';
    if (!['free', 'sync_only', 'sync_async'].includes(tier)) die('--tier must be free|sync_only|sync_async');

    const kind = args.test ? 'test' : 'live';
    const { plaintext, displayPrefix } = generateKey(kind);
    const hash = await sha256HexText(plaintext);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    let quota;
    if (args.quota !== undefined) {
        // parseInt silently truncates junk ('0.5' -> 0, '500junk' -> 500);
        // require a complete non-negative integer representation first.
        const rawQuota = String(args.quota).trim().toLowerCase();
        if (rawQuota === 'unlimited' || rawQuota === 'none' || rawQuota === 'null') {
            quota = null; // NULL quota_monthly = unmetered key
        } else {
            if (!/^\d+$/.test(rawQuota)) die('--quota must be a non-negative integer or "unlimited"');
            quota = Number(rawQuota);
            if (!Number.isSafeInteger(quota)) die('--quota must be a non-negative integer or "unlimited"');
        }
    } else {
        // Tier defaults match the Phase 4 pricing (2026-11-26): free 1k/mo,
        // pro 25k/mo, scale 250k/mo. NULL stays available as an explicit
        // admin override (--quota) for grandfathered or arrangement keys.
        quota = { free: 500, sync_only: 10000, sync_async: 25000 }[tier];
    }

    let scopes = null;
    if (args.scopes) {
        scopes = JSON.stringify(args.scopes.split(',').map((s) => s.trim()).filter(Boolean));
    }
    let origins = null;
    if (args.origins) {
        origins = JSON.stringify(args.origins.split(',').map((s) => s.trim()).filter(Boolean));
    }

    const sql = `INSERT INTO keys (id, key_hash, display_prefix, name, type, tier, scopes, quota_monthly, allowed_origins, created_at)
VALUES (${q(id)}, ${q(hash)}, ${q(displayPrefix)}, ${q(name)}, ${q(type)}, ${q(tier)}, ${scopes ? q(scopes) : "'[\"verify\"]'"}, ${quota === null ? 'NULL' : quota}, ${q(origins)}, ${q(now)});`;
    d1(sql, { remote: !!args.remote });

    console.log('key created');
    console.log(`  id:             ${id}`);
    console.log(`  display_prefix: ${displayPrefix}`);
    console.log(`  name:           ${name}`);
    console.log(`  type:           ${type}`);
    console.log(`  tier:           ${tier}`);
    console.log(`  quota_monthly:  ${quota === null ? 'unlimited' : quota}`);
    console.log(`  kind:           ${kind}`);
    console.log('');
    console.log(`  PLAINTEXT KEY (shown once, never stored): ${plaintext}`);
    console.log('');
    // machine-friendly last line for scripts/smoke-api.mjs
    console.log(`KEY=${plaintext}`);
    console.log(`KEY_ID=${id}`);
}

function list(args = {}) {
    const rows = d1Query(
        'SELECT id, display_prefix, name, type, tier, scopes, quota_monthly, allowed_origins, created_at, rotated_at, revoked_at FROM keys ORDER BY created_at',
        { remote: !!args.remote }
    );
    if (!rows.length) {
        console.log('no keys');
        return;
    }
    for (const r of rows) {
        const state = r.revoked_at ? 'REVOKED' : 'active';
        console.log(`${r.id}  ${r.display_prefix}  [${state}] ${r.name || ''}  type=${r.type} tier=${r.tier} quota=${r.quota_monthly ?? 'unlimited'} scopes=${r.scopes} origins=${r.allowed_origins ?? '-'} created=${r.created_at}${r.rotated_at ? ` rotated=${r.rotated_at}` : ''}`);
    }
}

function revoke(args) {
    if (!args.id) die('revoke requires --id');
    const rows = d1Query(`SELECT id, revoked_at FROM keys WHERE id = ${q(args.id)}`, { remote: !!args.remote });
    if (!rows.length) die(`no key with id ${args.id}`);
    if (rows[0].revoked_at) die(`key ${args.id} is already revoked`);
    const now = new Date().toISOString();
    d1(`UPDATE keys SET revoked_at = ${q(now)} WHERE id = ${q(args.id)};`, { remote: !!args.remote });
    console.log(`revoked ${args.id} at ${now}`);
}

async function rotate(args) {
    if (!args.id) die('rotate requires --id');
    const rows = d1Query(`SELECT id, display_prefix, revoked_at FROM keys WHERE id = ${q(args.id)}`, { remote: !!args.remote });
    if (!rows.length) die(`no key with id ${args.id}`);
    if (rows[0].revoked_at) die(`key ${args.id} is revoked — rotating a revoked key is not allowed`);
    const kind = rows[0].display_prefix.startsWith('c2pa_test_') ? 'test' : 'live';
    const { plaintext, displayPrefix } = generateKey(kind);
    const hash = await sha256HexText(plaintext);
    const now = new Date().toISOString();
    d1(`UPDATE keys SET key_hash = ${q(hash)}, display_prefix = ${q(displayPrefix)}, rotated_at = ${q(now)} WHERE id = ${q(args.id)};`, { remote: !!args.remote });
    console.log(`rotated ${args.id} at ${now}`);
    console.log('');
    console.log(`  NEW PLAINTEXT KEY (shown once, never stored): ${plaintext}`);
    console.log('');
    console.log(`KEY=${plaintext}`);
    console.log(`KEY_ID=${args.id}`);
}

// ------------------------------------------------------------------ main --

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    switch (cmd) {
        case 'create': return create(args);
        case 'list': return list(args);
        case 'revoke': return revoke(args);
        case 'rotate': return rotate(args);
        default:
            console.error('usage: keyctl.mjs create|list|revoke|rotate [flags]');
            process.exit(2);
    }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
