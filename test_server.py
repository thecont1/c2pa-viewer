#!/usr/bin/env python3
"""
Comprehensive test script to verify all API endpoints of server.py.

Usage:
    uv run python test_server.py                           # Test with default images
    uv run python test_server.py --uri /path/to/image.jpg  # Test with local file
    uv run python test_server.py --uri https://example.com/image.jpg  # Test with URL
"""

import argparse
import requests
import json
import sys
from pathlib import Path

# Default test images
DEFAULT_TEST_IMAGES = [
    # Remote C2PA image
    "https://thecontrarian.in/library/originals/MATRIMANIA/MS201211-NupoorArijit1552.jpg",
]

DEFAULT_BASE_URL = "http://localhost:8080"


def test_exif_metadata_endpoint(base_url, image_uri):
    """Test /api/exif_metadata endpoint."""
    print(f"\n{'─'*60}")
    print(f"Testing: /api/exif_metadata")
    print(f"Image: {image_uri[:60]}{'...' if len(image_uri) > 60 else ''}")
    print(f"{'─'*60}")
    
    try:
        response = requests.get(
            f"{base_url}/api/exif_metadata",
            params={"uri": image_uri},
            timeout=30
        )
        
        if response.status_code == 200:
            data = response.json()
            
            for filename, metadata in data.items():
                print(f"\n  Image: {filename}")
                print(f"    Format: {metadata.get('format')}")
                print(f"    Dimensions: {metadata.get('width')}x{metadata.get('height')}")
                print(f"    File size: {metadata.get('file_size_mb')} MB")
                
                photography = metadata.get('photography', {})
                if photography and any(photography.values()):
                    camera = f"{photography.get('camera_make') or ''} {photography.get('camera_model') or ''}".strip()
                    if camera:
                        print(f"    Camera: {camera}")
                    if photography.get('lens_model'):
                        print(f"    Lens: {photography.get('lens_model')}")
            
            print(f"\n  ✅ PASS")
            return True
        else:
            print(f"\n  ❌ FAIL: {response.status_code} - {response.text[:200]}")
            return False
            
    except Exception as e:
        print(f"\n  ❌ FAIL: {e}")
        return False


def test_c2pa_metadata_endpoint(base_url, image_uri):
    """Test /api/c2pa_metadata endpoint."""
    print(f"\n{'─'*60}")
    print(f"Testing: /api/c2pa_metadata")
    print(f"Image: {image_uri[:60]}{'...' if len(image_uri) > 60 else ''}")
    print(f"{'─'*60}")
    
    try:
        response = requests.get(
            f"{base_url}/api/c2pa_metadata",
            params={"uri": image_uri},
            timeout=30
        )
        
        if response.status_code == 200:
            data = response.json()
            
            # Check provenance
            provenance = data.get('provenance', [])
            if provenance:
                print(f"\n  Provenance: {len(provenance)} items")
                for item in provenance[:5]:
                    name = item.get('name')
                    if name == 'Action':
                        continue;
                    elif name == 'Claim Generator':
                        print(f"    - {name}: {item.get('generator')}")
                    elif name == 'Issued By':
                        print(f"    - {name}: {item.get('issuer')}")
                    elif name == 'Issued On':
                        print(f"    - {name}: {item.get('date')}")
            else:
                print("\n  No C2PA provenance found")
            
            # Check digital source type
            digital_source = data.get('digital_source_type')
            if digital_source:
                print(f"\n  Digital Source Type:")
                print(f"    Code: {digital_source.get('code')}")
                print(f"    Label: {digital_source.get('label')}")
            else:
                print("\n  No digital source type detected")
            
            # Check thumbnails
            thumbnails = data.get('thumbnails', {})
            if thumbnails:
                print(f"\n  Thumbnails:")
                if thumbnails.get('claim_thumbnail'):
                    print(f"    - Claim: Found ({len(thumbnails['claim_thumbnail'])} chars)")
                if thumbnails.get('ingredient_thumbnail'):
                    print(f"    - Ingredient: Found ({len(thumbnails['ingredient_thumbnail'])} chars)")
            
            print(f"\n  ✅ PASS")
            return True
        else:
            print(f"\n  ❌ FAIL: {response.status_code} - {response.text[:200]}")
            return False
            
    except Exception as e:
        print(f"\n  ❌ FAIL: {e}")
        return False


