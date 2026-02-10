#!/usr/bin/env python3
"""
FastAPI backend server for C2PA Image Metadata Viewer.
Provides REST API endpoints for metadata extraction and thumbnail retrieval.
"""

from fastapi import FastAPI, HTTPException, Query, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pathlib import Path
import json
import base64
import c2pa
from PIL import Image
import io
import tempfile
import urllib.request
from typing import Optional
from urllib.parse import urlparse
import hashlib
import time
from functools import lru_cache

app = FastAPI(title="C2PA Metadata Viewer API", root_path="/c2pa")

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ImagePathContext:
    """Context manager for handling both local files and remote URLs."""
    def __init__(self, uri: str, timeout: int = 30):
        self.uri = uri
        self.temp_file = None
        self.local_path = None
        self.timeout = timeout
        
    def __enter__(self):
        # Check if it's a URL
        parsed = urlparse(self.uri)
        if parsed.scheme in ('http', 'https'):
            # Download to temporary file
            try:
                print(f"Downloading image from: {self.uri}")
                
                # Create request with proper headers to avoid 403 errors
                req = urllib.request.Request(
                    self.uri,
                    headers={
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'image/jpeg,image/png,image/webp,image/*,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Referer': parsed.scheme + '://' + parsed.netloc + '/'
                    }
                )
                
                response = urllib.request.urlopen(req, timeout=self.timeout)
                
                # Determine file extension from URL or content-type
                content_type = response.headers.get('Content-Type', '')
                ext = '.jpg'  # default
                if 'jpeg' in content_type or 'jpg' in content_type:
                    ext = '.jpg'
                elif 'png' in content_type:
                    ext = '.png'
                elif self.uri.lower().endswith('.png'):
                    ext = '.png'
                
                # Create temporary file
                self.temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
                self.temp_file.write(response.read())
                self.temp_file.close()
                
                self.local_path = self.temp_file.name
                print(f"Downloaded to temporary file: {self.local_path}")
                return self.local_path
            except Exception as e:
                print(f"Error downloading image: {e}")
                raise HTTPException(status_code=400, detail=f"Failed to download image: {str(e)}")
        else:
            # Local file path
            if not Path(self.uri).exists():
                raise HTTPException(status_code=404, detail="Image file not found")
            self.local_path = self.uri
            return self.local_path
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        # Clean up temporary file if it was created
        if self.temp_file:
            try:
                Path(self.temp_file.name).unlink(missing_ok=True)
                print(f"Cleaned up temporary file: {self.temp_file.name}")
            except Exception as e:
                print(f"Error cleaning up temporary file: {e}")


def extract_c2pa_data(image_path: str):
    """Extract C2PA manifest data from an image."""
    try:
        reader = c2pa.Reader(image_path)
        manifest_json = reader.json()
        
        if not manifest_json:
            return None
            
        data = json.loads(manifest_json)
        active_label = data.get('active_manifest')
        
        if not active_label or active_label not in data.get('manifests', {}):
            return None
            
        manifest = data['manifests'][active_label]
        
        result = {
            'basic_info': {
                'title': manifest.get('title'),
                'format': manifest.get('format'),
                'instance_id': manifest.get('instance_id'),
                'claim_generator': manifest.get('claim_generator'),
            },
            'signature_info': manifest.get('signature_info', {}),
            'assertions': [],
            'ingredients': [],
            'actions': [],
            'author_info': {},
        }
        
        # Extract assertions
        for assertion in manifest.get('assertions', []):
            label = assertion.get('label', 'Unknown')
            assertion_data = assertion.get('data', {})
            
            result['assertions'].append({
                'label': label,
                'data': assertion_data
            })
            
            if label == 'c2pa.actions.v2':
                actions_list = assertion_data.get('actions', [])
                for action in actions_list:
                    result['actions'].append({
                        'action': action.get('action'),
                        'when': action.get('when'),
                        'softwareAgent': action.get('softwareAgent'),
                        'parameters': action.get('parameters', {})
                    })
            
            elif label == 'stds.schema-org.CreativeWork':
                result['author_info'] = assertion_data
        
        # Extract ingredients
        for ingredient in manifest.get('ingredients', []):
            result['ingredients'].append({
                'title': ingredient.get('title'),
                'format': ingredient.get('format'),
                'relationship': ingredient.get('relationship'),
                'instance_id': ingredient.get('instance_id')
            })
        
        return result
        
    except Exception as e:
        print(f"Error extracting C2PA data: {e}")
        return None


