# C2PA spike fixtures

Fixtures for the P0.1 Worker spike (`api/spike/`) and later API parity tests.

## Sources

Downloaded from <https://github.com/contentauth/c2pa-python> `tests/fixtures/` (main branch):

| File | Size | Origin | Expected result |
|---|---|---|---|
| `A.jpg` | 61,720 B | c2pa-python `tests/fixtures/A.jpg` | No C2PA manifest — clean "no manifest" result (`manifest_count: 0`), not an error |
| `C.jpg` | 137,886 B | c2pa-python `tests/fixtures/C.jpg` | Signed JPEG (JUMBF `c2pa` box after SOI). Expect a manifest store with `validation_state` (likely `Invalid`/`Unverified` until trust anchors are loaded in P0.2) |
| `C_with_CAWG_data.jpg` | 139,636 B | c2pa-python `tests/fixtures/C_with_CAWG_data.jpg` | Same as C.jpg plus CAWG (Coalition for Content Provenance and Authenticity) assertion data |
| `cloud.jpg` | 183,901 B | c2pa-python `tests/fixtures/cloud.jpg` | **Remote manifest, not embedded** — Adobe XMP/IPTC metadata points at `https://cai-manifests.adobe.com/manifests/adobe-urn-uuid-5f37e182-3687-462e-a7fb-573462780391`; no JUMBF boxes in the file |

## Derived fixtures

| File | How made | Expected result |
|---|---|---|
| `gps.jpg` | `A.jpg` + GPS IFD injected with `scripts/make-gps-fixture.mjs` (lat 12.9716 N, lon 77.5946 E — Bengaluru) | No C2PA manifest; `exif.gps` carries decimal lat/lon. Exists for API `strip_gps` contract testing |
| `tampered.jpg` | `C.jpg` with one byte XOR `0xFF` at offset `len-2000` (inside entropy-coded image data, before EOI) | Hard-binding failure — `validation_state` should report invalid/tampered |
| `big/pad-5mb.jpg` | `C.jpg` + zero bytes appended after EOI to 5 MiB | Will not validate (trailing garbage); exists only to measure read memory/time. **Not committed** (gitignored) |
| `big/pad-15mb.jpg` | same, 15 MiB | same |
| `big/pad-25mb.jpg` | same, 25 MiB | same |
| `big/pad-40mb.jpg` | same, 40 MiB | same |

Regenerate the big fixtures:

```sh
bun -e 'const fs=require("fs");fs.mkdirSync("fixtures/big",{recursive:true});const c=fs.readFileSync("fixtures/C.jpg");for(const mb of [5,15,25,40]){fs.writeFileSync(`fixtures/big/pad-${mb}mb.jpg`,Buffer.concat([c,Buffer.alloc(mb*1024*1024-c.length)]))}'
```
