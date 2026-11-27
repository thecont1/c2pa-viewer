/**
 * c2pa-verify — thin TypeScript client for the C2PA Verify API.
 * Zero dependencies; works in Node 18+, Bun, Deno, and edge workers.
 *
 *   import { C2paClient } from './index.js';
 *   const api = new C2paClient('c2pa_live_…');
 *   const result = await api.verify({ url: 'https://example.com/photo.jpg' });
 */

export interface VerifyInput {
    url?: string;
    data?: string;           // base64
    mime?: string;
    filename?: string;
    include?: string;        // 'exif,iptc,gps,thumbnails,raw_manifest'
    trust?: 'c2pa' | 'c2pa_and_itl';
    strip_gps?: boolean;
}

/** Async job lifecycle states. Terminal states carry the outcome. */
export type JobStatus = 'awaiting_upload' | 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobBase {
    job_id: string;
    status: JobStatus;
    created_at?: string;
    completed_at?: string | null;
    [key: string]: unknown;
}

export interface JobPending extends JobBase {
    status: 'awaiting_upload' | 'queued' | 'running';
}

export interface JobSucceeded extends JobBase {
    status: 'succeeded';
    result: { status?: string;[key: string]: unknown };
}

export interface JobFailed extends JobBase {
    status: 'failed';
    error: string | null;
}

/** A job in any state; narrow on .status to reach terminal variants. */
export type Job = JobPending | JobSucceeded | JobFailed;

export interface JobInput {
    url?: string;
    filename?: string;
    mime?: string;
    webhook_url?: string;
    include?: string;
    trust?: 'c2pa' | 'c2pa_and_itl';
    strip_gps?: boolean;
    idempotencyKey?: string;
}

export class C2paError extends Error {
    constructor(
        public status: number,
        public code: string,
        detail: string | undefined,
        public problem: unknown,
    ) {
        super(detail || `c2pa verify api error ${status} (${code})`);
        this.name = 'C2paError';
    }
}

export class C2paClient {
    private base: string;

    constructor(private key: string, baseUrl = 'https://c2pa.creds.im') {
        this.base = baseUrl.replace(/\/$/, '');
    }

    private async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<T> {
        const headers: Record<string, string> = { authorization: `Bearer ${this.key}`, ...extraHeaders };
        if (body !== undefined) headers['content-type'] = 'application/json';
        const resp = await fetch(`${this.base}${path}`, {
            method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal,
        });
        const json = await resp.json().catch(() => null);
        if (!resp.ok) {
            const p = json as { code?: string; detail?: string } | null;
            throw new C2paError(resp.status, p?.code || 'unknown', p?.detail, json);
        }
        return json as T;
    }

    /** Full synchronous verification. Assets up to 20 MiB. */
    verify(input: VerifyInput) {
        const query = new URLSearchParams();
        if (input.include) query.set('include', input.include);
        if (input.trust) query.set('trust', input.trust);
        if (input.strip_gps !== undefined) query.set('strip_gps', String(input.strip_gps));
        const qsRaw = query.toString();
        const qs = qsRaw ? `?${qsRaw}` : '';
        const { include, trust, strip_gps, ...body } = input;
        return this.request<Record<string, unknown>>('POST', `/v1/verify${qs}`, body);
    }

    /** Compact trust card for a URL. */
    mini(url: string) {
        return this.request<Record<string, unknown>>('GET', `/v1/verify/mini?url=${encodeURIComponent(url)}`);
    }

    /** Submit an async job (assets up to 1 GiB). */
    createJob(input: JobInput) {
        const { idempotencyKey, ...body } = input;
        return this.request<Job>('POST', '/v1/jobs', body,
            idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined);
    }

    getJob(jobId: string, signal?: AbortSignal) {
        return this.request<Job>('GET', `/v1/jobs/${encodeURIComponent(jobId)}`, undefined, undefined, signal);
    }

    /** Poll a job to its terminal state. The deadline bounds everything:
     * each in-flight poll aborts when the remaining time runs out, and each
     * sleep caps at the time left — the loop returns at timeoutMs even when
     * a request or delay would otherwise exceed it. */
    async waitForJob(jobId: string, { intervalMs = 3000, timeoutMs = 300000 } = {}): Promise<JobSucceeded | JobFailed> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new C2paError(0, 'timeout', `job ${jobId} did not terminate in ${timeoutMs}ms`, null);
            let job: Job;
            try {
                job = await this.getJob(jobId, AbortSignal.timeout(remaining));
            } catch (e) {
                if (Date.now() >= deadline) throw new C2paError(0, 'timeout', `job ${jobId} did not terminate in ${timeoutMs}ms`, null);
                throw e;
            }
            if (job.status === 'succeeded' || job.status === 'failed') return job as JobSucceeded | JobFailed;
            const left = deadline - Date.now();
            if (left <= 0) throw new C2paError(0, 'timeout', `job ${jobId} did not terminate in ${timeoutMs}ms`, null);
            await new Promise((r) => setTimeout(r, Math.min(intervalMs, left)));
        }
    }

    /** Key metadata + current-month usage. */
    keyInfo() { return this.request<Record<string, unknown>>('GET', '/v1/key'); }

    /** Monthly usage history. */
    usage() { return this.request<Record<string, unknown>>('GET', '/v1/usage'); }

    /** Rotate the key — returns the successor plaintext exactly once. */
    rotate() { return this.request<{ key: string }>('POST', '/v1/key/rotate', {}); }

    revoke() { return this.request<Record<string, unknown>>('POST', '/v1/key/revoke', {}); }

    /** Create a Stripe checkout session to upgrade this key in place. */
    checkout(tier: 'pro' | 'scale') {
        return this.request<{ checkout_url: string }>('POST', '/v1/billing/checkout', { tier });
    }

    /** Stripe customer portal link. */
    portal() { return this.request<{ portal_url: string }>('POST', '/v1/billing/portal', {}); }

    /** Trust-list provenance. */
    trustLists() { return this.request<Record<string, unknown>>('GET', '/v1/trust-lists'); }
}
