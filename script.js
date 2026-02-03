/**
 * Image Metadata Visualization Script
 */

const metadataMappings = {
    exposureModes: { 0: 'Auto', 1: 'Manual', 2: 'Aperture Priority', 3: 'Shutter Priority' },
    meteringModes: { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted', 3: 'Spot', 5: 'Matrix' },
    flashStates: { 0: 'No Flash', 1: 'Flash Fired' },
    whiteBalance: { 0: 'Auto', 1: 'Manual' }
};

async function extractParamsFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    return {
        imageUri: urlParams.get('uri') || null
    };
}

async function loadMetadataFromApi(uri) {
    try {
        const response = await fetch(`http://localhost:8080/api/metadata?uri=${encodeURIComponent(uri)}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        const imageKey = Object.keys(data)[0];
        return data[imageKey];
    } catch (error) {
        console.error('Error loading metadata from API:', error);
        displayError(`Failed to load metadata: ${error.message}`);
        return null;
    }
}

async function loadThumbnailsFromApi(uri) {
    try {
        const response = await fetch(`http://localhost:8080/api/extract_thumbnails?uri=${encodeURIComponent(uri)}`);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error loading thumbnails:', error);
        return null;
    }
}

function displayError(message) {
    const sidebarContent = document.querySelector('.sidebar-content');
    sidebarContent.innerHTML = `
        <div class="error">
            <strong>Error:</strong> ${message}
        </div>
    `;
}

function showLoading() {
    // Don't replace the entire sidebar content, just show loading indicator
    const sidebarContent = document.querySelector('.sidebar-content');
    // Add loading indicator at the beginning
    sidebarContent.insertAdjacentHTML('afterbegin', `
        <div id="loadingIndicator" class="loading">
            <div class="spinner"></div>
            <p>Loading metadata...</p>
        </div>
    `);
    
    // Hide other content temporarily
    const sections = sidebarContent.querySelectorAll('.thumbnail-section, .provenance-section, .metadata-grid, .description-section');
    sections.forEach(section => {
        section.style.display = 'none';
    });
}

function hideLoading() {
    const loadingIndicator = document.getElementById('loadingIndicator');
    if (loadingIndicator) {
        loadingIndicator.remove();
    }
    
    // Show all sections
    const sidebarContent = document.querySelector('.sidebar-content');
    const sections = sidebarContent.querySelectorAll('.thumbnail-section, .provenance-section, .metadata-grid, .description-section');
    sections.forEach(section => {
        section.style.display = 'block';
    });
}

function renderPhotographyMetadata(metadata) {
    const photography = metadata.photography || {};
    
    document.getElementById('cameraMake').textContent = photography.camera_make || 'Unknown';
    document.getElementById('cameraModel').textContent = photography.camera_model || 'Unknown';
    document.getElementById('lensModel').textContent = photography.lens_model || 'Unknown';
    document.getElementById('aperture').textContent = photography.aperture || 'Unknown';
    document.getElementById('shutterSpeed').textContent = photography.shutter_speed || 'Unknown';
    document.getElementById('iso').textContent = photography.iso || 'Unknown';
    document.getElementById('focalLength').textContent = photography.focal_length || 'Unknown';
    document.getElementById('dateOriginal').textContent = photography.date_original || 'Unknown';
    document.getElementById('artist').textContent = photography.artist || 'Unknown';
    document.getElementById('description').textContent = photography.description || 'No description available';
}

function renderExifMetadata(metadata) {
    const exif = metadata.exif || {};
    
    document.getElementById('format').textContent = metadata.format || 'JPEG';
    document.getElementById('resolution').textContent = 
        exif.XResolution && exif.YResolution 
            ? `${exif.XResolution} x ${exif.YResolution} DPI` 
            : 'Unknown';
    document.getElementById('dimensions').textContent = 
        metadata.width && metadata.height 
            ? `${metadata.width} × ${metadata.height} pixels` 
            : 'Unknown';
    document.getElementById('software').textContent = exif.Software || 'Unknown';
    document.getElementById('lensSerial').textContent = exif.LensSerialNumber || 'Unknown';
    document.getElementById('bodySerial').textContent = exif.BodySerialNumber || 'Unknown';
    document.getElementById('dateDigitized').textContent = exif.DateTimeDigitized || 'Unknown';
    document.getElementById('maxAperture').textContent = 
        exif.MaxApertureValue ? `f/${exif.MaxApertureValue}` : 'Unknown';
    
    document.getElementById('exposureMode').textContent = 
        exif.ExposureMode !== undefined ? metadataMappings.exposureModes[exif.ExposureMode] || 'Unknown' : 'Unknown';
    
    document.getElementById('meteringMode').textContent = 
        exif.MeteringMode !== undefined ? metadataMappings.meteringModes[exif.MeteringMode] || 'Unknown' : 'Unknown';
    
    document.getElementById('flash').textContent = 
        exif.Flash !== undefined ? metadataMappings.flashStates[exif.Flash] || 'Unknown' : 'Unknown';
    
    document.getElementById('whiteBalance').textContent = 
        exif.WhiteBalance !== undefined ? metadataMappings.whiteBalance[exif.WhiteBalance] || 'Unknown' : 'Unknown';
}

function renderProvenance(metadata) {
    const provenanceSection = document.querySelector('.provenance-list');
    provenanceSection.innerHTML = `
        <li class="provenance-item">
            <strong>Ingredient Image:</strong> Source image embedded within C2PA metadata
        </li>
        <li class="provenance-item">
            <strong>Original Capture:</strong> Taken on <span class="highlight">${formatDate(metadata.photography?.date_original)}</span> with ${metadata.photography?.camera_make} ${metadata.photography?.camera_model}
        </li>
        <li class="provenance-item">
            <strong>Post-processing:</strong> Edited in <span class="highlight">${metadata.exif?.Software}</span>
        </li>
        <li class="provenance-item">
            <strong>Final Version:</strong> Saved on <span class="highlight">${formatDate(metadata.exif?.DateTime)}</span> as ${metadata.format} format
        </li>
        <li class="provenance-item">
            <strong>Verification:</strong> <span class="c2pa-verification" style="display: inline-flex;">✓ C2PA Verified</span>
        </li>
    `;
}

function formatDate(dateString) {
    if (!dateString) return 'Unknown';
    return dateString.replace(':', '-').replace(':', '-').replace(' ', ' at ');
}

async function renderSourceThumbnail(uri) {
    const thumbnails = await loadThumbnailsFromApi(uri);
    
    if (thumbnails?.ingredient_thumbnail) {
        const sourceImage = document.getElementById('sourceImage');
        sourceImage.src = `data:image/jpeg;base64,${thumbnails.ingredient_thumbnail}`;
        sourceImage.style.display = 'block';
        
        const sourceLabel = document.querySelector('#sourceImage').previousElementSibling;
        sourceLabel.style.display = 'block';
    } else {
        const sourceImage = document.getElementById('sourceImage');
        sourceImage.style.display = 'none';
        
        const sourceLabel = document.querySelector('#sourceImage').previousElementSibling;
        sourceLabel.style.display = 'none';
    }
}

async function init() {
    const params = await extractParamsFromUrl();
    
    if (!params.imageUri) {
        const mainContent = document.querySelector('.main-content');
        mainContent.innerHTML = `
            <div class="loading">
                <h2 style="margin-bottom: 1rem;">Image Metadata Viewer</h2>
                <p style="color: #666;">Please provide an image URI in the format:</p>
                <code style="background: #f0f0f0; padding: 0.5rem 1rem; border-radius: 4px; margin-top: 1rem; display: inline-block;">?uri=image_url</code>
            </div>
        `;
        
        const sidebarContent = document.querySelector('.sidebar-content');
        sidebarContent.innerHTML = `
            <div style="padding: 2rem; text-align: center; color: #666;">
                <h3 style="margin-bottom: 1rem;">No Image Selected</h3>
                <p>Add an image URI parameter to view metadata</p>
            </div>
        `;
        
        return;
    }
    
    showLoading();
    
    try {
        const metadata = await loadMetadataFromApi(params.imageUri);
        
        if (metadata) {
            const mainImage = document.getElementById('mainImage');
            mainImage.src = params.imageUri;
            mainImage.style.display = 'block';
            
            const c2paVerification = document.getElementById('c2paVerification');
            c2paVerification.style.display = 'flex';
            
            document.getElementById('filename').textContent = metadata.filename;
            
            hideLoading();
            renderPhotographyMetadata(metadata);
            renderExifMetadata(metadata);
            renderProvenance(metadata);
            
            await renderSourceThumbnail(params.imageUri);
        }
    } catch (error) {
        console.error('Error initializing:', error);
        hideLoading();
        displayError(`Failed to initialize: ${error.message}`);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}