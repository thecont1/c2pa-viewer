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
    data?: string;
    mime?: string;
    filename?: string;
    include?: string;
    trust?: 'c2pa' | 'c2pa_and_itl';
    strip_gps?: boolean;
}
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
export declare class C2paError extends Error {
    status: number;
    code: string;
    problem: unknown;
    constructor(status: number, code: string, detail: string | undefined, problem: unknown);
}
export declare class C2paClient {
    private key;
    private base;
    constructor(key: string, baseUrl?: string);
    private request;
    /** Full synchronous verification. Assets up to 20 MiB. */
    verify(input: VerifyInput): Promise<Record<string, unknown>>;
    /** Compact trust card for a URL. */
    mini(url: string): Promise<Record<string, unknown>>;
    /** Submit an async job (assets up to 1 GiB). */
    createJob(input: JobInput): Promise<Record<string, unknown>>;
    getJob(jobId: string): Promise<Record<string, unknown>>;
    /** Poll a job to its terminal state. */
    waitForJob(jobId: string, { intervalMs, timeoutMs }?: {
        intervalMs?: number | undefined;
        timeoutMs?: number | undefined;
    }): Promise<{
        status?: string;
    }>;
    /** Key metadata + current-month usage. */
    keyInfo(): Promise<Record<string, unknown>>;
    /** Monthly usage history. */
    usage(): Promise<Record<string, unknown>>;
    /** Rotate the key — returns the successor plaintext exactly once. */
    rotate(): Promise<{
        key: string;
    }>;
    revoke(): Promise<Record<string, unknown>>;
    /** Create a Stripe checkout session to upgrade this key in place. */
    checkout(tier: 'pro' | 'scale'): Promise<{
        checkout_url: string;
    }>;
    /** Stripe customer portal link. */
    portal(): Promise<{
        portal_url: string;
    }>;
    /** Trust-list provenance. */
    trustLists(): Promise<Record<string, unknown>>;
}
