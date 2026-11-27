# c2pa-verify (TypeScript)

Thin zero-dependency client for the [C2PA Verify API](https://c2pa.creds.im/docs). Works in Node 18+, Bun, Deno, and edge workers — plain `fetch` throughout.

```ts
import { C2paClient } from 'c2pa-verify';

const api = new C2paClient('c2pa_live_…');
const result = await api.verify({ url: 'https://example.com/photo.jpg' });
console.log(result.status); // trusted | valid_untrusted | invalid | unverified

// Large files: async pipeline
const job = await api.createJob({ url: 'https://example.com/big.jpg', filename: 'big.jpg' });
const done = await api.waitForJob(job.job_id);
console.log(done.result.status);
```

Errors throw `C2paError` with `.status`, `.code` and the RFC 9457 problem body in `.problem`.
