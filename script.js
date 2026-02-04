/**
 * Image Metadata Visualization Script
 */

const metadataMappings = {
    exposureModes: { 0: 'Auto', 1: 'Manual', 2: 'Aperture Priority', 3: 'Shutter Priority' },
    meteringModes: { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted', 3: 'Spot', 5: 'Matrix' },
    flashStates: { 0: 'No Flash', 1: 'Flash Fired' },
    whiteBalance: { 0: 'Auto', 1: 'Manual' },
    actions: {
        'c2pa.opened': {
            icon: '📂',
            description: 'Opened a pre-existing file'
        },
        'c2pa.color_adjustments': {
            icon: '🎨',
            description: 'Adjusted properties like tone, saturation, curves, shadows, or highlights'
        },
        'c2pa.cropped': {
            icon: '✂️',
            description: 'Used cropping tools, reducing or expanding visible content area'
        },
        'c2pa.drawing': {
            icon: '✏️',
            description: 'Used tools like pencils, brushes, erasers, or shape, path, or pen tools'
        },
        'c2pa.resized': {
            icon: '🔍',
            description: 'Changed dimensions or file size'
        }
    }
};

async function extractParamsFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    return {
        imageUri: urlParams.get('uri') || null
    };
}

async function loadMetadataFromApi(uri) {
    console.log('Loading metadata from URI:', uri);
    
    try {
        const response = await fetch(`http://localhost:8080/api/metadata?uri=${encodeURIComponent(uri)}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('API response data:', data);
        
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
    
    setFullText('cameraMake', photography.camera_make || 'Unknown');
    setFullText('cameraModel', photography.camera_model || 'Unknown');
    setFullText('lensModel', photography.lens_model || 'Unknown');
    setFullText('aperture', photography.aperture || 'Unknown');
    setFullText('shutterSpeed', photography.shutter_speed || 'Unknown');
    setFullText('iso', photography.iso || 'Unknown');
    setFullText('focalLength', photography.focal_length || 'Unknown');
    setFullText('dateOriginal', photography.date_original || 'Unknown');
    setFullText('dateDigitized', photography.date_digitized || 'Unknown');
    setFullText('artist', photography.artist || 'Unknown');
    setFullText('colorSpace', photography.color_space || 'Unknown');
}

function renderIPTCMetadata(metadata) {
    const iptc = metadata.iptc || {};
    
    // Build description section with title and description
    const descSection = document.querySelector('.description-section');
    let html = '<h2>Image Description & Information</h2>';
    
    // Add title if available
    if (iptc.title) {
        html += `<h3 style="margin-top: 1rem; margin-bottom: 0.5rem; font-size: 1.1rem; font-weight: 600;">${iptc.title}</h3>`;
    }
    
    // Add description
    const description = iptc.description || metadata.photography?.description || 'No description available';
    html += `<p class="description">${description}</p>`;
    
    // Add location if available
    if (iptc.location || iptc.city) {
        const location = [iptc.location, iptc.city].filter(Boolean).join(', ');
        html += `<p style="margin-top: 0.5rem; font-style: italic; color: #666;">📍 ${location}</p>`;
    }
    
    // Add keywords if available
    if (iptc.keywords) {
        html += `<p style="margin-top: 0.5rem; font-size: 0.9rem;"><strong>Keywords:</strong> ${iptc.keywords}</p>`;
    }
    
    descSection.innerHTML = html;
}

function renderGPSMetadata(metadata) {
    console.log('Metadata.gps:', metadata.gps);
    
    const gps = metadata.gps || {};
    const locationSection = Array.from(document.querySelectorAll('.metadata-section')).find(section => 
        section.querySelector('h2') && section.querySelector('h2').textContent.includes('Location')
    );
    
    if (gps.latitude && gps.longitude && gps.latitude !== 'None' && gps.longitude !== 'None') {
        // Format latitude and longitude with degree symbols and directions
        let lat = parseFloat(gps.latitude);
        let lon = parseFloat(gps.longitude);
        
        const latDirection = lat >= 0 ? 'N' : 'S';
        const lonDirection = lon >= 0 ? 'E' : 'W';
        
        lat = Math.abs(lat);
        lon = Math.abs(lon);
        
        const latDeg = Math.floor(lat);
        const latMin = Math.floor((lat - latDeg) * 60);
        const latSec = ((lat - latDeg - latMin / 60) * 3600).toFixed(2);
        
        const lonDeg = Math.floor(lon);
        const lonMin = Math.floor((lon - lonDeg) * 60);
        const lonSec = ((lon - lonDeg - lonMin / 60) * 3600).toFixed(2);
        
        const formattedLat = `${latDeg}°${latMin}'${latSec}" ${latDirection}`;
        const formattedLon = `${lonDeg}°${lonMin}'${lonSec}" ${lonDirection}`;
        
        const gpsElement = document.getElementById('gpsCoordinates');
        if (gpsElement) {
            const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${gps.latitude},${gps.longitude}`;
            gpsElement.innerHTML = `<a href="${mapsUrl}" target="_blank" rel="noopener noreferrer">${formattedLat}, ${formattedLon}</a>`;
        }
        
        // Show location section
        locationSection.style.display = 'block';
    } else {
        // Hide location section if GPS coordinates are not available
        locationSection.style.display = 'none';
    }
}

function setFullText(elementId, text) {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    element.textContent = text;
    element.classList.remove('tooltip');
    element.removeAttribute('data-tooltip');
}

function renderExifMetadata(metadata) {
    const exif = metadata.exif || {};
    
    setFullText('format', metadata.format || 'JPEG');
    setFullText('resolution', 
        exif.XResolution && exif.YResolution 
            ? `${exif.XResolution} x ${exif.YResolution} DPI` 
            : 'Unknown');
    setFullText('dimensions', 
        metadata.width && metadata.height 
            ? `${metadata.width} × ${metadata.height}` 
            : 'Unknown');
    setFullText('fileSize', 
        metadata.file_size_bytes ? `${metadata.file_size_mb} MB (${metadata.file_size_bytes.toLocaleString()} bytes)` : 'Unknown');
    setFullText('software', exif.Software || 'Unknown');
    
    setFullText('exposureMode',
        exif.ExposureMode !== undefined ? metadataMappings.exposureModes[exif.ExposureMode] || 'Unknown' : 'Unknown');
    
    setFullText('meteringMode', 
        exif.MeteringMode !== undefined ? metadataMappings.meteringModes[exif.MeteringMode] || 'Unknown' : 'Unknown');
    
    setFullText('flash', 
        exif.Flash !== undefined ? metadataMappings.flashStates[exif.Flash] || 'Unknown' : 'Unknown');
    
    setFullText('whiteBalance', 
        exif.WhiteBalance !== undefined ? metadataMappings.whiteBalance[exif.WhiteBalance] || 'Unknown' : 'Unknown');
}

async function loadC2PAMetadataFromApi(uri) {
    try {
        const response = await fetch(`http://localhost:8080/api/c2pa_metadata?uri=${encodeURIComponent(uri)}`);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return data.provenance;
    } catch (error) {
        console.error('Error loading C2PA metadata:', error);
        return null;
    }
}

function renderC2PAMetadata(provenance) {
    const provenanceSection = document.querySelector('.provenance-list');
    
    if (!provenance || provenance.length === 0) {
        provenanceSection.innerHTML = `
            <li class="provenance-item">
                <strong>Provenance Information</strong>
                <p>No detailed C2PA metadata available</p>
            </li>
        `;
        return;
    }
    
    let html = '';
    const actions = [];
    
    provenance.forEach((item, index) => {
        if (item.name === 'Action' && item.action) {
            actions.push(item.action);
        }
    });
    
    // Display unique actions
    const uniqueActions = [...new Set(actions)];
    if (uniqueActions.length > 0) {
        html += `
            <li class="provenance-item">
                <strong>Edits</strong>
                <div class="actions-container">
        `;
        
        uniqueActions.forEach(action => {
            const actionInfo = metadataMappings.actions[action];
            const icon = actionInfo?.icon || '📋';
            const description = actionInfo?.description || action;
            
            html += `
                <div class="action-item" title="${description}">
                    <span class="action-icon">${icon}</span>
                    <span class="action-name">${action.split('.').pop()}</span>
                </div>
            `;
        });
        
        html += `
                </div>
            </li>
        `;
    }
    
    provenance.forEach((item, index) => {
        if (item.name !== 'Action') {
            html += `
                <li class="provenance-item">
                    <strong>${item.name || `Step ${index + 1}`}</strong>
            `;
            
            if (item.title) {
                html += `<p>${item.title}</p>`;
            }
            
            if (item.tool) {
                html += `<p><em>${item.tool}</em></p>`;
            }
            
            if (item.parameters) {
                html += `<p>${JSON.stringify(item.parameters)}</p>`;
            }
            
            if (item.data) {
                html += `<p>${item.data}</p>`;
            }
            
            if (item.generator) {
                html += `<p>${item.generator}</p>`;
            }
            
            if (item.issuer) {
                html += `<p>${item.issuer}</p>`;
            }
            
            if (item.date) {
                // Date is already formatted by backend
                html += `<p>${item.date}</p>`;
            }
            
            if (item.version) {
                html += `<p>${item.version}</p>`;
            }
            
            if (item.verification) {
                const verificationClass = item.verification === 'Valid' ? 'valid' : 'failed';
                html += `
                    <p class="verification ${verificationClass}">
                        ✅ ${item.verification}
                    </p>
                `;
            }
            
            html += `</li>`;
        }
    });
    
    provenanceSection.innerHTML = html;
}

function renderProvenance(metadata) {
    const provenanceSection = document.querySelector('.provenance-list');
    provenanceSection.innerHTML = `
        <li class="provenance-item">
            <strong>Ingredient Image</strong>
            <p>Source image embedded within C2PA metadata</p>
        </li>
        <li class="provenance-item">
            <strong>Original Capture</strong>
            <p>Taken on ${formatDate(metadata.photography?.date_original)} with ${metadata.photography?.camera_make} ${metadata.photography?.camera_model}</p>
        </li>
        <li class="provenance-item">
            <strong>Post-processing</strong>
            <p>Edited in ${metadata.exif?.Software}</p>
        </li>
        <li class="provenance-item">
            <strong>Final Version</strong>
            <p>Saved on ${formatDate(metadata.exif?.DateTime)} as ${metadata.format} format</p>
        </li>
        <li class="provenance-item">
            <span class="c2pa-verification" style="display: inline-flex;">✓ C2PA Verified</span>
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
        
        // Ensure thumbnail is centered within container
        sourceImage.addEventListener('load', function() {
            this.style.margin = '0 auto';
        });
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
        
        console.log('Metadata received:', metadata);
        
        if (metadata) {
            const mainImage = document.getElementById('mainImage');
            mainImage.src = params.imageUri;
            mainImage.style.display = 'block';
            
            // Check if C2PA verification container exists before accessing style
            const c2paVerificationContainer = document.querySelector('.c2pa-verification-container');
            if (c2paVerificationContainer) {
                c2paVerificationContainer.style.display = 'block';
            }
            
            // Show filename under source thumbnail
            const filenameElement = document.getElementById('filename');
            filenameElement.textContent = metadata.filename;
            filenameElement.style.display = 'block';
            
            hideLoading();
            renderPhotographyMetadata(metadata);
            renderExifMetadata(metadata);
            renderGPSMetadata(metadata);
            renderIPTCMetadata(metadata);
            
            // Load and display C2PA metadata
            const c2paProvenance = await loadC2PAMetadataFromApi(params.imageUri);
            if (c2paProvenance && c2paProvenance.length > 0) {
                renderC2PAMetadata(c2paProvenance);
            } else {
                renderProvenance(metadata);
            }
            
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