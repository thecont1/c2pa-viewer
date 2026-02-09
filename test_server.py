#!/usr/bin/env python3
"""
Quick test script to verify server.py is working.
Tests the API endpoints with a sample C2PA image from the web.
"""

import requests
import json

# Test image URLs with C2PA metadata
TEST_IMAGES = [
    # Adobe sample C2PA images
    "https://contentcredentials.org/static/images/c2pa_sample_cloud.jpg",
]

def test_exif_metadata_endpoint(base_url, image_uri):
    """Test /api/exif_metadata endpoint."""
    print(f"\n{'='*70}")
    print(f"Testing: {image_uri}")
    print(f"{'='*70}")
    
    try:
        response = requests.get(
            f"{base_url}/api/exif_metadata",
            params={"uri": image_uri},
            timeout=30
        )
        
        if response.status_code == 200:
            data = response.json()
            print("✓ /api/exif_metadata endpoint working")
            
            # Print basic info
            for filename, metadata in data.items():
                print(f"\nImage: {filename}")
                print(f"  Format: {metadata.get('format')}")
                print(f"  Size: {metadata.get('width')}x{metadata.get('height')}")
                print(f"  File size: {metadata.get('file_size_mb')} MB")
                
                photography = metadata.get('photography', {})
                if photography:
                    print(f"\nPhotography:")
                    print(f"  Camera: {photography.get('camera_make')} {photography.get('camera_model')}")
                    print(f"  Lens: {photography.get('lens_model')}")
                    print(f"  Settings: {photography.get('aperture')}, {photography.get('shutter_speed')}, ISO {photography.get('iso')}")
        else:
            print(f"✗ Error: {response.status_code}")
            print(response.text)
            return False
            
    except Exception as e:
        print(f"✗ Error: {e}")
        return False
    
    return True


def test_c2pa_endpoint(base_url, image_uri):
    """Test /api/c2pa_metadata endpoint (includes thumbnails)."""
    try:
        response = requests.get(
            f"{base_url}/api/c2pa_metadata",
            params={"uri": image_uri},
            timeout=30
        )
        
        if response.status_code == 200:
            data = response.json()
            print("\n✓ /api/c2pa_metadata endpoint working")
            
            provenance = data.get('provenance', [])
            if provenance:
                print(f"\nProvenance ({len(provenance)} items):")
                for item in provenance[:5]:  # Show first 5 items
                    name = item.get('name')
                    if name == 'Action':
                        print(f"  - {name}: {item.get('action')}")
                    elif name == 'Verification':
                        print(f"  - {name}: {item.get('verification')}")
                    elif name == 'Claim Generator':
                        print(f"  - {name}: {item.get('generator')}")
                    else:
                        print(f"  - {name}")
            else:
                print("\n  No C2PA metadata found")
            
            # Check thumbnails (now included in c2pa_metadata)
            thumbnails = data.get('thumbnails', {})
            print(f"\nThumbnails:")
            if thumbnails.get('claim_thumbnail'):
                print("  - Claim thumbnail: Found")
            if thumbnails.get('ingredient_thumbnail'):
                print("  - Ingredient thumbnail: Found")
            if not thumbnails.get('claim_thumbnail') and not thumbnails.get('ingredient_thumbnail'):
                print("  - No thumbnails found")
        else:
            print(f"\n✗ C2PA endpoint error: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"\n✗ C2PA endpoint error: {e}")
        return False
    
    return True


def main():
    base_url = "http://localhost:8080"
    
    print("C2PA Metadata Viewer - API Test")
    print("=" * 70)
    print(f"\nMake sure server is running: uv run python3 server.py")
    print(f"Testing against: {base_url}\n")
    
    # Test with remote image
    for image_uri in TEST_IMAGES:
        test_exif_metadata_endpoint(base_url, image_uri)
        test_c2pa_endpoint(base_url, image_uri)
    
    print(f"\n{'='*70}")
    print("Tests complete!")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