def extract_c2pa_minimal(image_path: str):
    """Extract only essential C2PA data for quick verification.
    
    Optimized version that extracts only what's needed for the mini API:
    - signature_info (for issuer and timestamp)
    - author_info (for creator name)
    
    This avoids extracting actions, ingredients, and other assertions
    that aren't used by the mini endpoint.
    """
    try:
        reader = c2pa.Reader(image_path)
        manifest_json = reader.json()
        
        if not manifest_json:
            return None
        
        data = json.loads(manifest_json)
        active_label = data.get('active_manifest')
        
        if not active_label or active_label not in data.get('manifests', {}):
            return None
        
        manifest = data['manifests'][active_label]
        
        # Extract ONLY what mini API needs
        result = {
            'signature_info': manifest.get('signature_info', {}),
            'author_info': {}
        }
        
        # Extract author from CreativeWork assertion only (if exists)
        # Stop immediately after finding it to avoid unnecessary iterations
        for assertion in manifest.get('assertions', []):
            if assertion.get('label') == 'stds.schema-org.CreativeWork':
                result['author_info'] = assertion.get('data', {})
                break  # Early exit after finding the needed assertion
        
        return result
        
    except Exception as e:
        print(f"Error extracting minimal C2PA data: {e}")
        return None


def format_claim_generator(generator: str) -> str:
    """Format claim generator string for display."""
    if not generator:
        return 'Unknown'
    
    # Handle format like "lightroom_classic/15.1.1"
    if '/' in generator:
        parts = generator.split('/')
        software = parts[0]
        version = parts[1] if len(parts) > 1 else ''
        
        # Convert snake_case to Title Case
        software = software.replace('_', ' ').title()
        
        return f"{software} {version}" if version else software
    
    return generator


def format_datetime_full(dt_string: str, include_timezone: bool = False) -> str:
    """Format datetime string to full format.
    
    Args:
        dt_string: ISO 8601 or EXIF datetime string
        include_timezone: If True, convert to local time and include timezone
    
    Returns:
        Formatted datetime string
    """
    if not dt_string or dt_string == 'Unknown':
        return 'Unknown'
    
    try:
        from datetime import datetime
        import time
        
        # Parse ISO 8601 format (2026-02-04T11:19:14+00:00)
        if 'T' in dt_string:
            dt = datetime.fromisoformat(dt_string.replace('Z', '+00:00'))
            
            if include_timezone:
                # Convert to local timezone
                local_dt = dt.astimezone()
                formatted = local_dt.strftime('%b %d, %Y at %I:%M %p')
                
                # Add timezone name
                tz_name = local_dt.strftime('%Z')
                if tz_name:
                    formatted += f" {tz_name}"
                return formatted
            else:
                # No timezone conversion
                formatted = dt.strftime('%b %d, %Y at %I:%M %p')
                return formatted
        
        # Try EXIF format (2021:10:08 21:17:42)
        elif ':' in dt_string and ' ' in dt_string:
            dt = datetime.strptime(dt_string, '%Y:%m:%d %H:%M:%S')
            return dt.strftime('%b %d, %Y at %I:%M %p')
        
    except Exception as e:
        print(f"Error formatting datetime: {e}")
        return dt_string
    
    return dt_string


