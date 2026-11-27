# c2pa-verify (Python)

Thin stdlib-only client for the [C2PA Verify API](https://creds.im/docs). Python 3.9+, no dependencies.

```python
from c2pa_verify import C2paClient

api = C2paClient('c2pa_live_…')
result = api.verify(url='https://example.com/photo.jpg')
print(result['status'])  # trusted | valid_untrusted | invalid | unverified

# Local files
result = api.verify_file('photo.jpg')

# Large files: async pipeline
job = api.create_job(url='https://example.com/big.jpg', filename='big.jpg')
done = api.wait_for_job(job['job_id'])
print(done['result']['status'])
```

Errors raise `C2paError` with `.status`, `.code` and the RFC 9457 problem body in `.problem`.
