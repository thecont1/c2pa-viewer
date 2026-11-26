/**
 * c2pa-verify — thin TypeScript client for the C2PA Verify API.
 * Zero dependencies; works in Node 18+, Bun, Deno, and edge workers.
 *
 *   import { C2paClient } from './index.js';
 *   const api = new C2paClient('c2pa_live_…');
 *   const result = await api.verify({ url: 'https://example.com/photo.jpg' });
 */
export class C2paError extends Error {
    status;
    code;
    problem;
    constructor(status, code, detail, problem) {
        super(detail || `c2pa verify api error ${status} (${code})`);
        this.status = status;
        this.code = code;
        this.problem = problem;
        this.name = 'C2paError';
    }
}
export class C2paClient {
    key;
    base;
    constructor(key, baseUrl = 'https://api.c2pa.thecontrarian.in') {
        this.key = key;
        this.base = baseUrl.replace(/\/$/, '');
    }
    async request(method, path, body, extraHeaders, signal) {
        const headers = { authorization: `Bearer ${this.key}`, ...extraHeaders };
        if (body !== undefined)
            headers['content-type'] = 'application/json';
        const resp = await fetch(`${this.base}${path}`, {
            method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal,
        });
        const json = await resp.json().catch(() => null);
        if (!resp.ok) {
            const p = json;
            throw new C2paError(resp.status, p?.code || 'unknown', p?.detail, json);
        }
        return json;
    }
    /** Full synchronous verification. Assets up to 20 MiB. */
    verify(input) {
        const query = new URLSearchParams();
        if (input.include)
            query.set('include', input.include);
        if (input.trust)
            query.set('trust', input.trust);
        if (input.strip_gps !== undefined)
            query.set('strip_gps', String(input.strip_gps));
        const qsRaw = query.toString();
        const qs = qsRaw ? `?${qsRaw}` : '';
        const { include, trust, strip_gps, ...body } = input;
        return this.request('POST', `/v1/verify${qs}`, body);
    }
    /** Compact trust card for a URL. */
    mini(url) {
        return this.request('GET', `/v1/verify/mini?url=${encodeURIComponent(url)}`);
    }
    /** Submit an async job (assets up to 1 GiB). */
    createJob(input) {
        const { idempotencyKey, ...body } = input;
        return this.request('POST', '/v1/jobs', body, idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined);
    }
    getJob(jobId, signal) {
        return this.request('GET', `/v1/jobs/${encodeURIComponent(jobId)}`, undefined, undefined, signal);
    }
    /** Poll a job to its terminal state. The deadline bounds everything:
     * each in-flight poll aborts when the remaining time runs out, and each
     * sleep caps at the time left — the loop returns at timeoutMs even when
     * a request or delay would otherwise exceed it. */
    async waitForJob(jobId, { intervalMs = 3000, timeoutMs = 300000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                throw new C2paError(0, 'timeout', `job ${jobId} did not terminate in ${timeoutMs}ms`, null);
            let job;
            try {
                job = await this.getJob(jobId, AbortSignal.timeout(remaining));
            }
            catch (e) {
                if (Date.now() >= deadline)
                    throw new C2paError(0, 'timeout', `job ${jobId} did not terminate in ${timeoutMs}ms`, null);
                throw e;
            }
            if (job.status === 'succeeded' || job.status === 'failed')
                return job;
            const left = deadline - Date.now();
            if (left <= 0)
                throw new C2paError(0, 'timeout', `job ${jobId} did not terminate in ${timeoutMs}ms`, null);
            await new Promise((r) => setTimeout(r, Math.min(intervalMs, left)));
        }
    }
    /** Key metadata + current-month usage. */
    keyInfo() { return this.request('GET', '/v1/key'); }
    /** Monthly usage history. */
    usage() { return this.request('GET', '/v1/usage'); }
    /** Rotate the key — returns the successor plaintext exactly once. */
    rotate() { return this.request('POST', '/v1/key/rotate', {}); }
    revoke() { return this.request('POST', '/v1/key/revoke', {}); }
    /** Create a Stripe checkout session to upgrade this key in place. */
    checkout(tier) {
        return this.request('POST', '/v1/billing/checkout', { tier });
    }
    /** Stripe customer portal link. */
    portal() { return this.request('POST', '/v1/billing/portal', {}); }
    /** Trust-list provenance. */
    trustLists() { return this.request('GET', '/v1/trust-lists'); }
}