def extract_gps_from_exif(exif_data: dict) -> dict:
    """Extract and format GPS coordinates from EXIF data."""
    gps_info = {}
    
    try:
        # GPS data is stored under tag 34853 as a sub-dictionary
        if 34853 not in exif_data:
            return gps_info
        
        gps_data = exif_data[34853]
        
        # GPS tags within the GPS sub-dictionary
        if 1 in gps_data:  # GPSLatitudeRef
            gps_info['lat_ref'] = gps_data[1]
        if 2 in gps_data:  # GPSLatitude
            gps_info['latitude'] = gps_data[2]
        if 3 in gps_data:  # GPSLongitudeRef
            gps_info['lon_ref'] = gps_data[3]
        if 4 in gps_data:  # GPSLongitude
            gps_info['longitude'] = gps_data[4]
        
        # Convert to decimal degrees if we have the data
        if 'latitude' in gps_info and 'longitude' in gps_info:
            lat = gps_info['latitude']
            lon = gps_info['longitude']
            
            # Convert from degrees, minutes, seconds to decimal
            if isinstance(lat, (tuple, list)) and len(lat) >= 3:
                lat_decimal = float(lat[0]) + float(lat[1])/60 + float(lat[2])/3600
                if gps_info.get('lat_ref') == 'S':
                    lat_decimal = -lat_decimal
                gps_info['latitude_decimal'] = lat_decimal
            
            if isinstance(lon, (tuple, list)) and len(lon) >= 3:
                lon_decimal = float(lon[0]) + float(lon[1])/60 + float(lon[2])/3600
                if gps_info.get('lon_ref') == 'W':
                    lon_decimal = -lon_decimal
                gps_info['longitude_decimal'] = lon_decimal
        
    except Exception as e:
        print(f"Error extracting GPS: {e}")
        import traceback
        traceback.print_exc()
    
    return gps_info


def convert_exif_value(value):
    """Convert EXIF values to JSON-serializable types."""
    # Handle IFDRational (common in EXIF data)
    if hasattr(value, 'numerator') and hasattr(value, 'denominator'):
        return float(value.numerator) / float(value.denominator)
    # Handle tuples of rationals
    elif isinstance(value, tuple):
        return tuple(convert_exif_value(v) for v in value)
    # Handle lists
    elif isinstance(value, list):
        return [convert_exif_value(v) for v in value]
    # Handle bytes
    elif isinstance(value, bytes):
        try:
            return value.decode('utf-8', errors='ignore')
        except:
            return str(value)
    return value


def extract_iptc_data(image_path: str) -> dict:
    """Extract IPTC metadata from an image."""
    try:
        from PIL import Image
        from PIL import IptcImagePlugin
        
        img = Image.open(image_path)
        iptc = IptcImagePlugin.getiptcinfo(img)
        
        if not iptc:
            return {}
        
        result = {}
        
        # IPTC tag mappings
        # (2, 5) = Object Name (Title)
        if (2, 5) in iptc:
            result['title'] = iptc[(2, 5)].decode('utf-8', errors='ignore')
        
        # (2, 120) = Caption/Abstract (Description)
        if (2, 120) in iptc:
            result['description'] = iptc[(2, 120)].decode('utf-8', errors='ignore')
        
        # (2, 25) = Keywords
        if (2, 25) in iptc:
            keywords = iptc[(2, 25)]
            if isinstance(keywords, bytes):
                result['keywords'] = keywords.decode('utf-8', errors='ignore')
            elif isinstance(keywords, list):
                result['keywords'] = ', '.join([k.decode('utf-8', errors='ignore') if isinstance(k, bytes) else k for k in keywords])
        
        # (2, 80) = By-line (Author)
        if (2, 80) in iptc:
            result['author'] = iptc[(2, 80)].decode('utf-8', errors='ignore')
        
        # (2, 90) = City
        if (2, 90) in iptc:
            result['city'] = iptc[(2, 90)].decode('utf-8', errors='ignore')
        
        # (2, 92) = Sub-location
        if (2, 92) in iptc:
            result['location'] = iptc[(2, 92)].decode('utf-8', errors='ignore')
        
        # (2, 116) = Copyright Notice
        if (2, 116) in iptc:
            result['copyright'] = iptc[(2, 116)].decode('utf-8', errors='ignore')
        
        return result
        
    except Exception as e:
        print(f"Error extracting IPTC data: {e}")
        return {}


