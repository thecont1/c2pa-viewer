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
    
    metadata = {
        os.path.basename(image_path): {
            "filename": os.path.basename(image_path),
            "format": "JPEG",
            "size": [width, height],
            "width": width,
            "height": height,
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
        img_meta["photography"]["aperture"] = f"f/{processed_exif['FNumber']}"
    if "ExposureTime" in processed_exif:
        img_meta["photography"]["shutter_speed"] = f"{processed_exif['ExposureTime']}s"
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
        
        # Otherwise, download from URI
        response = requests.get(uri, stream=True)
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
        import subprocess
        import sys
        
        # Use the existing extract_c2pa_thumbnails.py
        result = subprocess.run([
            sys.executable, 'extract_c2pa_thumbnails.py', 
            temp_file
        ], capture_output=True, text=True)
        
        if result.returncode != 0:
            app.logger.error(f"Error extracting thumbnails: {result.stderr}")
            return jsonify({"error": "Failed to extract thumbnails"}), 500
        
        claim_thumb = None
        ingredient_thumb = None
        
        claim_file = 'c2pa_claim_thumbnail.jpg'
        ingredient_file = 'c2pa_ingredient_thumbnail.jpg'
        
        if os.path.exists(claim_file):
            with open(claim_file, 'rb') as f:
                claim_thumb = base64.b64encode(f.read()).decode('utf-8')
        
        if os.path.exists(ingredient_file):
            with open(ingredient_file, 'rb') as f:
                ingredient_thumb = base64.b64encode(f.read()).decode('utf-8')
        
        return jsonify({
            "claim_thumbnail": claim_thumb,
            "ingredient_thumbnail": ingredient_thumb
        })
        
    except Exception as e:
        app.logger.error(f"Error extracting thumbnails: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if temp_file and os.path.exists(temp_file):
            os.unlink(temp_file)

@app.route('/')
def index():
    """Simple health check."""
    return jsonify({"message": "API is running"}), 200

if __name__ == "__main__":
    app.run(debug=True, host='0.0.0.0', port=8080)