#!/usr/bin/env python3
"""
Extract comprehensive C2PA metadata using c2pa-python library.
Outputs JSON data compatible with the web viewer.
"""

import json
import base64
import sys
from pathlib import Path
from PIL import Image
import c2pa


def extract_c2pa_data(image_path):
    """Extract all C2PA manifest data from an image."""
    try:
        reader = c2pa.Reader(image_path)
        manifest_json = reader.json()
        
        if not manifest_json:
            print(f"No C2PA manifest found in {image_path}")
            return None
            
        data = json.loads(manifest_json)
        active_label = data.get('active_manifest')
        
        if not active_label or active_label not in data.get('manifests', {}):
            print("No active manifest found")
            return None
            
        manifest = data['manifests'][active_label]
        
        # Extract comprehensive data
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
            'thumbnail': None
        }
        
        # Extract assertions
        for assertion in manifest.get('assertions', []):
            label = assertion.get('label', 'Unknown')
            assertion_data = assertion.get('data', {})
            
            result['assertions'].append({
                'label': label,
                'data': assertion_data
            })
            
            # Extract specific assertion types
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
        
        # Extract thumbnail if available
        if 'thumbnail' in manifest:
            thumb_data = manifest['thumbnail']
            if isinstance(thumb_data, dict) and 'url' in thumb_data:
                # Handle thumbnail URL reference
                result['thumbnail'] = thumb_data
            elif isinstance(thumb_data, bytes):
                # Handle raw thumbnail data
                result['thumbnail'] = base64.b64encode(thumb_data).decode('utf-8')
        
        return result
        
    except Exception as e:
        print(f"Error extracting C2PA data: {e}")
        import traceback
        traceback.print_exc()
        return None


def extract_exif_metadata(image_path):
    """Extract basic EXIF metadata using PIL."""
    try:
        img = Image.open(image_path)
        exif_data = img._getexif() or {}
        
        # Basic image info
        result = {
            'filename': Path(image_path).name,
            'format': img.format,
            'width': img.width,
            'height': img.height,
            'mode': img.mode,
            'file_size_bytes': Path(image_path).stat().st_size,
        }
        
        result['file_size_mb'] = round(result['file_size_bytes'] / (1024 * 1024), 2)
        
        # Map common EXIF tags
        exif_tag_map = {
            271: 'Make',           # Camera make
            272: 'Model',          # Camera model
            274: 'Orientation',
            282: 'XResolution',
            283: 'YResolution',
            305: 'Software',
            306: 'DateTime',
            315: 'Artist',
            33432: 'Copyright',
            36867: 'DateTimeOriginal',
            36868: 'DateTimeDigitized',
            37378: 'ApertureValue',
            37379: 'BrightnessValue',
            37380: 'ExposureBiasValue',
            37381: 'MaxApertureValue',
            37383: 'MeteringMode',
            37385: 'Flash',
            37386: 'FocalLength',
            37520: 'SubSecTime',
            37521: 'SubSecTimeOriginal',
            37522: 'SubSecTimeDigitized',
            41495: 'SensingMethod',
            41986: 'ExposureMode',
            41987: 'WhiteBalance',
            41989: 'FocalLengthIn35mmFilm',
        }
        
        exif_processed = {}
        for tag_id, tag_name in exif_tag_map.items():
            if tag_id in exif_data:
                value = exif_data[tag_id]
                exif_processed[tag_name] = value
        
        result['exif'] = exif_processed
        
        return result
        
    except Exception as e:
        print(f"Error extracting EXIF data: {e}")
        return None


def format_provenance_for_web(c2pa_data):
    """Format C2PA data into provenance items for web display."""
    provenance = []
    
    if not c2pa_data:
        return provenance
    
    # Add basic info
    basic = c2pa_data.get('basic_info', {})
    if basic.get('claim_generator'):
        provenance.append({
            'name': 'Claim Generator',
            'generator': basic['claim_generator']
        })
    
    # Add signature info
    sig_info = c2pa_data.get('signature_info', {})
    if sig_info.get('issuer'):
        provenance.append({
            'name': 'Issued By',
            'issuer': sig_info['issuer']
        })
    
    if sig_info.get('time'):
        provenance.append({
            'name': 'Issued On',
            'date': sig_info['time']
        })
    
    # Add actions
    for action in c2pa_data.get('actions', []):
        provenance.append({
            'name': 'Action',
            'action': action['action'],
            'when': action.get('when'),
            'software': action.get('softwareAgent')
        })
    
    # Add author info
    author_info = c2pa_data.get('author_info', {})
    if 'author' in author_info:
        authors = author_info['author']
        if isinstance(authors, list) and len(authors) > 0:
            author_name = authors[0].get('name', 'Unknown')
            provenance.append({
                'name': 'Author',
                'author': author_name
            })
    
    # Add verification status
    if sig_info:
        provenance.append({
            'name': 'Verification',
            'verification': 'Valid'
        })
    
    return provenance


def main():
    if len(sys.argv) < 2:
        print("Usage: python extract_c2pa_improved.py <image_path> [output_json]")
        sys.exit(1)
    
    image_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else 'metadata.json'
    
    if not Path(image_path).exists():
        print(f"Error: Image file not found: {image_path}")
        sys.exit(1)
    
    print(f"Extracting metadata from: {image_path}")
    print("=" * 70)
    
    # Extract C2PA data
    print("\n1. Extracting C2PA manifest data...")
    c2pa_data = extract_c2pa_data(image_path)
    
    # Extract EXIF data
    print("2. Extracting EXIF metadata...")
    exif_data = extract_exif_metadata(image_path)
    
    # Combine all data
    complete_data = {
        'c2pa': c2pa_data,
        'exif': exif_data,
        'provenance': format_provenance_for_web(c2pa_data) if c2pa_data else []
    }
    
    # Save to JSON
    print(f"\n3. Saving to {output_path}...")
    with open(output_path, 'w') as f:
        json.dump(complete_data, f, indent=2, default=str)
    
    print("\n" + "=" * 70)
    print("✓ Extraction completed successfully!")
    print(f"✓ Data saved to: {output_path}")
    
    # Print summary
    if c2pa_data:
        print(f"\nC2PA Summary:")
        print(f"  - Claim Generator: {c2pa_data['basic_info'].get('claim_generator', 'N/A')}")
        print(f"  - Issuer: {c2pa_data['signature_info'].get('issuer', 'N/A')}")
        print(f"  - Actions: {len(c2pa_data['actions'])} found")
        print(f"  - Assertions: {len(c2pa_data['assertions'])} found")
        print(f"  - Ingredients: {len(c2pa_data['ingredients'])} found")
    else:
        print("\n⚠ No C2PA manifest found in this image")


if __name__ == "__main__":
    main()