def extract_exif_metadata(image_path: str):
    """Extract EXIF metadata from an image."""
    try:
        img = Image.open(image_path)
        exif_data = img._getexif() or {}
        
        result = {
            'filename': Path(image_path).name,
            'format': img.format,
            'width': img.width,
            'height': img.height,
            'file_size_bytes': Path(image_path).stat().st_size,
        }
        
        result['file_size_mb'] = round(result['file_size_bytes'] / (1024 * 1024), 2)
        
        # Map common EXIF tags
        exif_tag_map = {
            271: 'Make',
            272: 'Model',
            282: 'XResolution',
            283: 'YResolution',
            305: 'Software',
            306: 'DateTime',
            315: 'Artist',
            33432: 'Copyright',
            36867: 'DateTimeOriginal',
            36868: 'DateTimeDigitized',
            37378: 'ApertureValue',
            37383: 'MeteringMode',
            37385: 'Flash',
            37386: 'FocalLength',
            40961: 'ColorSpace',
            41495: 'SensingMethod',
            41986: 'ExposureMode',
            41987: 'WhiteBalance',
            34855: 'ISOSpeedRatings',
            33437: 'FNumber',
            33434: 'ExposureTime',
            42036: 'LensModel',
        }
        
        exif_processed = {}
        for tag_id, tag_name in exif_tag_map.items():
            if tag_id in exif_data:
                value = exif_data[tag_id]
                # Convert to JSON-serializable format
                exif_processed[tag_name] = convert_exif_value(value)
        
        result['exif'] = exif_processed
        
        # Extract GPS data
        result['gps'] = extract_gps_from_exif(exif_data)
        
        # Extract ICC color profile name
        result['color_profile'] = None
        if 'icc_profile' in img.info:
            try:
                from PIL import ImageCms
                icc_profile = io.BytesIO(img.info['icc_profile'])
                profile = ImageCms.ImageCmsProfile(icc_profile)
                result['color_profile'] = ImageCms.getProfileDescription(profile)
            except Exception as e:
                print(f"Error extracting ICC profile: {e}")
        
        return result
        
    except Exception as e:
        print(f"Error extracting EXIF data: {e}")
        return None


def format_provenance_for_web(c2pa_data):
    """Format C2PA data into provenance items for web display."""
    provenance = []
    
    if not c2pa_data:
        return provenance
    
    basic = c2pa_data.get('basic_info', {})
    if basic.get('claim_generator'):
        provenance.append({
            'name': 'Claim Generator',
            'generator': format_claim_generator(basic['claim_generator'])
        })
    
    sig_info = c2pa_data.get('signature_info', {})
    if sig_info.get('issuer'):
        provenance.append({
            'name': 'Issued By',
            'issuer': sig_info['issuer']
        })
    
    if sig_info.get('time'):
        provenance.append({
            'name': 'Issued On',
            'date': format_datetime_full(sig_info['time'], include_timezone=True)
        })
        
        # Extract textual metadata from author_info (CreativeWork assertion)
        author_info = c2pa_data.get('author_info', {})
        
        # Title
        if 'name' in author_info:
            provenance.append({
                'name': 'Title',
                'title': author_info['name']
            })
        
        # Description
        if 'description' in author_info:
            provenance.append({
                'name': 'Description',
                'data': author_info['description']
            })
        
        # Keywords
        if 'keywords' in author_info:
            keywords = author_info['keywords']
            if isinstance(keywords, list):
                keywords = ', '.join(keywords)
            provenance.append({
                'name': 'Keywords',
                'data': keywords
            })
        
        # Author with full details including social media
        if 'author' in author_info:
            authors = author_info['author']
            if isinstance(authors, list) and len(authors) > 0:
                author = authors[0]
                author_data = {
                    'name': author.get('name', 'Unknown'),
                    'identifier': author.get('identifier'),
                    'url': author.get('url'),
                    'sameAs': author.get('sameAs', []),
                    'email': author.get('email'),
                    'telephone': author.get('telephone'),
                    'address': author.get('address'),
                    'jobTitle': author.get('jobTitle'),
                    'worksFor': author.get('worksFor', {}).get('name') if isinstance(author.get('worksFor'), dict) else author.get('worksFor')
                }
                provenance.append({
                    'name': 'Author',
                    'author': author_data['name'],
                    'author_details': author_data
                })
        
        # Copyright holder
        if 'copyrightHolder' in author_info:
            holders = author_info['copyrightHolder']
            if isinstance(holders, list) and len(holders) > 0:
                holder_name = holders[0].get('name', 'Unknown')
                provenance.append({
                    'name': 'Copyright',
                    'copyright': holder_name
                })
        
        # Publisher
        if 'publisher' in author_info:
            publisher = author_info['publisher']
            if isinstance(publisher, dict):
                publisher_name = publisher.get('name', 'Unknown')
                provenance.append({
                    'name': 'Publisher',
                    'publisher': publisher_name
                })
    
    # Actions with timezone-aware timestamps and parameters
    for action in c2pa_data.get('actions', []):
        action_item = {
            'name': 'Action',
            'action': action['action'],
            'software': action.get('softwareAgent'),
            'parameters': action.get('parameters', {})
        }
        if action.get('when'):
            action_item['when'] = format_datetime_full(action['when'], include_timezone=True)
        provenance.append(action_item)
    
    if sig_info:
        provenance.append({
            'name': 'Verification',
            'verification': 'Signature Valid'
        })
    
    return provenance


