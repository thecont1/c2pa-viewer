# API Endpoints

## C2PA Metadata Viewer API

This document lists all the API endpoints available in the C2PA Image Metadata Viewer application.

### Base URL
All endpoints are relative to the base URL, which defaults to `http://localhost:8080/c2pa` when running locally.

---

## 1. Serve Main Page
**Endpoint:** `/`  
**HTTP Method:** GET  
**Description:** Serves the main HTML page of the C2PA metadata viewer.

**Response:** HTML file (`index.html`)

---

## 2. Serve Static Files
### CSS File
**Endpoint:** `/styles.css`  
**HTTP Method:** GET  
**Description:** Serves the main CSS file for styling the application.

**Response:** CSS file (`styles.css`)

### JavaScript File
**Endpoint:** `/script.js`  
**HTTP Method:** GET  
**Description:** Serves the JavaScript file containing the frontend logic.

**Response:** JavaScript file (`script.js`)

### Logo
**Endpoint:** `/content_credentials_logo.svg`  
**HTTP Method:** GET  
**Description:** Serves the Content Credentials logo.

**Response:** SVG image file

---

## 3. Metadata Extraction Endpoints

### Get EXIF, IPTC, and GPS Metadata
**Endpoint:** `/api/exif_metadata`  
**HTTP Method:** GET  
**Description:** Extracts and returns EXIF, IPTC, and GPS metadata for an image. Does not include C2PA/provenance data.

**Query Parameters:**
- `uri` (required): Image file path or URL

**Response:** JSON object with metadata:
```json
{
  "filename": {
    "filename": "image.jpg",
    "format": "JPEG",
    "width": 2560,
    "height": 1440,
    "file_size_bytes": 4201699,
    "file_size_mb": 4.01,
    "photography": {
      "camera_make": "FUJIFILM",
      "camera_model": "GFX 50S",
      "lens_model": "GF63mmF2.8 R WR",
      "aperture": "f/8",
      "shutter_speed": "1/60s",
      "iso": "400",
      "focal_length": "63mm",
      "date_original": "Nov 30, 2017 at 02:15 PM",
      "date_digitized": "Nov 30, 2017 at 06:45 PM",
      "artist": "MAHESH SHANTARAM",
      "description": "No description available",
      "color_space": "sRGB",
      "color_profile": "sRGB IEC61966-2.1"
    },
    "exif": {},
    "gps": {},
    "iptc": {},
    "image_data": "data:image/jpeg;base64,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"
  }
}
```

---

### Get C2PA Metadata and Provenance
**Endpoint:** `/api/c2pa_metadata`  
**HTTP Method:** GET  
**Description:** Extracts and returns C2PA metadata, provenance information, and embedded thumbnails.

**Query Parameters:**
- `uri` (required): Image file path or URL

**Response:** JSON object with C2PA metadata:
```json
{
  "provenance": [],
  "c2pa_data": {},
  "author_info": {},
  "thumbnails": {},
  "digital_source_type": {}
}
```

---

### Get Minimal C2PA Credentials
**Endpoint:** `/api/c2pa_mini`  
**HTTP Method:** GET  
**Description:** Returns minimal C2PA credentials for quick trust verification (e.g., on hover). Optimized for performance with caching.

**Query Parameters:**
- `uri` (required): Image file path or URL

**Response:** JSON object with minimal credentials:
```json
{
  "creator": "MAHESH SHANTARAM",
  "issued_by": "Adobe Inc.",
  "issued_on": "Nov 30, 2017 at 02:15 PM",
  "status": "Authenticity Verified",
  "digital_source_type": "Digital Camera",
  "more": "https://apps.thecontrarian.in/c2pa/?uri=image.jpg"
}
```

---

## 4. Image Upload
**Endpoint:** `/api/upload`  
**HTTP Method:** POST  
**Description:** Uploads an image file and returns metadata.

**Form Data:**
- `file` (required): Image file to upload

**Response:** JSON object with metadata:
```json
{
  "filename": {
    "filename": "image.jpg",
    "format": "JPEG",
    "width": 2560,
    "height": 1440,
    "file_size_bytes": 4201699,
    "file_size_mb": 4.01,
    "photography": {},
    "exif": {},
    "gps": {},
    "iptc": {},
    "thumbnails": {},
    "provenance": [],
    "digital_source_type": {},
    "image_data": "data:image/jpeg;base64,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"
  }
}
```

---

## 5. Serve Image Files
**Endpoint:** `/{filename}`  
**HTTP Method:** GET  
**Description:** Serves image files (JPG, JPEG, PNG, GIF) from the server.

**Parameters:**
- `filename` (required): Name of the image file to serve

**Response:** Image file

---

## Usage Examples

### 1. Get EXIF Metadata
```bash
curl -X GET "http://localhost:8080/c2pa/api/exif_metadata?uri=https://library.thecontrarian.in/originals/BELGRADE/MS201711-Belgrade0498.jpg"
```

### 2. Get C2PA Metadata
```bash
curl -X GET "http://localhost:8080/c2pa/api/c2pa_metadata?uri=https://library.thecontrarian.in/originals/BELGRADE/MS201711-Belgrade0498.jpg"
```

### 3. Get Minimal C2PA Credentials
```bash
curl -X GET "http://localhost:8080/c2pa/api/c2pa_mini?uri=https://library.thecontrarian.in/originals/BELGRADE/MS201711-Belgrade0498.jpg"
```

### 4. Upload an Image
```bash
curl -X POST -F "file=@image.jpg" "http://localhost:8080/c2pa/api/upload"
```

---

## Notes

- All endpoints support both local file paths and remote URLs for the `uri` parameter.
- The `/api/c2pa_mini` endpoint uses a 5-minute cache for repeated requests to improve performance.
- Image downloads have a default 30-second timeout, with a shorter 15-second timeout for the mini API.
- CORS is enabled for all origins to allow cross-origin requests from local development environments.
