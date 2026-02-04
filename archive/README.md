# Archive Folder

This folder contains redundant files that were removed from the main project during cleanup on 2026-02-04.

## Archived Files

### Flask Implementation (Superseded)
- **api.py** - Flask-based API server (replaced by FastAPI `server.py`)
  - Used Flask + Flask-CORS
  - Imported functions from `extract_c2pa.py`
  - Less complete than FastAPI version

### Helper Scripts (Superseded)
- **extract_metadata.py** - Basic EXIF extraction only
  - Standalone script for EXIF data
  - Functionality now integrated in `server.py`

- **extract_c2pa.py** - C2PA extraction using exiftool
  - Used by `api.py`
  - Regex-based thumbnail extraction
  - Less reliable than c2pa-python library

- **extract_c2pa_improved.py** - C2PA extraction using c2pa-python
  - Standalone script, not integrated
  - Similar to what's now in `server.py`

- **extract_c2pa_thumbnails.py** - Thumbnail extraction only
  - Regex-based approach
  - Standalone script, not integrated

## Why These Were Archived

The project had two parallel implementations:
1. **Flask track**: `api.py` + helper scripts
2. **FastAPI track**: `server.py` (all-in-one)

The FastAPI implementation (`server.py`) is superior because:
- Modern FastAPI framework vs older Flask
- Uses c2pa-python library (official) instead of exiftool parsing
- All functionality integrated (no external script dependencies)
- Better error handling and type safety
- Supports both local files and remote URLs
- More complete metadata extraction

## Active Implementation

**Keep using**: `server.py` (FastAPI + c2pa-python)