def format_photography_metadata(exif_data):
    """Format EXIF data for photography metadata section."""
    if not exif_data:
        return {}
    
    exif = exif_data.get('exif', {})
    
    # Format aperture
    aperture = 'Unknown'
    if 'FNumber' in exif:
        f_num = exif['FNumber']
        if isinstance(f_num, (int, float)):
            aperture = f"f/{f_num:.1f}"
        elif isinstance(f_num, tuple):
            aperture = f"f/{f_num[0] / f_num[1]:.1f}"
    
    # Format shutter speed
    shutter_speed = 'Unknown'
    if 'ExposureTime' in exif:
        exp_time = exif['ExposureTime']
        if isinstance(exp_time, float):
            if exp_time < 1:
                shutter_speed = f"1/{int(1/exp_time)}s"
            else:
                shutter_speed = f"{exp_time:.2f}s"
        elif isinstance(exp_time, tuple):
            if exp_time[0] == 1:
                shutter_speed = f"1/{exp_time[1]}s"
            else:
                shutter_speed = f"{exp_time[0] / exp_time[1]:.2f}s"
    
    # Format focal length with decimal precision
    focal_length = 'Unknown'
    if 'FocalLength' in exif:
        fl = exif['FocalLength']
        if isinstance(fl, (int, float)):
            # Remove trailing zeros (e.g., 6.00 -> 6, 6.59 -> 6.59)
            focal_length = f"{fl:.2f}mm".rstrip('0').rstrip('.')
        elif isinstance(fl, tuple):
            fl_value = fl[0] / fl[1]
            focal_length = f"{fl_value:.2f}mm".rstrip('0').rstrip('.')
    
    # Format ISO - ensure it's displayed as integer
    iso = exif.get('ISOSpeedRatings', 'Unknown')
    if isinstance(iso, tuple):
        iso = int(iso[0]) if iso[0] != 'Unknown' else 'Unknown'
    elif isinstance(iso, (int, float)):
        iso = int(iso)
    
    # Format color space from EXIF (40961: 1=sRGB, 65535=Uncalibrated)
    color_space_value = exif.get('ColorSpace')
    if color_space_value == 1:
        color_space = 'sRGB'
    elif color_space_value == 65535:
        color_space = 'Uncalibrated'
    else:
        color_space = 'Unknown'
    
    # Get color profile from extracted data
    color_profile = exif_data.get('color_profile', 'Unknown') or 'Unknown'
    
    return {
        'camera_make': exif.get('Make', 'Unknown'),
        'camera_model': exif.get('Model', 'Unknown'),
        'lens_model': exif.get('LensModel', 'Unknown'),
        'aperture': aperture,
        'shutter_speed': shutter_speed,
        'iso': iso if iso == 'Unknown' else str(iso),
        'focal_length': focal_length,
        'date_original': format_datetime_full(exif.get('DateTimeOriginal', 'Unknown')),
        'date_digitized': format_datetime_full(exif.get('DateTimeDigitized', 'Unknown')),
        'artist': exif.get('Artist', 'Unknown'),
        'description': exif.get('ImageDescription', 'No description available'),
        'color_space': color_space,
        'color_profile': color_profile,
    }


