#!/usr/bin/env python3
"""
Extract C2PA metadata and embedded source image from a JPEG file.
"""

import struct
import io
import json
import subprocess

def extract_c2pa_thumbnails(jpeg_path):
    """Extract C2PA thumbnails from JPEG file using exiftool."""
    claim_thumb = None
    ingredient_thumb = None
    
    try:
        # Extract claim thumbnail using exiftool
        claim_result = subprocess.run(
            ['exiftool', '-b', '-C2PAThumbnailClaimJpegData', jpeg_path],
            capture_output=True
        )
        if claim_result.returncode == 0 and len(claim_result.stdout) > 0:
            claim_thumb = claim_result.stdout
            print("Found claim thumbnail using exiftool")
        
        # Extract ingredient thumbnail using exiftool
        ingredient_result = subprocess.run(
            ['exiftool', '-b', '-C2PAThumbnailIngredientJpegData', jpeg_path],
            capture_output=True
        )
        if ingredient_result.returncode == 0 and len(ingredient_result.stdout) > 0:
            ingredient_thumb = ingredient_result.stdout
            print("Found ingredient thumbnail using exiftool")
            
    except Exception as e:
        print(f"Error extracting C2PA thumbnails with exiftool: {e}")
        
        # Fallback to manual extraction if exiftool fails
        with open(jpeg_path, 'rb') as f:
            data = f.read()
        
        # JPEG SOI marker
        soi = b'\xff\xd8'
        if data.startswith(soi):
            offset = 2
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

def extract_c2pa_metadata(jpeg_path):
    """Extract detailed C2PA metadata including provenance and tool info using exiftool."""
    provenance = []
    
    try:
        # Extract C2PA metadata using exiftool
        result = subprocess.run(
            ['exiftool', '-json', '-Actions', '-C2PA*', jpeg_path],
            capture_output=True,
            text=True
        )
        
        if result.returncode == 0 and result.stdout.strip():
            metadata = json.loads(result.stdout)[0]
            
            # Extract actions
            if 'ActionsAction' in metadata:
                actions = metadata['ActionsAction']
                if isinstance(actions, str):
                    actions = [actions]
                for action in actions:
                    provenance.append({'name': 'Action', 'action': action})
            
            # Extract actions parameters
            if 'ActionsParameters' in metadata:
                params = metadata['ActionsParameters']
                if params:
                    provenance.append({'name': 'Parameters', 'parameters': params})
            
            # Extract creator info
            if 'AuthorName' in metadata:
                provenance.append({'name': 'Author', 'author': metadata['AuthorName']})
            
            # Extract claim generator info
            if 'Claimgenerator' in metadata:
                provenance.append({'name': 'Claim Generator', 'generator': metadata['Claimgenerator']})
            
            # Extract signature info
            if 'Signature' in metadata:
                provenance.append({'name': 'Signature', 'signature': metadata['Signature']})
            
    except Exception as e:
        print(f"Error extracting C2PA metadata: {e}")
        return None
        
    return provenance

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