def test_c2pa_mini_endpoint(base_url, image_uri):
    """Test /api/c2pa_mini endpoint."""
    print(f"\n{'─'*60}")
    print(f"Testing: /api/c2pa_mini")
    print(f"Image: {image_uri[:60]}{'...' if len(image_uri) > 60 else ''}")
    print(f"{'─'*60}")
    
    try:
        response = requests.get(
            f"{base_url}/api/c2pa_mini",
            params={"uri": image_uri},
            timeout=15
        )
        
        if response.status_code == 200:
            data = response.json()
            print(f"\n  Creator: {data.get('creator') or 'Not found'}")
            print(f"  Issued by: {data.get('issued_by') or 'Not found'}")
            print(f"  Issued on: {data.get('issued_on') or 'Not found'}")
            print(f"  Status: {data.get('status')}")
            print(f"  Digital Source: {data.get('digital_source_type') or 'Not detected'}")
            
            print(f"\n  ✅ PASS")
            return True
        else:
            print(f"\n  ❌ FAIL: {response.status_code} - {response.text[:200]}")
            return False
            
    except Exception as e:
        print(f"\n  ❌ FAIL: {e}")
        return False


def test_upload_endpoint(base_url, image_path):
    """Test /api/upload endpoint with a local file."""
    print(f"\n{'─'*60}")
    print(f"Testing: /api/upload")
    print(f"File: {image_path}")
    print(f"{'─'*60}")
    
    path = Path(image_path)
    if not path.exists():
        print(f"\n  ❌ FAIL: File not found: {image_path}")
        return False
    
    try:
        with open(path, 'rb') as f:
            files = {'file': (path.name, f, 'image/jpeg')}
            response = requests.post(
                f"{base_url}/api/upload",
                files=files,
                timeout=30
            )
        
        if response.status_code == 200:
            data = response.json()
            
            for filename, metadata in data.items():
                print(f"\n  File: {filename}")
                print(f"    Format: {metadata.get('format')}")
                print(f"    Dimensions: {metadata.get('width')}x{metadata.get('height')}")
                
                provenance = metadata.get('provenance', [])
                if provenance:
                    print(f"    Provenance: {len(provenance)} items")
                
                digital_source = metadata.get('digital_source_type')
                if digital_source:
                    print(f"    Digital Source: {digital_source.get('label')}")
                
                thumbnails = metadata.get('thumbnails', {})
                if thumbnails:
                    print(f"    Thumbnails: {list(thumbnails.keys())}")
            
            print(f"\n  ✅ PASS")
            return True
        else:
            print(f"\n  ❌ FAIL: {response.status_code} - {response.text[:200]}")
            return False
            
    except Exception as e:
        print(f"\n  ❌ FAIL: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Test C2PA Metadata Viewer API endpoints",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    uv run python test_server.py
    uv run python test_server.py --uri /Users/home/Downloads/image.jpg
    uv run python test_server.py --uri https://example.com/image.jpg
        """
    )
    parser.add_argument(
        '--uri', '-u',
        help="Image URI (local path or URL) to test with",
        default=None
    )
    parser.add_argument(
        '--base-url', '-b',
        help=f"Base URL of the server (default: {DEFAULT_BASE_URL})",
        default=DEFAULT_BASE_URL
    )
    parser.add_argument(
        '--skip-upload',
        action='store_true',
        help="Skip the upload test (useful for remote URIs)"
    )
    
    args = parser.parse_args()
    base_url = args.base_url
    
    print("=" * 60)
    print("C2PA Metadata Viewer - API Endpoint Tests")
    print("=" * 60)
    print(f"\nServer: {base_url}")
    print("Make sure the server is running: uv run uvicorn server:app --host 0.0.0.0 --port 8080")
    
    # Determine which images to test
    if args.uri:
        test_images = [args.uri]
    else:
        test_images = DEFAULT_TEST_IMAGES
    
    # Test all image-related endpoints
    for image_uri in test_images:
        test_exif_metadata_endpoint(base_url, image_uri)
        test_c2pa_metadata_endpoint(base_url, image_uri)
        test_c2pa_mini_endpoint(base_url, image_uri)
        
        # Test upload only for local files
        if not args.skip_upload and not image_uri.startswith('http'):
            test_upload_endpoint(base_url, image_uri)
    
    print(f"\n{'='*60}")
    print("Tests complete!")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
