# c2pa-node test signing certificate

`es256.pem` and `es256.pub` are the upstream c2pa-js test-only signing key and
certificate chain copied verbatim from:

- <https://github.com/contentauth/c2pa-js/tree/%40contentauth/c2pa-node%400.12.1/packages/c2pa-node/tests/fixtures/certs>

They are public test credentials, not production secrets. They exist solely so
`scripts/make-large-fixture.mjs` can generate a locally signed test fixture whose
validation status is expected to be `signingCredential.untrusted`.