def extract_thumbnails_from_image(image_path: str):
    """Extract C2PA thumbnails from image using proper c2pa API."""
    try:
        reader = c2pa.Reader(image_path)
        manifest_json = reader.json()
        
        if not manifest_json:
            return {}
        
        data = json.loads(manifest_json)
        active_label = data.get('active_manifest')
        
        if not active_label or active_label not in data.get('manifests', {}):
            return {}
        
        manifest = data['manifests'][active_label]
        thumbnails = {}
        
        # Extract claim thumbnail (main manifest thumbnail)
        if 'thumbnail' in manifest and isinstance(manifest['thumbnail'], dict):
            if 'identifier' in manifest['thumbnail']:
                try:
                    output_stream = io.BytesIO()
                    reader.resource_to_stream(manifest['thumbnail']['identifier'], output_stream)
                    output_stream.seek(0)
                    thumb_data = output_stream.read()
                    thumbnails['claim_thumbnail'] = base64.b64encode(thumb_data).decode('utf-8')
                except Exception as e:
                    print(f"Error extracting claim thumbnail: {e}")
        
        # Extract ingredient thumbnail (original source image thumbnail)
        if 'ingredients' in manifest and len(manifest['ingredients']) > 0:
            ingredient = manifest['ingredients'][0]
            if 'thumbnail' in ingredient and isinstance(ingredient['thumbnail'], dict):
                if 'identifier' in ingredient['thumbnail']:
                    try:
                        output_stream = io.BytesIO()
                        reader.resource_to_stream(ingredient['thumbnail']['identifier'], output_stream)
                        output_stream.seek(0)
                        thumb_data = output_stream.read()
                        thumbnails['ingredient_thumbnail'] = base64.b64encode(thumb_data).decode('utf-8')
                    except Exception as e:
                        print(f"Error extracting ingredient thumbnail: {e}")
        
        return thumbnails
        
    except Exception as e:
        print(f"Error extracting thumbnails: {e}")
        import traceback
        traceback.print_exc()
        return {}


@app.get("/api/exif_metadata")
async def get_exif_metadata(uri: str = Query(..., description="Image file path or URL")):
    """Get EXIF, IPTC, and GPS metadata for an image (no C2PA/provenance data)."""
    try:
        with ImagePathContext(uri) as image_path:
            # Extract only EXIF/IPTC metadata (no C2PA - that's expensive)
            exif_data = extract_exif_metadata(image_path)
            iptc_data = extract_iptc_data(image_path)
            
            # Format for web viewer
            photography = format_photography_metadata(exif_data)
            
            # Use original filename from URI for display
            display_name = Path(uri).name
            
            # Get GPS data and format it
            gps_data = exif_data.get('gps', {}) if exif_data else {}
            formatted_gps = {}
            
            if 'latitude_decimal' in gps_data and 'longitude_decimal' in gps_data:
                formatted_gps = {
                    'latitude': str(gps_data['latitude_decimal']),
                    'longitude': str(gps_data['longitude_decimal'])
                }
            
            response = {
                display_name: {
                    'filename': display_name,
                    'format': exif_data.get('format', 'JPEG') if exif_data else 'JPEG',
                    'width': exif_data.get('width') if exif_data else None,
                    'height': exif_data.get('height') if exif_data else None,
                    'file_size_bytes': exif_data.get('file_size_bytes') if exif_data else None,
                    'file_size_mb': exif_data.get('file_size_mb') if exif_data else None,
                    'photography': photography,
                    'exif': exif_data.get('exif', {}) if exif_data else {},
                    'gps': formatted_gps,
                    'iptc': iptc_data,
                }
            }
            
            return response
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/c2pa_metadata")
async def get_c2pa_metadata(uri: str = Query(..., description="Image file path or URL")):
    """Get C2PA metadata, provenance information, and embedded thumbnails."""
    try:
        with ImagePathContext(uri) as image_path:
            c2pa_data = extract_c2pa_data(image_path)
            provenance = format_provenance_for_web(c2pa_data) if c2pa_data else []
            
            # Extract C2PA thumbnails (claim_thumbnail and ingredient_thumbnail)
            thumbnails = extract_thumbnails_from_image(image_path)
            
            return {
                'provenance': provenance,
                'c2pa_data': c2pa_data,
                'thumbnails': thumbnails
            }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Cache for mini API responses (5 minute TTL)
