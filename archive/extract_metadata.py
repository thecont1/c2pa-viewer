#!/usr/bin/env python3
"""
Extract metadata from JPEG file and serve it as JSON.
"""

import os
import json
from PIL import Image
from PIL.ExifTags import TAGS, GPSTAGS
import subprocess
import platform

def get_exif_data(image_path):
    """Extract EXIF metadata from image file."""
    try:
        image = Image.open(image_path)
        exif_data = image._getexif()
        
        if exif_data is not None:
            # Convert EXIF tags to human-readable format
            exif = {}
            for tag, value in exif_data.items():
                tag_name = TAGS.get(tag, tag)
                exif[tag_name] = value
            return exif
        return {}
    except Exception as e:
        print(f"Error extracting EXIF data: {e}")
        return {}

def get_image_dimensions(image_path):
    """Get image dimensions."""
    try:
        image = Image.open(image_path)
        return image.size
    except Exception as e:
        print(f"Error getting dimensions: {e}")
        return (0, 0)

def extract_metadata(image_path):
    """Extract all metadata from JPEG file."""
    exif_data = get_exif_data(image_path)
    width, height = get_image_dimensions(image_path)
    
    metadata = {
        os.path.basename(image_path): {
            "filename": os.path.basename(image_path),
            "format": "JPEG",
            "size": [width, height],
            "width": width,
            "height": height,
            "exif": exif_data,
            "photography": {}
        }
    }
    
    # Extract photography-specific metadata
    img_meta = metadata[os.path.basename(image_path)]
    if "Make" in exif_data:
        img_meta["photography"]["camera_make"] = exif_data["Make"]
    if "Model" in exif_data:
        img_meta["photography"]["camera_model"] = exif_data["Model"]
    if "LensModel" in exif_data:
        img_meta["photography"]["lens_model"] = exif_data["LensModel"]
    if "FNumber" in exif_data:
        img_meta["photography"]["aperture"] = f"f/{exif_data['FNumber']}"
    if "ExposureTime" in exif_data:
        img_meta["photography"]["shutter_speed"] = f"{exif_data['ExposureTime']}s"
    if "ISOSpeedRatings" in exif_data:
        img_meta["photography"]["iso"] = exif_data["ISOSpeedRatings"]
    if "FocalLength" in exif_data:
        img_meta["photography"]["focal_length"] = f"{exif_data['FocalLength']}mm"
    if "DateTimeOriginal" in exif_data:
        img_meta["photography"]["date_original"] = exif_data["DateTimeOriginal"]
    if "Artist" in exif_data:
        img_meta["photography"]["artist"] = exif_data["Artist"]
    if "ImageDescription" in exif_data:
        img_meta["photography"]["description"] = exif_data["ImageDescription"]
    
    return metadata

def save_metadata_to_file(metadata, output_file="metadata.json"):
    """Save metadata to JSON file."""
    try:
        with open(output_file, 'w') as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False, default=str)
        print(f"Metadata saved to {output_file}")
        return True
    except Exception as e:
        print(f"Error saving metadata: {e}")
        return False

def main():
    """Main function."""
    image_path = "MS201711-Belgrade0536.jpg"
    print(f"Extracting metadata from {image_path}...")
    
    if not os.path.exists(image_path):
        print(f"Error: File {image_path} not found")
        return False
    
    metadata = extract_metadata(image_path)
    
    return save_metadata_to_file(metadata)

if __name__ == "__main__":
    main()