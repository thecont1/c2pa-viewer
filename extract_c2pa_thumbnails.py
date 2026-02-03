#!/usr/bin/env python3
"""
Extract C2PA metadata and embedded source image from a JPEG file.
"""

import struct
import io
import re
import sys
import os

def extract_thumbnails(jpeg_path):
    """Extract C2PA thumbnails using pattern matching."""
    
    with open(jpeg_path, 'rb') as f:
        data = f.read()
    
    # Look for C2PA thumbnail markers
    claim_thumbnails = []
    ingredient_thumbnails = []
    
    # Find all JPEG thumbnails in file
    jpeg_pattern = re.compile(b'\xff\xd8.*?\xff\xd9', re.DOTALL)
    matches = jpeg_pattern.findall(data)
    
    print(f"Found {len(matches)} JPEG segments in file")
    
    for i, match in enumerate(matches):
        output_path = f"thumbnail_{i}.jpg"
        with open(output_path, 'wb') as f:
            f.write(match)
        print(f"Saved thumbnail_{i}.jpg ({len(match)} bytes)")
        
        # Try to determine if it's a claim or ingredient thumbnail
        if b'c2pa.thumbnail.claim' in data[data.find(match)-100:data.find(match)]:
            claim_thumbnails.append(match)
        if b'c2pa.thumbnail.ingredient' in data[data.find(match)-100:data.find(match)]:
            ingredient_thumbnails.append(match)
    
    print(f"\nClaim thumbnails found: {len(claim_thumbnails)}")
    print(f"Ingredient thumbnails found: {len(ingredient_thumbnails)}")
    
    # Save claim thumbnail
    if claim_thumbnails:
        with open("c2pa_claim_thumbnail.jpg", 'wb') as f:
            f.write(claim_thumbnails[0])
        print("Saved c2pa_claim_thumbnail.jpg")
    
    # Save ingredient thumbnail
    if ingredient_thumbnails:
        with open("c2pa_ingredient_thumbnail.jpg", 'wb') as f:
            f.write(ingredient_thumbnails[0])
        print("Saved c2pa_ingredient_thumbnail.jpg")
    
    return claim_thumbnails, ingredient_thumbnails

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extract_c2pa_thumbnails.py <image_path>")
        sys.exit(1)
    jpeg_path = sys.argv[1]
    
    # Cleanup any existing thumbnail files before processing
    for fname in ['c2pa_claim_thumbnail.jpg', 'c2pa_ingredient_thumbnail.jpg', 
                 'thumbnail_0.jpg', 'thumbnail_1.jpg', 'thumbnail_2.jpg', 'thumbnail_3.jpg']:
        if os.path.exists(fname):
            try:
                os.unlink(fname)
            except Exception as e:
                print(f"Warning: Failed to delete {fname}: {e}")
    
    try:
        print("Extracting C2PA thumbnails...")
        claim_thumbnails, ingredient_thumbnails = extract_thumbnails(jpeg_path)
        
        print("\nThumbnails saved:")
        if claim_thumbnails:
            print(f"  - c2pa_claim_thumbnail.jpg ({len(claim_thumbnails[0])} bytes)")
        if ingredient_thumbnails:
            print(f"  - c2pa_ingredient_thumbnail.jpg ({len(ingredient_thumbnails[0])} bytes)")
            
    except Exception as e:
        print(f"Error: {e}")