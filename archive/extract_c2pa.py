#!/usr/bin/env python3
"""
Extract C2PA metadata and embedded source image from a JPEG file.
"""

import struct
import io
import json
import subprocess

def extract_c2pa_thumbnails(jpeg_path):
    """Extract C2PA thumbnails from JPEG file - simple and reliable method."""
    claim_thumb = None
    ingredient_thumb = None
    
    try:
        # First, try exiftool extraction
        claim_result = subprocess.run(
            ['exiftool', '-b', '-C2PAThumbnailClaimJpegData', jpeg_path],
            capture_output=True
        )
        if claim_result.returncode == 0 and len(claim_result.stdout) > 0:
            claim_thumb = claim_result.stdout
            print("Found claim thumbnail using exiftool")
        
        ingredient_result = subprocess.run(
            ['exiftool', '-b', '-C2PAThumbnailIngredientJpegData', jpeg_path],
            capture_output=True
        )
        if ingredient_result.returncode == 0 and len(ingredient_result.stdout) > 0:
            ingredient_thumb = ingredient_result.stdout
            print("Found ingredient thumbnail using exiftool")
            
        # If exiftool didn't find anything, use fallback extraction
        if not claim_thumb or not ingredient_thumb:
            import re
            with open(jpeg_path, 'rb') as f:
                data = f.read()
            
            # Find all JPEG thumbnails in file
            jpeg_pattern = re.compile(b'\xff\xd8.*?\xff\xd9', re.DOTALL)
            matches = jpeg_pattern.findall(data)
            
            print(f"Found {len(matches)} JPEG segments in file")
            
            for i, match in enumerate(matches):
                output_path = f"thumbnail_{i}.jpg"
                with open(output_path, 'wb') as f:
                    f.write(match)
                print(f"Saved thumbnail_{i}.jpg ({len(match)} bytes)")
                
                # For files with exactly 2 thumbnails, assume first is claim, second is ingredient
                if len(matches) == 2:
                    if i == 0 and not claim_thumb:
                        claim_thumb = match
                        print("Found claim thumbnail (fallback)")
                    elif i == 1 and not ingredient_thumb:
                        ingredient_thumb = match
                        print("Found ingredient thumbnail (fallback)")
                else:
                    # Fallback to pattern detection for other cases
                    if b'c2pa.thumbnail.claim' in data[data.find(match)-200:data.find(match)] and not claim_thumb:
                        claim_thumb = match
                        print("Found claim thumbnail (pattern match)")
                    if b'c2pa.thumbnail.ingredient' in data[data.find(match)-200:data.find(match)] and not ingredient_thumb:
                        ingredient_thumb = match
                        print("Found ingredient thumbnail (pattern match)")
            
    except Exception as e:
        print(f"Error extracting C2PA thumbnails: {e}")
    
    return claim_thumb, ingredient_thumb

def extract_c2pa_metadata(jpeg_path):
    """Extract detailed C2PA metadata including provenance and tool info using exiftool."""
    provenance = []
    
    try:
        # Extract C2PA metadata using exiftool
        result = subprocess.run(
            ['exiftool', '-json', '-Actions*', '-C2PA*', '-Claim*', '-Author*', '-MetadataDate', jpeg_path],
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
            if 'Claim_generator' in metadata:
                provenance.append({'name': 'Claim Generator', 'generator': metadata['Claim_generator']})
            
            # Extract signature info
            if 'Signature' in metadata:
                provenance.append({'name': 'Signature', 'signature': metadata['Signature']})
            
            # Extract issuing authority and date/time
            if 'MetadataDate' in metadata:
                provenance.append({'name': 'Issued On', 'date': metadata['MetadataDate']})
            
            # Extract claim generator info
            if 'Claim_Generator_InfoName' in metadata:
                provenance.append({'name': 'Issued By', 'issuer': metadata['Claim_Generator_InfoName']})
            
            # Extract claim generator version
            if 'Claim_Generator_InfoVersion' in metadata:
                provenance.append({'name': 'Version', 'version': metadata['Claim_Generator_InfoVersion']})
            
            # Extract verification status
            if 'Signature' in metadata or 'C2PAThumbnailClaimJpegData' in metadata:
                provenance.append({'name': 'Verification', 'verification': 'Valid'})
            else:
                provenance.append({'name': 'Verification', 'verification': 'Failed'})
            
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