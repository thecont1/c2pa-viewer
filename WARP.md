# Image Metadata Visualization Application

## Project Overview

This project is an image metadata visualization application that allows users to view detailed information about images, including EXIF data, photography metadata, and C2PA provenance information. The application is built with Python and JavaScript, using FastAPI as the backend API and a static HTML/CSS/JavaScript frontend.

## Stack

- **Backend**: Python 3.12, FastAPI, c2pa-python
- **Frontend**: HTML5, CSS3, JavaScript
- **Metadata Extraction**: c2pa-python library (official C2PA SDK), Pillow (for EXIF and image processing)
- **Server**: Uvicorn (ASGI server)

## Main Entry Points

- **Frontend**: `index.html` - main HTML file for the application
- **Backend**: `server.py` - FastAPI server that handles all metadata extraction
- **Styles**: `styles.css` - CSS file for styling the application
- **Script**: `script.js` - JavaScript file for rendering metadata
- **Tests**: `test_server.py` - API endpoint tests

## Agent's Role, Goals, and Constraints

### Role
The AI agent's role is to assist in the development and maintenance of this image metadata visualization application.

### Goals
- Implement new features and improvements based on user requests
- Fix bugs and issues in the application
- Maintain the codebase following the established coding conventions
- Ensure the application is working correctly and efficiently

### Constraints
- The application must be compatible with Python 3.12 and modern web browsers
- All metadata extraction must be done server-side using Python
- The frontend must be a static HTML/CSS/JavaScript application
- The application must follow the established coding conventions

## How to Run the App

### Prerequisites
- Python 3.12 or higher
- UV package manager (recommended)

### Installation
1. Clone the repository
2. Install dependencies using UV:
   ```
   uv pip install -r requirements.txt
   ```

### Running the Application
1. Start the FastAPI server:
   ```
   uv run python3 server.py
   ```
   The server will start on `http://localhost:8080` and serve both the API and frontend.

2. Access the application:
   - Frontend: `http://localhost:8080/`
   - API endpoints: `http://localhost:8080/api/metadata`, `http://localhost:8080/api/c2pa_metadata`, `http://localhost:8080/api/extract_thumbnails`

3. Test with an image URL:
   ```
   http://localhost:8080/?uri=<image_url>
   ```

### Testing
To test the API endpoints:
```
uv run python3 test_server.py
```

To run unit tests:
```
uv run pytest
```

### Linters and Formatters
- **Linter**: Flake8
- **Formatter**: Black

To run the linter:
```
uv run flake8
```

To run the formatter:
```
uv run black .
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

## Archived Files
Redundant implementation files have been moved to the `archive/` directory:
- `api.py` - Old Flask implementation
- `extract_*.py` - Standalone extraction scripts

See `archive/README.md` for details.

## License
This project is licensed under the MIT License.
