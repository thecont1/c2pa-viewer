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

## Technology Stack

- **Backend**: Python 3.12, FastAPI, c2pa-python

- **Frontend**: HTML5, CSS3, JavaScript

- **Metadata Extraction**: `c2pa-python` (official C2PA SDK), `pillow` (for EXIF and image processing)

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

## Coding Conventions

### Python
- Follow the PEP 8 coding style
- Use meaningful variable names
- Write docstrings for all functions and classes
- Use type hints where appropriate
- Keep functions and classes small and focused

### JavaScript
- Follow the ESLint rules
- Use meaningful variable names
- Write comments for complex logic
- Keep functions and classes small and focused

### CSS
- Follow the BEM (Block Element Modifier) methodology
- Use meaningful class names
- Keep styles modular and reusable
- Use CSS variables for consistent styling

## Domain Context and Business Rules

### Image Input
The application accepts images via URL parameters. In production, images are loaded from remote URLs. Any local JPG files in the directory are for testing purposes only.

### Image Metadata
The application extracts and displays metadata from images, including:
- EXIF data (camera settings, exposure information, etc.)
- Photography metadata (camera make, model, lens, etc.)
- GPS coordinates (if available)
- IPTC metadata (title, description, keywords, author, etc.)
- C2PA provenance information (actions, edits, verifications)

### C2PA Verification
The application verifies the C2PA signature of images and displays the verification status. If the image has a valid C2PA signature, it will display "Valid" with a green background. If the signature is invalid or not present, it will display "Failed" with a red background.

### C2PA Thumbnails
The application extracts C2PA embedded thumbnails:
- Claim thumbnail: The current state of the image
- Ingredient thumbnail: The original source image before edits

### Actions and Edits
The application extracts and displays the actions performed on images using the C2PA metadata. Actions are grouped and displayed with icons and hover tooltips that provide detailed information about each action.

## Guidelines for Making, Reviewing, and Describing Changes

### Commit Style
- Use meaningful commit messages that describe the change
- Follow the conventional commits format (e.g., "feat: add GPS coordinates rendering")
- Keep commits small and focused on a single change

### PR Expectations
- Each PR should address a single issue or feature
- Include tests for any new functionality
- Follow the established coding conventions
- Use clear and concise PR descriptions

### Review Process
- Assign PRs to at least one reviewer
- Reviewers should check for compliance with coding conventions
- Reviewers should check for functionality and correctness
- Reviewers should provide constructive feedback
