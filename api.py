#!/usr/bin/env python3
"""
API endpoint to extract metadata from images and serve as JSON.
"""

import os
import json
from PIL import Image
from PIL.ExifTags import TAGS
from io import BytesIO
import base64
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

def get_exif_data(image_path):
    """Extract EXIF metadata from image file."""
    try:
        image = Image.open(image_path)
        exif_data = image._getexif()
        
        if exif_data is not None:
            exif = {}
            for tag, value in exif_data.items():
                tag_name = TAGS.get(tag, tag)
                exif[tag_name] = value
            return exif
        return {}
    except Exception as e:
        app.logger.error(f"Error extracting EXIF data: {e}")
        return {}

def get_image_dimensions(image_path):
    """Get image dimensions."""
    try:
        image = Image.open(image_path)
        return image.size
    except Exception as e:
        app.logger.error(f"Error getting dimensions: {e}")
        return (0, 0)

def extract_metadata(image_path):
    """Extract all metadata from image file."""
    exif_data = get_exif_data(image_path)
    width, height = get_image_dimensions(image_path)
    
    # Convert IFDRational to float for JSON serialization
    processed_exif = {}
    for key, value in exif_data.items():
        try:
            # Handle IFDRational (from PIL)
            from PIL.TiffImagePlugin import IFDRational
            if isinstance(value, IFDRational):
                processed_exif[key] = float(value)
            elif hasattr(value, 'numerator') and hasattr(value, 'denominator'):
                processed_exif[key] = float(value.numerator / value.denominator)
            elif isinstance(value, (int, float)):
                processed_exif[key] = value
            elif isinstance(value, bytes):
                try:
                    processed_exif[key] = value.decode('utf-8', errors='ignore')
                except:
                    processed_exif[key] = str(value)
            elif isinstance(value, tuple):
                processed_exif[key] = [float(x) if hasattr(x, 'numerator') and hasattr(x, 'denominator') else x for x in value]
            else:
                processed_exif[key] = value
        except:
            processed_exif[key] = str(value)
    
    # Add file size in bytes and MB
    file_size_bytes = os.path.getsize(image_path)
    file_size_mb = round(file_size_bytes / (1024 * 1024), 2)
    
    metadata = {
        os.path.basename(image_path): {
            "filename": os.path.basename(image_path),
            "format": "JPEG",
            "size": [width, height],
            "width": width,
            "height": height,
            "file_size_bytes": file_size_bytes,
            "file_size_mb": file_size_mb,
            "exif": processed_exif,
            "photography": {}
        }
    }
    
    img_meta = metadata[os.path.basename(image_path)]
    if "Make" in processed_exif:
        img_meta["photography"]["camera_make"] = processed_exif["Make"]
    if "Model" in processed_exif:
        img_meta["photography"]["camera_model"] = processed_exif["Model"]
    if "LensModel" in processed_exif:
        img_meta["photography"]["lens_model"] = processed_exif["LensModel"]
    if "FNumber" in processed_exif:
        f_number = processed_exif['FNumber']
        if f_number.is_integer():
            img_meta["photography"]["aperture"] = f"f/{int(f_number)}"
        else:
            img_meta["photography"]["aperture"] = f"f/{f_number}"
    if "ExposureTime" in processed_exif:
        exposure_time = processed_exif['ExposureTime']
        # Convert decimal to fraction
        from fractions import Fraction
        try:
            # Handle very small exposure times like 0.0003125 (which is 1/3200)
            if exposure_time > 0 and exposure_time < 1:
                # Directly handle common shutter speeds
                known_shutters = {
                    0.0003125: '1/3200',
                    0.0003: '1/3200',
                    0.0004: '1/2500',
                    0.0005: '1/2000',
                    0.0006: '1/1600',
                    0.0008: '1/1250',
                    0.001: '1/1000',
                    0.00125: '1/800',
                    0.0016: '1/640',
                    0.002: '1/500',
                    0.0025: '1/400',
                    0.003: '1/320',
                    0.004: '1/250',
                    0.005: '1/200',
                    0.006: '1/160',
                    0.008: '1/125',
                    0.01: '1/100',
                    0.0125: '1/80',
                    0.016: '1/60',
                    0.02: '1/50',
                    0.025: '1/40',
                    0.03: '1/30',
                    0.04: '1/25',
                    0.05: '1/20',
                    0.06: '1/15',
                    0.08: '1/13',
                    0.1: '1/10',
                    0.125: '1/8',
                    0.16: '1/6',
                    0.2: '1/5',
                    0.25: '1/4',
                    0.3: '1/3',
                    0.4: '1/2.5',
                    0.5: '1/2'
                }
                
                # Find the closest known shutter speed
                closest = min(known_shutters.keys(), key=lambda x: abs(x - exposure_time))
                if abs(exposure_time - closest) < 0.0001:
                    img_meta["photography"]["shutter_speed"] = f"{known_shutters[closest]}s"
                else:
                    # Fallback to fraction conversion
                    f = Fraction(exposure_time).limit_denominator(10000)
                    if f.denominator == 1:
                        img_meta["photography"]["shutter_speed"] = f"{f.numerator}s"
                    else:
                        img_meta["photography"]["shutter_speed"] = f"{f.numerator}/{f.denominator}s"
            elif exposure_time >= 1:
                f = Fraction(exposure_time).limit_denominator(1000)
                if f.denominator == 1:
                    img_meta["photography"]["shutter_speed"] = f"{f.numerator}s"
                else:
                    img_meta["photography"]["shutter_speed"] = f"{f.numerator}/{f.denominator}s"
            else:
                img_meta["photography"]["shutter_speed"] = "Unknown"
        except:
            img_meta["photography"]["shutter_speed"] = f"{exposure_time}s"
    if "ISOSpeedRatings" in processed_exif:
        img_meta["photography"]["iso"] = processed_exif["ISOSpeedRatings"]
    if "FocalLength" in processed_exif:
        img_meta["photography"]["focal_length"] = f"{processed_exif['FocalLength']}mm"
    if "DateTimeOriginal" in processed_exif:
        img_meta["photography"]["date_original"] = processed_exif["DateTimeOriginal"]
    if "Artist" in processed_exif:
        img_meta["photography"]["artist"] = processed_exif["Artist"]
    if "ImageDescription" in processed_exif:
        img_meta["photography"]["description"] = processed_exif["ImageDescription"]
    
    # Add color space and profile info if available
    if "ColorSpace" in processed_exif:
        # ColorSpace values from EXIF standard: 0 = sRGB, 1 = Adobe RGB, etc.
        color_space_map = {0: 'sRGB', 1: 'sRGB'}
        img_meta["photography"]["color_space"] = color_space_map.get(processed_exif["ColorSpace"], str(processed_exif["ColorSpace"]))
    
    return metadata

