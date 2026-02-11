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
    "iptc": {}
  }
}
```

**Note:** This endpoint returns only metadata (KB-sized response). The client already has the image URI and can display it directly. For uploaded files (via `/api/upload`), the response includes `image_data` since there's no URI to reference.

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
    "iptc": {}
    "thumbnails": {},
    "provenance": [],
    "digital_source_type": {},
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
