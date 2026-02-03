#!/usr/bin/env python3
"""
Extract C2PA metadata and embedded source image from a JPEG file.
"""

import struct
import io

def extract_c2pa_thumbnails(jpeg_path):
    """Extract C2PA thumbnails from JPEG file."""
    
    with open(jpeg_path, 'rb') as f:
        data = f.read()
    
    # JPEG SOI marker
    soi = b'\xff\xd8'
    if not data.startswith(soi):
        raise ValueError("Not a valid JPEG file")
    
    offset = 2
    claim_thumb = None
    ingredient_thumb = None
    
    while offset < len(data):
        if data[offset] == 0xff and data[offset+1] in [0xe1, 0xe2]:
            # APP1 or APP2 segment (could contain C2PA jumb)
            segment_length = struct.unpack('>H', data[offset+2:offset+4])[0]
            segment_data = data[offset+4:offset+4+segment_length]
            
            # Look for jumb markers
            if b'jumb' in segment_data:
                print(f"Found APP{data[offset+1] - 0xe0 + 1} segment with C2PA data")
                
                # Extract claim thumbnail
                claim_start = segment_data.find(b'c2pa.thumbnail.claim.jpeg')
                if claim_start != -1:
                    claim_start += len(b'c2pa.thumbnail.claim.jpeg')
                    # Find the actual image data start
                    jpeg_start = segment_data.find(b'\xff\xd8', claim_start)
                    if jpeg_start != -1:
                        jpeg_end = segment_data.find(b'\xff\xd9', jpeg_start)
                        if jpeg_end != -1:
                            claim_thumb = segment_data[jpeg_start:jpeg_end+2]
                            print("Found claim thumbnail")
            
                # Extract ingredient thumbnail
                ingredient_start = segment_data.find(b'c2pa.thumbnail.ingredient.jpeg')
                if ingredient_start != -1:
                    ingredient_start += len(b'c2pa.thumbnail.ingredient.jpeg')
                    jpeg_start = segment_data.find(b'\xff\xd8', ingredient_start)
                    if jpeg_start != -1:
                        jpeg_end = segment_data.find(b'\xff\xd9', jpeg_start)
                        if jpeg_end != -1:
                            ingredient_thumb = segment_data[jpeg_start:jpeg_end+2]
                            print("Found ingredient thumbnail")
            
            offset += 4 + segment_length
        
        else:
            offset += 1
    
    return claim_thumb, ingredient_thumb

def save_thumbnail(data, output_path):
    """Save thumbnail data to file."""
    if data:
        with open(output_path, 'wb') as f:
            f.write(data)
        print(f"Saved to {output_path}")

if __name__ == "__main__":
    jpeg_path = "MS201711-Belgrade0536.jpg"
    
    try:
        print("Extracting C2PA thumbnails...")
        claim_thumb, ingredient_thumb = extract_c2pa_thumbnails(jpeg_path)
        
        save_thumbnail(claim_thumb, "c2pa_claim_thumbnail.jpg")
        save_thumbnail(ingredient_thumb, "c2pa_ingredient_thumbnail.jpg")
        
        print("Extraction completed successfully!")
        
    except Exception as e:
        print(f"Error: {e}")