def download_image_from_uri(uri, save_path="temp_image.jpg"):
    """Download image from URI or use local file."""
    try:
        # Check if it's a local file path
        if uri.startswith('/') or uri.startswith('.') or uri.find(':') == -1:
            local_path = uri
            if not os.path.exists(local_path):
                return None
            
            import shutil
            shutil.copy(local_path, save_path)
            return save_path, os.path.basename(local_path)
        
        # Otherwise, download from URI with proper headers
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
        }
        
        response = requests.get(uri, stream=True, headers=headers, timeout=10)
        response.raise_for_status()
        
        # Extract filename from URI
        filename = uri.split('/')[-1].split('?')[0]
        if not filename:
            filename = "temp_image.jpg"
        
        with open(save_path, 'wb') as f:
            for chunk in response.iter_content(8192):
                f.write(chunk)
        return save_path, filename
    except Exception as e:
        app.logger.error(f"Error downloading image: {e}")
        return None, None

@app.route('/api/metadata', methods=['GET'])
def get_metadata():
    """API endpoint to get image metadata from URI."""
    uri = request.args.get('uri')
    
    if not uri:
        return jsonify({"error": "Image URI is required"}), 400
    
    temp_file, filename = download_image_from_uri(uri)
    if not temp_file:
        return jsonify({"error": "Failed to download image"}), 500
    
    metadata = extract_metadata(temp_file)
    
    # Update filename in metadata
    temp_key = list(metadata.keys())[0]
    metadata[filename] = metadata.pop(temp_key)
    metadata[filename]['filename'] = filename
    
    os.unlink(temp_file)
    
    return jsonify(metadata)

@app.route('/api/extract_thumbnails', methods=['GET'])
def extract_thumbnails():
    """API endpoint to extract C2PA thumbnails."""
    uri = request.args.get('uri')
    
    if not uri:
        return jsonify({"error": "Image URI is required"}), 400
    
    temp_file, filename = download_image_from_uri(uri)
    if not temp_file:
        return jsonify({"error": "Failed to download image"}), 500
    
    try:
        from extract_c2pa import extract_c2pa_thumbnails
        claim_thumb, ingredient_thumb = extract_c2pa_thumbnails(temp_file)
        
        claim_thumb_b64 = base64.b64encode(claim_thumb).decode('utf-8') if claim_thumb else None
        ingredient_thumb_b64 = base64.b64encode(ingredient_thumb).decode('utf-8') if ingredient_thumb else None
        
        return jsonify({
            "claim_thumbnail": claim_thumb_b64,
            "ingredient_thumbnail": ingredient_thumb_b64
        })
        
    except Exception as e:
        app.logger.error(f"Error extracting thumbnails: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if temp_file and os.path.exists(temp_file):
            try:
                os.unlink(temp_file)
            except Exception as e:
                app.logger.error(f"Error cleaning up temp file: {e}")
        
        # Cleanup any residual thumbnail files
        for fname in ['c2pa_claim_thumbnail.jpg', 'c2pa_ingredient_thumbnail.jpg', 'temp_image.jpg', 
                     'thumbnail_0.jpg', 'thumbnail_1.jpg', 'thumbnail_2.jpg', 'thumbnail_3.jpg']:
            if os.path.exists(fname):
                try:
                    os.unlink(fname)
                except Exception as e:
                    app.logger.error(f"Error cleaning up {fname}: {e}")

@app.route('/api/c2pa_metadata', methods=['GET'])
def get_c2pa_metadata():
    """API endpoint to get detailed C2PA metadata including provenance."""
    uri = request.args.get('uri')
    
    if not uri:
        return jsonify({"error": "Image URI is required"}), 400
    
    temp_file, filename = download_image_from_uri(uri)
    if not temp_file:
        return jsonify({"error": "Failed to download image"}), 500
    
    try:
        from extract_c2pa import extract_c2pa_metadata
        provenance = extract_c2pa_metadata(temp_file)
        
        return jsonify({"provenance": provenance})
        
    except Exception as e:
        app.logger.error(f"Error extracting C2PA metadata: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if temp_file and os.path.exists(temp_file):
            try:
                os.unlink(temp_file)
            except Exception as e:
                app.logger.error(f"Error cleaning up temp file: {e}")

@app.route('/')
def index():
    """Simple health check."""
    return jsonify({"message": "API is running"}), 200

if __name__ == "__main__":
    app.run(debug=True, host='0.0.0.0', port=8080)