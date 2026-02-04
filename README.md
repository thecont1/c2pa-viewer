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
- Shows provenance history with timestamps and actions
- Displays verification status with visual indicators

### 4. API Integration
- RESTful API for metadata extraction
- Accepts image URIs as input
- Handles both local files and remote URLs
- CORS-enabled for cross-origin requests

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
      - `http://localhost:8080/api/metadata`
      - `http://localhost:8080/api/c2pa_metadata`
      - `http://localhost:8080/api/extract_thumbnails`

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
