"""c2pa-verify — thin Python client for the C2PA Verify API. Stdlib only.

    from c2pa_verify import C2paClient
    api = C2paClient('c2pa_live_…')
    result = api.verify(url='https://example.com/photo.jpg')
    print(result['status'])
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = 'https://c2pa.creds.im'


class C2paError(Exception):
    """API error carrying the RFC 9457 problem details."""

    def __init__(self, status: int, code: str, detail: str | None, problem: dict | None):
        super().__init__(detail or f'c2pa verify api error {status} ({code})')
        self.status = status
        self.code = code
        self.problem = problem


class C2paClient:
    def __init__(self, key: str, base_url: str = DEFAULT_BASE, timeout: float = 120.0):
        self.key = key
        self.base = base_url.rstrip('/')
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict | None = None,
                 extra_headers: dict | None = None, timeout: float | None = None) -> dict:
        headers = {'authorization': f'Bearer {self.key}', 'user-agent': 'c2pa-verify-python/0.1'}
        if extra_headers:
            headers.update(extra_headers)
        data = None
        if body is not None:
            headers['content-type'] = 'application/json'
            data = json.dumps(body).encode()
        req = urllib.request.Request(f'{self.base}{path}', data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout if timeout is not None else self.timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            try:
                problem = json.loads(e.read())
            except Exception:
                problem = None
            code = (problem or {}).get('code', 'unknown')
            raise C2paError(e.code, code, (problem or {}).get('detail'), problem) from e

    def verify(self, url: str | None = None, data: str | None = None, mime: str | None = None,
               filename: str | None = None, include: str | None = None,
               trust: str | None = None, strip_gps: bool | None = None) -> dict:
        """Full synchronous verification. Assets up to 20 MiB."""
        query = {}
        if include:
            query['include'] = include
        if trust:
            query['trust'] = trust
        if strip_gps is not None:
            query['strip_gps'] = 'true' if strip_gps else 'false'
        qs = f'?{urllib.parse.urlencode(query)}' if query else ''
        body = {}
        if url is not None:
            body['url'] = url
        if data is not None:
            body['data'] = data
        if mime is not None:
            body['mime'] = mime
        if filename is not None:
            body['filename'] = filename
        return self._request('POST', f'/v1/verify{qs}', body)

    def verify_file(self, path: str, **kwargs) -> dict:
        """Verify a local file (base64 JSON upload)."""
        import base64
        import mimetypes
        import os
        with open(path, 'rb') as f:
            payload = base64.b64encode(f.read()).decode()
        return self.verify(
            data=payload,
            mime=mimetypes.guess_type(path)[0] or 'application/octet-stream',
            filename=os.path.basename(path),
            **kwargs,
        )

    def mini(self, url: str) -> dict:
        """Compact trust card for a URL."""
        return self._request('GET', f'/v1/verify/mini?url={urllib.parse.quote(url, safe="")}')

    def create_job(self, url: str | None = None, filename: str | None = None,
                   mime: str | None = None, webhook_url: str | None = None,
                   include: str | None = None, trust: str | None = None,
                   strip_gps: bool | None = None, idempotency_key: str | None = None) -> dict:
        """Submit an async job (assets up to 1 GiB)."""
        body = {k: v for k, v in {
            'url': url, 'filename': filename, 'mime': mime, 'webhook_url': webhook_url,
            'include': include, 'trust': trust, 'strip_gps': strip_gps,
        }.items() if v is not None}
        headers = {'idempotency-key': idempotency_key} if idempotency_key else None
        return self._request('POST', '/v1/jobs', body, headers)

    def get_job(self, job_id: str, timeout: float | None = None) -> dict:
        return self._request('GET', f'/v1/jobs/{urllib.parse.quote(job_id, safe="")}', timeout=timeout)

    def wait_for_job(self, job_id: str, interval: float = 3.0, timeout: float = 300.0) -> dict:
        """Poll a job to its terminal state. The deadline bounds everything:
        each in-flight request's client timeout caps at the remaining time,
        and each sleep likewise — polling stops at the requested timeout
        even when a request or delay would otherwise exceed it."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise C2paError(0, 'timeout', f'job {job_id} did not terminate in {timeout}s', None)
            job = self.get_job(job_id, timeout=remaining)
            if job.get('status') in ('succeeded', 'failed'):
                return job
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise C2paError(0, 'timeout', f'job {job_id} did not terminate in {timeout}s', None)
            time.sleep(min(interval, remaining))

    def key_info(self) -> dict:
        return self._request('GET', '/v1/key')

    def usage(self) -> dict:
        return self._request('GET', '/v1/usage')

    def rotate(self) -> dict:
        """Rotate the key — returns the successor plaintext exactly once."""
        return self._request('POST', '/v1/key/rotate', {})

    def revoke(self) -> dict:
        return self._request('POST', '/v1/key/revoke', {})

    def checkout(self, tier: str) -> dict:
        """Stripe checkout session to upgrade this key in place (pro|scale)."""
        return self._request('POST', '/v1/billing/checkout', {'tier': tier})

    def portal(self) -> dict:
        return self._request('POST', '/v1/billing/portal', {})

    def trust_lists(self) -> dict:
        return self._request('GET', '/v1/trust-lists')
