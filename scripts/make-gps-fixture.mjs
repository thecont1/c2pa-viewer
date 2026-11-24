#!/usr/bin/env bun
// Generate fixtures/gps.jpg: a copy of fixtures/A.jpg with a GPS IFD injected
// (lat 12.9716 N, lon 77.5946 E — Bengaluru) using piexifjs.
//
// No corpus fixture carries GPS data, and strip_gps contract testing needs one.
// A.jpg has no C2PA manifest, so the fixture exercises the pure EXIF/GPS path.
//
//   bun scripts/make-gps-fixture.mjs
//
// Idempotent: re-running regenerates the same bytes (piexif insert is
// deterministic for the same input+IFD). After regenerating, run
// `bun scripts/golden.mjs --update` so the golden corpus picks it up.

import piexif from 'piexifjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'fixtures/A.jpg');
const OUT = join(ROOT, 'fixtures/gps.jpg');

const LAT = 12.9716;  // N, Bengaluru
const LON = 77.5946;  // E

// Decimal degrees -> EXIF DMS triple of rationals ([num, den] pairs).
function toDmsRational(dd) {
    const d = Math.floor(dd);
    const mFloat = (dd - d) * 60;
    const m = Math.floor(mFloat);
    const s = (mFloat - m) * 60;
    return [[d, 1], [m, 1], [Math.round(s * 10000), 10000]];
}

const bin = readFileSync(SRC).toString('binary');
const exifObj = piexif.load(bin);

exifObj.GPS = exifObj.GPS || {};
exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef] = 'N';
exifObj.GPS[piexif.GPSIFD.GPSLatitude] = toDmsRational(LAT);
exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = 'E';
exifObj.GPS[piexif.GPSIFD.GPSLongitude] = toDmsRational(LON);

const exifBytes = piexif.dump(exifObj);
const inserted = piexif.insert(exifBytes, bin);
writeFileSync(OUT, Buffer.from(inserted, 'binary'));

// Verify with a fresh parse of what we wrote.
const check = piexif.load(Buffer.from(inserted, 'binary').toString('binary'));
const lat = check.GPS[piexif.GPSIFD.GPSLatitude];
const lon = check.GPS[piexif.GPSIFD.GPSLongitude];
if (!lat || !lon) throw new Error('GPS IFD did not round-trip');
console.log(`wrote ${OUT}`);
console.log(`  GPSLatitude  ${JSON.stringify(lat)} ${check.GPS[piexif.GPSIFD.GPSLatitudeRef]}`);
console.log(`  GPSLongitude ${JSON.stringify(lon)} ${check.GPS[piexif.GPSIFD.GPSLongitudeRef]}`);
