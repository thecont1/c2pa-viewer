// Port of packages/core/src/detect.rs — magic-byte/content-type/extension detection.

pub fn detect_format(bytes: &[u8], content_type: &str, uri: &str) -> &'static str {
    let u8s = &bytes[..bytes.len().min(12)];
    let b = |i: usize| u8s.get(i).copied().unwrap_or(0);
    if b(0) == 0xFF && b(1) == 0xD8 {
        return "JPEG";
    }
    if b(0) == 0x89 && b(1) == 0x50 && b(2) == 0x4E && b(3) == 0x47 {
        return "PNG";
    }
    if b(0) == 0x47 && b(1) == 0x49 && b(2) == 0x46 {
        return "GIF";
    }
    if b(0) == 0x52 && b(1) == 0x49 && b(8) == 0x57 && b(9) == 0x45 {
        return "WEBP";
    }
    if (b(0) == 0x49 && b(1) == 0x49 && b(2) == 0x2A) || (b(0) == 0x4D && b(1) == 0x4D && b(2) == 0x00) {
        return "TIFF";
    }
    let ct = content_type.to_lowercase();
    if ct.contains("png") {
        return "PNG";
    }
    if ct.contains("jpeg") || ct.contains("jpg") {
        return "JPEG";
    }
    if ct.contains("webp") {
        return "WEBP";
    }
    if ct.contains("gif") {
        return "GIF";
    }
    if ct.contains("tiff") {
        return "TIFF";
    }
    let path = uri.split('?').next().unwrap_or("").to_lowercase();
    if path.ends_with(".png") {
        return "PNG";
    }
    if path.ends_with(".webp") {
        return "WEBP";
    }
    if path.ends_with(".gif") {
        return "GIF";
    }
    if path.ends_with(".tif") || path.ends_with(".tiff") || path.ends_with(".dng") {
        return "TIFF";
    }
    "JPEG"
}

pub fn image_mime(format: &str) -> String {
    format!(
        "image/{}",
        if format == "JPEG" {
            "jpeg".to_string()
        } else {
            format.to_lowercase()
        }
    )
}
