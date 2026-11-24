// Photography-metadata formatting ported verbatim from src/compute.js.

import { formatDatetimeFull } from './format.js';

export function formatPhotographyMetadata(exifData, iptcData) {
    if (!exifData) return {};
    const exif = exifData.exif || {};

    const fmt1 = (n) => {
        let s = n.toFixed(1);
        if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s;
    };

    let aperture = 'Unknown';
    const fNum = exif.FNumber;
    if (typeof fNum === 'number') {
        aperture = `f/${fmt1(fNum)}`;
    } else if (Array.isArray(fNum) && fNum.length >= 2 && typeof fNum[0] === 'number') {
        aperture = `f/${fmt1(fNum[0] / fNum[1])}`;
    }

    let shutterSpeed = 'Unknown';
    const expTime = exif.ExposureTime;
    if (typeof expTime === 'number') {
        if (expTime < 1) shutterSpeed = `1/${Math.trunc(1 / expTime)}s`;
        else shutterSpeed = `${expTime.toFixed(2)}s`;
    } else if (Array.isArray(expTime) && expTime.length >= 2) {
        if (expTime[0] === 1) shutterSpeed = `1/${expTime[1]}s`;
        else shutterSpeed = `${(expTime[0] / expTime[1]).toFixed(2)}s`;
    }

    let focalLength = 'Unknown';
    const fl = exif.FocalLength;
    const fmt2 = (n) => {
        let s = n.toFixed(2);
        if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s;
    };
    if (typeof fl === 'number') focalLength = `${fmt2(fl)}mm`;
    else if (Array.isArray(fl) && fl.length >= 2 && typeof fl[0] === 'number') {
        focalLength = `${fmt2(fl[0] / fl[1])}mm`;
    }

    let iso = exif.ISOSpeedRatings !== undefined ? exif.ISOSpeedRatings : 'Unknown';
    if (Array.isArray(iso)) iso = iso.length ? iso[0] : 'Unknown';
    if (typeof iso === 'number') iso = Math.trunc(iso);
    if (iso === 'Unknown') iso = 'Unknown';

    const csv = exif.ColorSpace;
    const colorSpace = csv === 1 ? 'sRGB' : csv === 65535 ? 'Uncalibrated' : 'Unknown';
    const colorProfile = exifData.color_profile || 'Unknown';

    return {
        camera_make: exif.Make !== undefined ? exif.Make : 'Unknown',
        camera_model: exif.Model !== undefined ? exif.Model : 'Unknown',
        lens_model: exif.LensModel !== undefined ? exif.LensModel : 'Unknown',
        aperture,
        shutter_speed: shutterSpeed,
        iso: iso === 'Unknown' ? 'Unknown' : String(iso),
        focal_length: focalLength,
        date_original: formatDatetimeFull(exif.DateTimeOriginal !== undefined ? exif.DateTimeOriginal : 'Unknown'),
        date_digitized: formatDatetimeFull(exif.DateTimeDigitized !== undefined ? exif.DateTimeDigitized : 'Unknown'),
        artist: exif.Artist !== undefined ? exif.Artist : 'Unknown',
        description: exif.ImageDescription
            || (iptcData && (iptcData.description || iptcData.title))
            || 'No description available',
        color_space: colorSpace,
        color_profile: colorProfile,
    };
}
