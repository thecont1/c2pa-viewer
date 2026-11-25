// JobRunner Durable Object — owns exactly one verification container per job.
// The worker streams the R2 object through this DO as the body of one POST
// /verify; no presigned GET and no asset bytes are buffered in the DO.

import { DurableObject } from 'cloudflare:workers';

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const READY_ATTEMPTS = 180;
const VERIFY_TIMEOUT_MS = 9 * 60 * 1000;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class JobRunner extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.starting = null;
        this.monitoring = null;
        if (ctx.container && ctx.container.running) {
            ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
            this.observeExit();
        }
    }

    observeExit() {
        if (this.monitoring || !this.ctx.container) return;
        this.monitoring = this.ctx.container.monitor()
            .then(() => console.log('job container exited'))
            .catch((e) => console.error('job container failed:', e))
            .finally(() => { this.monitoring = null; });
        this.ctx.waitUntil(this.monitoring);
    }

    async startAndWait() {
        const container = this.ctx.container;
        if (!container) throw new Error('No container is configured for JobRunner');
        if (!container.running) {
            container.start({
                image: container.images.base,
                instance: 'standard-1',
                enableInternet: false,
                env: { NODE_ENV: 'production' },
                labels: { job_runner: 'c2pa-verify' },
            });
        }
        this.observeExit();
        await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
        const port = container.getTcpPort(PORT);
        for (let i = 0; i < READY_ATTEMPTS; i++) {
            try {
                const resp = await port.fetch('http://container/health', { signal: AbortSignal.timeout(1000) });
                try { await resp.body?.cancel(); } catch { }
                if (resp.ok) return;
            } catch { }
            await sleep(500);
        }
        throw new Error('container did not become ready on port 8080');
    }

    async destroyQuietly() {
        try {
            if (this.ctx.container && this.ctx.container.running) await this.ctx.container.destroy();
        } catch (e) {
            console.error('container destroy failed:', e);
        }
    }

    async fetch(request) {
        let spec;
        try { spec = await request.json(); } catch {
            return Response.json({ error: 'invalid JobRunner request' }, { status: 400 });
        }
        if (!spec || typeof spec.object_key !== 'string' || typeof spec.mime !== 'string') {
            return Response.json({ error: 'invalid JobRunner request' }, { status: 400 });
        }

        try {
            if (!this.starting) {
                this.starting = this.startAndWait().finally(() => { this.starting = null; });
            }
            await this.starting;

            const obj = await this.env.JOBS_BUCKET.get(spec.object_key);
            if (!obj) return Response.json({ error: 'input object missing' }, { status: 404 });

            // Verify exactly the object version the consumer's metadata reads
            // came from. Presigned PUTs are reusable, so the object may have
            // been replaced in between; 409 tells the consumer to retry rather
            // than publish a result mixing two versions.
            if (spec.expected_etag && obj.etag && spec.expected_etag !== obj.etag) {
                return Response.json({ error: `object replaced (etag ${obj.etag}, expected ${spec.expected_etag})` }, { status: 409 });
            }
            if (typeof spec.expected_size === 'number' && spec.expected_size !== obj.size) {
                return Response.json({ error: `object replaced (size ${obj.size}, expected ${spec.expected_size})` }, { status: 409 });
            }

            const headers = {
                'x-mime': spec.mime,
                'x-filename': encodeURIComponent(spec.filename || 'image'),
                'x-trust-profile': spec.trust_profile || 'c2pa_and_itl',
                'x-c2pa-settings': spec.settings || '',
            };
            const port = this.ctx.container.getTcpPort(PORT);
            const upstream = new Request('http://container/verify', {
                method: 'POST',
                headers,
                body: obj.body,
            });
            const resp = await port.fetch(upstream, { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
            // Container responses are compact JSON even for a 1 GiB input. Read
            // fully before destroy so the response cannot be truncated mid-body.
            const body = await resp.arrayBuffer();
            return new Response(body, {
                status: resp.status,
                headers: { 'content-type': resp.headers.get('content-type') || 'application/json' },
            });
        } catch (e) {
            console.error('JobRunner failed:', e && e.stack ? e.stack : e);
            return Response.json({ error: 'container runner failed' }, { status: 502 });
        } finally {
            // One container is one job. Destroy promptly for cost control rather
            // than relying only on the two-minute inactivity timeout.
            await this.destroyQuietly();
        }
    }
}
