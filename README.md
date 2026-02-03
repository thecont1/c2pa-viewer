# Image Metadata Viewer with C2PA Verification

A modern web application that extracts and displays comprehensive metadata from images using C2PA (Coalition for Content Provenance and Authenticity) standards.

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
  - Advanced Settings (metering mode, flash, white balance)

### 3. C2PA Verification
- Extracts and displays C2PA thumbnails (claim and ingredient images)
- Shows provenance history with timestamps and actions
- Displays verification status with visual indicators

### 4. API Integration
- RESTful API for metadata extraction
- Accepts image URIs as input
- Handles both local files and remote URLs
- CORS-enabled for cross-origin requests

## Technology Stack

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Backend**: Flask (Python 3.13)
- **Image Processing**: PIL/Pillow library
- **C2PA Support**: Custom extraction script for C2PA thumbnails

## Usage

### Starting the Application

1. **Start the API server**:
   ```bash
   uv run python3 api.py
   ```
   The API will run on http://localhost:8080

2. **Start the web server**:
   ```bash
   uv run python3 -m http.server 8000
   ```

3. **Open the application**:
   Navigate to `http://localhost:8000/index.html?uri=<image_path>`

### Examples

**Local File**:
```
http://localhost:8000/index.html?uri=MS201711-Belgrade0536.jpg
```

**Remote URL**:
```
http://localhost:8000/index.html?uri=https://example.com/images/photo.jpg
```

## Project Structure

```
c2pa_metadata_viewer/
├── index.html              # Main HTML file
├── styles.css              # Stylesheet for the application
├── script.js               # JavaScript for frontend logic
├── api.py                  # Flask API server
├── extract_c2pa.py         # C2PA thumbnail extraction script
├── extract_c2pa_thumbnails.py # Helper script for C2PA extraction
└── README.md               # This file
```

## API Endpoints

### `/api/metadata`
- **Method**: GET
- **Description**: Extract metadata from an image URI
- **Parameters**: `uri` (required) - Image URI to process
- **Response**: JSON object with metadata

### `/api/extract_thumbnails`
- **Method**: GET
- **Description**: Extract C2PA thumbnails from an image
- **Parameters**: `uri` (required) - Image URI to process
- **Response**: JSON object with base64-encoded thumbnails

## Browser Support

- Chrome 60+
- Firefox 55+
- Safari 12+
- Edge 79+

## Requirements

- Python 3.13+
- Flask 3.0+
- Pillow 10.0+
- requests 2.30+

## Installation

1. **Create virtual environment**:
   ```bash
   uv venv
   ```

2. **Install dependencies**:
   ```bash
   uv pip install flask flask-cors pillow requests
   ```

3. **Run the application** (as described in Usage section)

## Notes

- The application supports C2PA-verified images with embedded metadata
- Local file paths must be accessible from the server
- Remote URLs must be publicly accessible
- Metadata extraction may vary depending on image format and metadata completeness

## License

This project is licensed under the MIT License.