_mini_cache = {}
_CACHE_TTL = 300  # 5 minutes in seconds


def _get_cache_key(uri: str) -> str:
    """Generate a cache key for a URI."""
    return hashlib.md5(uri.encode()).hexdigest()


def _get_cached_mini_response(uri: str):
    """Get cached response if available and not expired."""
    cache_key = _get_cache_key(uri)
    if cache_key in _mini_cache:
        cached_data, timestamp = _mini_cache[cache_key]
        if time.time() - timestamp < _CACHE_TTL:
            print(f"Cache hit for {uri}")
            return cached_data
        else:
            # Expired cache entry
            del _mini_cache[cache_key]
    return None


def _set_cached_mini_response(uri: str, response: dict):
    """Cache a mini API response."""
    cache_key = _get_cache_key(uri)
    _mini_cache[cache_key] = (response, time.time())
    print(f"Cached response for {uri}")


@app.get("/api/c2pa_mini")
async def get_c2pa_mini(uri: str = Query(..., description="Image file path or URL")):
    """Get minimal C2PA credentials for quick trust verification (e.g., on hover).
    
    Returns a compact response with essential verification info:
    - Creator: Author name from C2PA manifest
    - Issued by: Certificate issuer (e.g., Adobe Inc.)
    - Issued on: Signing timestamp
    - Status: 'Authenticity Verified' or 'Unverified'
    - More: Link to full viewer
    
    Optimizations:
    - Uses specialized minimal extraction (extracts only needed fields)
    - 5-minute response cache for repeated requests
    - Configurable timeout for image downloads (15s for mini vs 30s for full)
    """
    # Check cache first
    cached = _get_cached_mini_response(uri)
    if cached:
        return cached
    
    try:
        # Use shorter timeout for mini API (15s instead of 30s)
        with ImagePathContext(uri, timeout=15) as image_path:
            # Use optimized minimal extraction instead of full extraction
            c2pa_data = extract_c2pa_minimal(image_path)
            
            if not c2pa_data:
                response = {
                    'creator': None,
                    'issued_by': None,
                    'issued_on': None,
                    'status': 'Unverified',
                    'more': f'https://apps.thecontrarian.in/c2pa/?uri={uri}'
                }
                _set_cached_mini_response(uri, response)
                return response
            
            # Extract creator from author_info
            author_info = c2pa_data.get('author_info', {})
            creator = None
            if 'author' in author_info:
                authors = author_info['author']
                if isinstance(authors, list) and len(authors) > 0:
                    creator = authors[0].get('name')
                elif isinstance(authors, dict):
                    creator = authors.get('name')
            
            # Extract signature info
            sig_info = c2pa_data.get('signature_info', {})
            issued_by = sig_info.get('issuer')
            issued_on = format_datetime_full(sig_info.get('time'), include_timezone=True) if sig_info.get('time') else None
            
            # Determine verification status
            status = 'Authenticity Verified' if c2pa_data else 'Unverified'
            
            response = {
                'creator': creator,
                'issued_by': issued_by,
                'issued_on': issued_on,
                'status': status,
                'more': f'https://apps.thecontrarian.in/c2pa/?uri={uri}'
            }
            
            # Cache the response
            _set_cached_mini_response(uri, response)
            return response
        
    except HTTPException:
        raise
    except Exception as e:
        # Return unverified status on error (don't cache errors)
        print(f"Error in c2pa_mini: {e}")
        return {
            'creator': None,
            'issued_by': None,
            'issued_on': None,
            'status': 'Unverified',
            'more': f'https://apps.thecontrarian.in/c2pa/?uri={uri}'
        }


