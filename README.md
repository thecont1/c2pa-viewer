# C2PA Viewer

An API-based image viewer web application that allows users to verify [C2PA content credentials](https://contentcredentials.org/) as well as view EXIF and IPTC information embedded within the image.

## Features

### 1. Image Viewer
- Displays the main image with a clean white background and subtle shadow effect
- Shows a "Verified" badge with green checkmark for C2PA-verified images
- Responsive design that works on all screen sizes

### 2. Metadata Extraction
- Extracts EXIF and IPTC metadata from images
- Displays photography information (camera make, model, lens, exposure settings)
- Shows detailed metadata sections:
  - Camera & Lens (make, model, serial numbers)
  - Exposure Settings (aperture, shutter speed, ISO, focal length)
  - Image Details (format, resolution, dimensions)
  - Photographer Information (artist, capture dates)

### 3. C2PA Verification
- Extracts and displays C2PA thumbnails (claim and ingredient images)
- Shows provenance history with timestamps and detailed edit actions
- Displays specific adjustment values (e.g., "Blacks: -5", "Clarity: +20")
- Displays verification status with visual indicators

### 4. API Integration
- RESTful API for metadata extraction
- Accepts image URIs as input
- Handles both local files and remote URLs
- CORS-enabled for cross-origin requests

## API Endpoints

### Core Endpoints

| Endpoint | Method | Description | Performance |
|----------|--------|-------------|-------------|
| `/api/exif_metadata` | GET | EXIF, IPTC, GPS metadata only | Fast (~10-50ms) |
| `/api/c2pa_metadata` | GET | C2PA provenance + thumbnails | Slower (~100-500ms+) |
| `/api/upload` | POST | Upload image, returns all metadata | Variable |

### GET `/api/exif_metadata`

Retrieve EXIF, IPTC, and GPS metadata for an image (no C2PA cryptographic verification).

**Query Parameters:**
- `uri` (required): Image file path or URL

**Example:**
```
GET /api/exif_metadata?uri=https://example.com/image.jpg
```

**Response:**
```json
{
  "image.jpg": {
    "filename": "image.jpg",
    "format": "JPEG",
    "width": 4000,
    "height": 3000,
    "file_size_bytes": 1234567,
    "file_size_mb": 1.18,
    "photography": {
      "camera_make": "Canon",
      "camera_model": "EOS R5",
      "lens_model": "RF 24-70mm f/2.8L",
      "aperture": "f/2.8",
      "shutter_speed": "1/250s",
      "iso": "400",
      "focal_length": "50mm"
    },
    "exif": { "Make": "Canon", "Model": "EOS R5", ... },
    "gps": { "latitude": "40.7128", "longitude": "-74.0060" },
    "iptc": { "title": "Sunset", "description": "A beautiful sunset", ... }
  }
}
```

### GET `/api/c2pa_metadata`

Retrieve C2PA provenance data, including signature information, edit actions, and embedded thumbnails.

**Query Parameters:**
- `uri` (required): Image file path or URL

**Example:**
```
GET /api/c2pa_metadata?uri=https://example.com/image.jpg
```

**Response:**
```json
{
  "provenance": [
    { "name": "Claim Generator", "generator": "Lightroom Classic 15.1" },
    { "name": "Issued By", "issuer": "Adobe Inc." },
    { "name": "Issued On", "date": "Jan 08, 2026 at 04:21 PM IST" },
    { "name": "Author", "author": "John Doe" },
    { "name": "Action", "action": "c2pa.color_adjustments", "parameters": {...} },
    { "name": "Verification", "verification": "Signature Valid" }
  ],
  "c2pa_data": { "basic_info": {...}, "signature_info": {...}, "assertions": [...] },
  "thumbnails": {
    "claim_thumbnail": "base64_encoded_data...",
    "ingredient_thumbnail": "base64_encoded_data..."
  }
}
```

### POST `/api/upload`

Upload an image file and receive complete metadata (EXIF + C2PA) plus the image as a base64 data URL.

**Request:** `multipart/form-data` with file field named `file`

**Example:**
```
POST /api/upload
Content-Type: multipart/form-data
file: [image file]
```

**Response:**
```json
{
  "filename.jpg": {
    "filename": "filename.jpg",
    "format": "JPEG",
    "width": 4000,
    "height": 3000,
    "photography": {...},
    "exif": {...},
    "gps": {...},
    "iptc": {...},
    "provenance": [...],
    "thumbnails": {...},
    "image_data": "data:image/jpeg;base64,..."
  }
}
```

### Static File Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serve the main HTML page |
| `/styles.css` | GET | Serve CSS stylesheet |
| `/script.js` | GET | Serve JavaScript file |
| `/content_credentials_logo.svg` | GET | Serve Content Credentials logo |
| `/{filename}` | GET | Serve image files (jpg, jpeg, png, gif) |

## How to Run the App

### Prerequisites
- Python 3.12 or higher 
- UV package manager ([install](https://docs.astral.sh/uv/getting-started/installation/))

### Installation
1. Clone the repository
   ```bash
   # Open Terminal. 
   # Change the current working directory to where you want the cloned directory.

   git clone https://github.com/thecont1/c2pa-viewer.git
   ```

2. Install dependencies using UV:
   ```
   uv sync
   ```

### Test the API endpoints
The test script makes HTTP requests to localhost:8080, so the server must be running first.

1. Start the server in one terminal:

   ```zsh
   uv run python3 server.py
   ```

2. Run tests in another terminal:

   ```zsh
   uv run python3 test_server.py
   ```

   The server will start on `http://localhost:8080` and serve both the API and frontend.

3. Access the application:

   - Frontend: `http://localhost:8080/`

   - API endpoints: 
      - `http://localhost:8080/api/exif_metadata`
      - `http://localhost:8080/api/c2pa_metadata`
      - `http://localhost:8080/api/upload`

4. **Typical usage**: Pass an image URL to the app.

   [http://localhost:8080/?uri=https://thecontrarian.in/library/originals/GHANA/DSCF9243.jpg](http://localhost:8080/?uri=https://thecontrarian.in/library/originals/GHANA/DSCF9243.jpg)

   This photograph of a moonrise over Accra, Ghana is quite surreal. But is it real? And how real is it? Go ahead and verify its content credentials.

## Technology Stack

- **Backend**: Python 3.12, FastAPI, c2pa-python

- **Frontend**: HTML5, CSS3, JavaScript

- **Metadata Extraction**: [c2pa-python](https://github.com/contentauth/c2pa-python) (official C2PA SDK), [pillow](https://github.com/python-pillow/Pillow) (for EXIF and image processing)

- **Server**: Uvicorn (ASGI server)

## Main Entry Points

- **Frontend**: `index.html` - main HTML file for the application

- **Backend**: `server.py` - FastAPI server that handles all metadata extraction

- **Styles**: `styles.css` - CSS file for styling the application

- **Script**: `script.js` - JavaScript file for rendering metadata

- **Tests**: `test_server.py` - API endpoint tests

## Architecture Notes

### API Design
The API separates EXIF extraction from C2PA verification for performance reasons:
- **EXIF/IPTC extraction** is fast (simple binary parsing)
- **C2PA verification** is slower (cryptographic signature verification, certificate chain validation)

This separation allows external programs to request only the data they need without incurring unnecessary overhead.

### Why FastAPI over Flask
The project uses FastAPI instead of Flask because:
- Modern async/await support
- Built-in data validation with Pydantic
- Automatic API documentation (OpenAPI/Swagger)
- Better type safety and IDE support
- Higher performance

### Why c2pa-python over ExifTool
The project uses the c2pa-python library instead of ExifTool because:
- Official C2PA SDK with proper API
- More reliable metadata extraction
- Better thumbnail extraction
- No external process dependencies
- Direct access to C2PA manifest structure

## File Structure
```
c2pa-viewer/
├── index.html           # Main HTML file
├── styles.css           # Stylesheet for the application
├── script.js            # JavaScript for frontend logic
├── server.py            # FastAPI server with all API endpoints
├── test_server.py       # API endpoint tests
├── pyproject.toml       # Project dependencies (UV)
├── uv.lock              # Dependency lock file
├── archive/             # Archived legacy files
└── README.md            # This file
```

## License
This project is licensed under the MIT License.