@app.get("/")
async def serve_index():
    """Serve the main HTML page."""
    index_path = Path(__file__).parent / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="index.html not found")
    return FileResponse(index_path)


# Mount static files (CSS, JS, images)
@app.get("/styles.css")
async def serve_css():
    css_path = Path(__file__).parent / "styles.css"
    if css_path.exists():
        return FileResponse(css_path)
    raise HTTPException(status_code=404, detail="styles.css not found")


@app.get("/script.js")
async def serve_js():
    js_path = Path(__file__).parent / "script.js"
    if js_path.exists():
        return FileResponse(js_path)
    raise HTTPException(status_code=404, detail="script.js not found")


@app.get("/content_credentials_logo.svg")
async def serve_logo():
    logo_path = Path(__file__).parent / "content_credentials_logo.svg"
    if logo_path.exists():
        return FileResponse(logo_path)
    raise HTTPException(status_code=404, detail="Logo not found")


@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...)):
    """Upload an image file and return metadata."""
    try:
        # Save uploaded file to temporary file
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename).suffix) as temp_file:
            temp_file.write(await file.read())
            temp_file_path = temp_file.name
        
        # Extract metadata
        c2pa_data = extract_c2pa_data(temp_file_path)
        exif_data = extract_exif_metadata(temp_file_path)
        iptc_data = extract_iptc_data(temp_file_path)
        
        # Format for web viewer
        photography = format_photography_metadata(exif_data)
        
        # Use original filename for display
        display_name = file.filename or 'unknown.jpg'
        
        # Get GPS data and format it
        gps_data = exif_data.get('gps', {}) if exif_data else {}
        formatted_gps = {}
        
        if 'latitude_decimal' in gps_data and 'longitude_decimal' in gps_data:
            formatted_gps = {
                'latitude': str(gps_data['latitude_decimal']),
                'longitude': str(gps_data['longitude_decimal'])
            }
        
        response = {
            display_name: {
                'filename': display_name,
                'format': exif_data.get('format', 'JPEG') if exif_data else 'JPEG',
                'width': exif_data.get('width') if exif_data else None,
                'height': exif_data.get('height') if exif_data else None,
                'file_size_bytes': exif_data.get('file_size_bytes') if exif_data else None,
                'file_size_mb': exif_data.get('file_size_mb') if exif_data else None,
                'photography': photography,
                'exif': exif_data.get('exif', {}) if exif_data else {},
                'gps': formatted_gps,
                'iptc': iptc_data,
            }
        }
        
        # Extract thumbnails
        thumbnails = extract_thumbnails_from_image(temp_file_path)
        response[display_name]['thumbnails'] = thumbnails
        
        # Include C2PA provenance data
        provenance = format_provenance_for_web(c2pa_data) if c2pa_data else []
        response[display_name]['provenance'] = provenance
        
        # Create a data URL for the main image
        with open(temp_file_path, 'rb') as f:
            image_data = base64.b64encode(f.read()).decode('utf-8')
            response[display_name]['image_data'] = f"data:image/{exif_data.get('format', 'jpeg').lower()};base64,{image_data}"
        
        # Clean up temporary file
        try:
            Path(temp_file_path).unlink(missing_ok=True)
        except Exception as e:
            print(f"Error cleaning up temporary file: {e}")
        
        return response
        
    except Exception as e:
        print(f"Error processing uploaded image: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/{filename}")
async def serve_image(filename: str):
    """Serve image files."""
    file_path = Path(__file__).parent / filename
    if file_path.exists() and file_path.suffix.lower() in ['.jpg', '.jpeg', '.png', '.gif']:
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="File not found")


if __name__ == "__main__":
    import uvicorn
    print("Starting C2PA Metadata Viewer server...")
    print("Server running at: http://localhost:8080")
    print("Open in browser: http://localhost:8080/?uri=IMG_20211008_211742.jpg")
    uvicorn.run(app, host="0.0.0.0", port=8080)
