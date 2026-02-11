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
            description: 'Color adjustments'
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
        },
        'c2pa.filtered': {
            icon: '🔮',
            description: 'Applied filters or effects'
        }
    },
    // Adobe Camera Raw parameter names to user-friendly labels
    acrParameters: {
        'Blacks2012': 'Blacks',
        'Clarity2012': 'Clarity',
        'Dehaze': 'Dehaze',
        'Exposure2012': 'Exposure',
        'Highlights2012': 'Highlights',
        'Shadows2012': 'Shadows',
        'Whites2012': 'Whites',
        'Contrast2012': 'Contrast',
        'Saturation': 'Saturation',
        'Vibrance': 'Vibrance',
        'Temperature': 'Temperature',
        'Tint': 'Tint',
        'LensProfileEnable': 'Lens Profile Correction',
        'LuminanceAdjustmentRed': 'Red Luminance',
        'LuminanceAdjustmentOrange': 'Orange Luminance',
        'LuminanceAdjustmentYellow': 'Yellow Luminance',
        'LuminanceAdjustmentGreen': 'Green Luminance',
        'LuminanceAdjustmentAqua': 'Aqua Luminance',
        'LuminanceAdjustmentBlue': 'Blue Luminance',
        'LuminanceAdjustmentPurple': 'Purple Luminance',
        'LuminanceAdjustmentMagenta': 'Magenta Luminance',
        'SaturationAdjustmentRed': 'Red Saturation',
        'SaturationAdjustmentOrange': 'Orange Saturation',
        'SaturationAdjustmentYellow': 'Yellow Saturation',
        'SaturationAdjustmentGreen': 'Green Saturation',
        'SaturationAdjustmentAqua': 'Aqua Saturation',
        'SaturationAdjustmentBlue': 'Blue Saturation',
        'SaturationAdjustmentPurple': 'Purple Saturation',
        'SaturationAdjustmentMagenta': 'Magenta Saturation',
        'HueAdjustmentRed': 'Red Hue',
        'HueAdjustmentOrange': 'Orange Hue',
        'HueAdjustmentYellow': 'Yellow Hue',
        'HueAdjustmentGreen': 'Green Hue',
        'HueAdjustmentAqua': 'Aqua Hue',
        'HueAdjustmentBlue': 'Blue Hue',
        'HueAdjustmentPurple': 'Purple Hue',
        'HueAdjustmentMagenta': 'Magenta Hue',
        'LuminanceSmoothing': 'Luminance Smoothing (Noise Reduction)',
        'ColorNoiseReduction': 'Color Noise Reduction',
        'Sharpness': 'Sharpness',
        'SharpenRadius': 'Sharpen Radius',
        'SharpenDetail': 'Sharpen Detail',
        'SharpenEdgeMasking': 'Sharpen Edge Masking',
        'PerspectiveRotate': 'Perspective Rotation',
        'PerspectiveVertical': 'Perspective Vertical',
        'PerspectiveHorizontal': 'Perspective Horizontal',
        'PerspectiveScale': 'Perspective Scale',
        'PerspectiveAspect': 'Perspective Aspect',
        'PerspectiveUpright': 'Perspective Upright',
        'Defringe': 'Defringe',
        'PostCropVignetteAmount': 'Post-Crop Vignette',
        'GrainAmount': 'Grain Amount',
        'Texture': 'Texture',
        'Look Table': 'Look/Preset',
        'Point Curve': 'Tone Curve',
        'Masking': 'Masking'
    }
};

async function extractParamsFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    return {
        imageUri: urlParams.get('uri') || null
    };
}

async function loadExifMetadataFromApi(uri) {
    try {
        const response = await fetch(`/c2pa/api/exif_metadata?uri=${encodeURIComponent(uri)}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        
        const imageKey = Object.keys(data)[0];
        return data[imageKey];
    } catch (error) {
        console.error('Error loading EXIF metadata from API:', error);
        displayError(`Failed to load metadata: ${error.message}`);
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
    // Show spinner on welcome screen (behind select button)
    const loader = document.getElementById('loadingIndicator');
    if (loader) {
        loader.style.display = 'block';
    }
    
    // Hide sidebar sections during loading
    const sidebarContent = document.querySelector('.sidebar-content');
    const sections = sidebarContent.querySelectorAll('.thumbnail-section, .provenance-section, .metadata-grid, .description-section');
    sections.forEach(section => {
        if (section && section.style) {
            section.style.display = 'none';
        }
    });
}

function hideLoading() {
    // Hide spinner
    const loader = document.getElementById('loadingIndicator');
    if (loader) {
        loader.style.display = 'none';
    }
    
    // Show all sections
    const sidebarContent = document.querySelector('.sidebar-content');
    const sections = sidebarContent.querySelectorAll('.thumbnail-section, .provenance-section, .metadata-grid, .description-section');
    sections.forEach(section => {
        if (section && section.style) {
            section.style.display = 'block';
        }
    });
}

function updateC2PAStatus(hasC2PA, provenanceCount = 0) {
    const statusCard = document.getElementById('ccStatusCard');
    const statusValue = document.getElementById('ccStatusValue');
    const statusLabel = document.getElementById('ccStatusLabel');
    const statusDetails = document.getElementById('ccStatusDetails');
    const statusDescription = document.getElementById('ccStatusDescription');
    
    if (!statusCard || !statusValue) return;
    
    if (hasC2PA) {
        statusCard.classList.add('verified');
        statusCard.classList.remove('unverified');
        statusValue.textContent = 'Authenticity Verified';
        if (statusDescription) {
            statusDescription.textContent = `${provenanceCount} provenance entries found`;
        }
        if (statusDetails) {
            statusDetails.style.display = 'block';
        }
    } else {
        statusCard.classList.add('unverified');
        statusCard.classList.remove('verified');
        statusValue.textContent = 'Not Found';
        if (statusDescription) {
            statusDescription.textContent = 'No Content Credentials detected in this image';
        }
        if (statusDetails) {
            statusDetails.style.display = 'block';
        }
    }
}

function updateDigitalSourceType(digitalSourceType) {
    const section = document.getElementById('digitalSourceSection');
    const card = document.getElementById('digitalSourceCard');
    const label = document.getElementById('digitalSourceLabel');
    const icon = document.getElementById('digitalSourceIcon');
    
    if (!section || !card || !label) return;
    
    if (digitalSourceType && digitalSourceType.label) {
        label.textContent = digitalSourceType.label;
        section.style.display = 'block';
        
        // Remove previous state classes
        card.classList.remove('verified', 'ai-generated');
        
        // Add appropriate class based on source type
        if (digitalSourceType.code === 'trainedAlgorithmicMedia' || digitalSourceType.code === 'algorithmicallyEnhanced') {
            // AI-generated content - orange/warning style
            card.classList.add('ai-generated');
        } else {
            // Camera capture or other verified source - green/success style
            card.classList.add('verified');
        }
    } else {
        section.style.display = 'none';
    }
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
    // Handle case where artist might be an object or array
    const artistValue = typeof photography.artist === 'string' ? photography.artist : 
                       Array.isArray(photography.artist) ? photography.artist.join(', ') : 
                       'Unknown';
    setFullText('artist', artistValue);
    setFullText('colorSpace', photography.color_space || 'Unknown');
    setFullText('colorProfile', photography.color_profile || 'Unknown');
}

function renderIPTCMetadata(metadata) {
    const iptc = metadata.iptc || {};
    
    // Build description section with title and description
    const descSection = document.querySelector('.description-section');
    let html = '<h2>Title & Caption</h2>';
    
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
        const gpsItem = document.getElementById('gpsItem');
        if (gpsElement) {
            const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${gps.latitude},${gps.longitude}`;
            gpsElement.innerHTML = `<a href="${mapsUrl}" target="_blank" rel="noopener noreferrer">${formattedLat}, ${formattedLon}</a>`;
        }
        if (gpsItem) {
            gpsItem.style.display = 'flex';
        }
        
        // Show location section (legacy)
        if (locationSection) {
            locationSection.style.display = 'block';
        }
    } else {
        // Hide GPS item
        const gpsItem = document.getElementById('gpsItem');
        if (gpsItem) {
            gpsItem.style.display = 'none';
        }
        
        // Hide location section if GPS coordinates are not available (legacy)
        if (locationSection) {
            locationSection.style.display = 'none';
        }
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
        const response = await fetch(`/c2pa/api/c2pa_metadata?uri=${encodeURIComponent(uri)}`);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return {
            provenance: data.provenance,
            thumbnails: data.thumbnails || {},
            digital_source_type: data.digital_source_type || null,
            author_info: data.author_info || null
        };
    } catch (error) {
        console.error('Error loading C2PA metadata:', error);
        return null;
    }
}

function toggleProvenanceExpansion() {
    const collapsedItems = document.querySelectorAll('.collapsed-item');
    const toggleBtn = document.getElementById('provenanceToggle');
    const collapseBtn = document.getElementById('provenanceCollapse');
    const isExpanded = collapseBtn && collapseBtn.style.display !== 'none';
    
    collapsedItems.forEach(item => {
        item.style.display = isExpanded ? 'none' : 'block';
    });
    
    if (toggleBtn) {
        toggleBtn.style.display = isExpanded ? 'block' : 'none';
    }
    if (collapseBtn) {
        collapseBtn.style.display = isExpanded ? 'none' : 'block';
    }
}

function getActionLabel(item) {
    // Extract a human-readable label from the action
    if (item.action) {
        // Convert c2pa.action_name to "Action Name"
        const actionName = item.action.replace('c2pa.', '').replace(/_/g, ' ');
        return actionName.charAt(0).toUpperCase() + actionName.slice(1);
    }
    return 'Action';
}

function formatActionParameters(parameters) {
    // Format action parameters into a readable description
    if (!parameters || Object.keys(parameters).length === 0) {
        return null;
    }
    
    // Handle Adobe Camera Raw parameters
    const acrKey = parameters['com.adobe.acr'];
    const acrValue = parameters['com.adobe.acr.value'];
    
    if (acrKey && acrValue !== undefined) {
        const friendlyName = metadataMappings.acrParameters[acrKey] || acrKey;
        
        // Format the value with appropriate sign for numbers
        let formattedValue = acrValue;
        if (!isNaN(parseFloat(acrValue)) && acrValue !== 'Masking changed' && !acrValue.includes('Changed')) {
            const numVal = parseFloat(acrValue);
            // For exposure values that might be in hundredths
            if (acrKey === 'Exposure2012' && Math.abs(numVal) > 10) {
                formattedValue = (numVal / 100).toFixed(2);
            }
            // Add + sign for positive numbers (except for certain parameters)
            if (numVal > 0 && !['Masking', 'Look Table', 'Point Curve', 'LensProfileEnable'].includes(acrKey)) {
                formattedValue = '+' + formattedValue;
            }
        }
        
        // Special handling for specific parameter types
        if (acrValue === 'Masking changed') {
            return 'Masking was modified';
        }
        if (acrValue.includes('Changed')) {
            return `${friendlyName} was modified`;
        }
        if (acrKey === 'LensProfileEnable' && acrValue === '1') {
            return `${friendlyName} enabled`;
        }
        
        return `${friendlyName}: ${formattedValue}`;
    }
    
    // Handle ingredients (for opened action)
    if (parameters.ingredients) {
        return 'Opened source file';
    }
    
    // Generic fallback - format all key-value pairs
    const parts = [];
    for (const [key, value] of Object.entries(parameters)) {
        if (key.startsWith('com.')) continue; // Skip Adobe-specific keys
        if (typeof value === 'object') continue; // Skip nested objects
        parts.push(`${key}: ${value}`);
    }
    
    return parts.length > 0 ? parts.join(', ') : null;
}

function renderC2PAMetadata(provenance, hasC2PA = true) {
    const provenanceList = document.getElementById('provenanceList');
    const provenanceEmpty = document.getElementById('provenanceEmpty');
    
    if (!provenance || provenance.length === 0) {
        provenanceList.style.display = 'none';
        provenanceEmpty.style.display = 'flex';
        return;
    }
    
    // Show list, hide empty state
    provenanceList.style.display = 'block';
    provenanceEmpty.style.display = 'none';
    
    // Extract author info from provenance
    let authorInfo = null;
    const filteredProvenance = provenance.filter(item => {
        if (item.name === 'Author' && item.author_details) {
            authorInfo = item.author_details;
        }
        return item.name !== 'Author' || !item.author_details;
    });
    
    // Render author info in Creator section if available
    if (authorInfo) {
        renderAuthorInfo(authorInfo);
    }
    
    const totalItems = filteredProvenance.length;
    const shouldCollapse = totalItems >= 6; // Need at least 6 items to show collapse button
    
    let html = '';
    
    // Helper to render a single item
    function renderItem(item, isHidden = false) {
        const hiddenClass = isHidden ? 'style="display: none;"' : '';
        const collapsedClass = isHidden ? 'collapsed-item' : '';
        
        if (item.name === 'Action' && item.action) {
            const actionInfo = metadataMappings.actions[item.action];
            const icon = actionInfo?.icon || '📋';
            const actionLabel = getActionLabel(item);
            
            // Get specific parameter description or fall back to generic description
            const paramDescription = formatActionParameters(item.parameters);
            const description = paramDescription || actionInfo?.description || item.action;
            
            return `
                <li class="provenance-item ${collapsedClass}" ${hiddenClass}>
                    <strong>${icon} ${actionLabel}</strong>
                    <p>${description}</p>
                    ${item.software ? `<p class="timestamp">Tool: ${item.software}</p>` : ''}
                    ${item.when ? `<p class="timestamp">${item.when}</p>` : ''}
                </li>
            `;
        } else if (item.name === 'Ingredient') {
            return `
                <li class="provenance-item verified ${collapsedClass}" ${hiddenClass}>
                    <strong>📸 Original Image</strong>
                    <p>Source image with embedded C2PA metadata</p>
                    ${item.relationship ? `<p class="timestamp">Relationship: ${item.relationship}</p>` : ''}
                </li>
            `;
        } else if (item.verification) {
            return `
                <li class="provenance-item ${item.verification.includes('Valid') ? 'verified' : ''} ${collapsedClass}" ${hiddenClass}>
                    <strong>✓ Verification</strong>
                    <p>${item.verification}</p>
                    ${item.issuer ? `<p class="timestamp">Issuer: ${item.issuer}</p>` : ''}
                </li>
            `;
        } else if (item.generator) {
            return `
                <li class="provenance-item ${collapsedClass}" ${hiddenClass}>
                    <strong>⚙️ Claim Generator</strong>
                    <p>${item.generator}</p>
                    ${item.version ? `<p class="timestamp">Version: ${item.version}</p>` : ''}
                </li>
            `;
        } else if (item.issuer && item.name === 'Issued By') {
            return `
                <li class="provenance-item ${collapsedClass}" ${hiddenClass}>
                    <strong>🏛️ Issued By</strong>
                    <p>${item.issuer}</p>
                </li>
            `;
        } else if (item.date && item.name === 'Issued On') {
            return `
                <li class="provenance-item ${collapsedClass}" ${hiddenClass}>
                    <strong>📅 Issued On</strong>
                    <p>${item.date}</p>
                </li>
            `;
        } else if (item.author) {
            return `
                <li class="provenance-item verified ${collapsedClass}" ${hiddenClass}>
                    <strong>👤 Author</strong>
                    <p>${item.author}</p>
                </li>
            `;
        } else if (item.title) {
            return `
                <li class="provenance-item ${collapsedClass}" ${hiddenClass}>
                    <strong>📝 Title</strong>
                    <p>${item.title}</p>
                </li>
            `;
        }
        return '';
    }
    
    // Show first 3 items (or all if less than 6)
    const visibleCount = shouldCollapse ? 3 : totalItems;
    for (let i = 0; i < visibleCount && i < totalItems - 1; i++) {
        html += renderItem(filteredProvenance[i], false);
    }
    
    // Add collapsed middle items and collapse button (if needed)
    if (shouldCollapse) {
        // Hidden count = total - 4 (first 3 visible + Verification visible)
        const hiddenCount = totalItems - 4;
        for (let i = 3; i < totalItems - 1; i++) {
            html += renderItem(filteredProvenance[i], true);
        }
        
        // Add expand/collapse button
        html += `
            <li class="provenance-item expand-toggle" id="provenanceToggle">
                <button class="expand-btn" onclick="toggleProvenanceExpansion()">
                    <span>+${hiddenCount} more entries</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
            </li>
            <li class="provenance-item collapse-toggle" id="provenanceCollapse" style="display: none;">
                <button class="expand-btn" onclick="toggleProvenanceExpansion()">
                    <span>Show less</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="18 15 12 9 6 15"></polyline>
                    </svg>
                </button>
            </li>
        `;
        
        // Show last item (Verification)
        html += renderItem(filteredProvenance[totalItems - 1], false);
    } else {
        // Show remaining items (no collapse needed)
        for (let i = 1; i < totalItems; i++) {
            html += renderItem(filteredProvenance[i], false);
        }
    }
    
    provenanceList.innerHTML = html;
}

function renderAuthorInfo(authorInfo) {
    // Update Artist field with C2PA author name if available
    const artistField = document.getElementById('artist');
    // Check multiple possible author name fields: name, author, identifier
    const authorName = authorInfo.name || authorInfo.author || authorInfo.identifier;
    if (authorName && typeof authorName === 'string' && authorName.trim() && artistField) {
        // If EXIF artist is empty or 'Unknown', use C2PA author
        if (!artistField.textContent || artistField.textContent === 'Unknown') {
            artistField.textContent = authorName.trim();
        }
    }
    
    // Website
    const websiteItem = document.getElementById('authorWebsiteItem');
    const websiteValue = document.getElementById('authorWebsite');
    if (authorInfo.url && websiteItem && websiteValue) {
        websiteValue.innerHTML = `<a href="${authorInfo.url}" target="_blank" rel="noopener">${authorInfo.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>`;
        websiteItem.style.display = 'flex';
    } else if (websiteItem) {
        websiteItem.style.display = 'none';
    }
    
    // Email
    const emailItem = document.getElementById('authorEmailItem');
    const emailValue = document.getElementById('authorEmail');
    if (authorInfo.email && emailItem && emailValue) {
        emailValue.innerHTML = `<a href="mailto:${authorInfo.email}">${authorInfo.email}</a>`;
        emailItem.style.display = 'flex';
    } else if (emailItem) {
        emailItem.style.display = 'none';
    }
    
    // Phone
    const phoneItem = document.getElementById('authorPhoneItem');
    const phoneValue = document.getElementById('authorPhone');
    if (authorInfo.telephone && phoneItem && phoneValue) {
        phoneValue.textContent = authorInfo.telephone;
        phoneItem.style.display = 'flex';
    } else if (phoneItem) {
        phoneItem.style.display = 'none';
    }
    
    // Job Title
    const jobItem = document.getElementById('authorJobItem');
    const jobValue = document.getElementById('authorJob');
    if (authorInfo.jobTitle && jobItem && jobValue) {
        jobValue.textContent = authorInfo.jobTitle;
        jobItem.style.display = 'flex';
    } else if (jobItem) {
        jobItem.style.display = 'none';
    }
    
    // Organization
    const orgItem = document.getElementById('authorOrgItem');
    const orgValue = document.getElementById('authorOrg');
    if (authorInfo.worksFor && orgItem && orgValue) {
        orgValue.textContent = authorInfo.worksFor;
        orgItem.style.display = 'flex';
    } else if (orgItem) {
        orgItem.style.display = 'none';
    }
    
    // Social Media Links
    const socialContainer = document.getElementById('authorSocial');
    const socialLinks = document.getElementById('socialLinks');
    
    // Collect all social links from various possible fields (avoid duplicates)
    const allSocialLinks = new Set();
    
    // Add links from sameAs array
    if (authorInfo.sameAs && Array.isArray(authorInfo.sameAs)) {
        authorInfo.sameAs.forEach(url => {
            if (typeof url === 'string' && url.trim()) {
                allSocialLinks.add(url.trim());
            }
        });
    }
    
    // Add links from social_links object (new format with instagram, twitter, linkedin keys)
    if (authorInfo.social_links && typeof authorInfo.social_links === 'object') {
        Object.entries(authorInfo.social_links).forEach(([platform, url]) => {
            if (url && typeof url === 'string' && url.trim()) {
                allSocialLinks.add(url.trim());
            }
        });
    }
    
    // Also check 'url' field directly (common in C2PA CreativeWork)
    if (authorInfo.url && typeof authorInfo.url === 'string') {
        const urlLower = authorInfo.url.toLowerCase();
        // Only add if it's a social media URL (not just a personal website)
        if ((urlLower.includes('instagram') || urlLower.includes('twitter') || 
             urlLower.includes('linkedin') || urlLower.includes('facebook'))) {
            allSocialLinks.add(authorInfo.url.trim());
        }
    }
    
    // Check 'url' array if it exists
    if (authorInfo.url && Array.isArray(authorInfo.url)) {
        authorInfo.url.forEach(url => {
            if (typeof url === 'string' && url.trim()) {
                const urlLower = url.toLowerCase();
                if (urlLower.includes('instagram') || urlLower.includes('twitter') || 
                    urlLower.includes('linkedin') || urlLower.includes('facebook')) {
                    allSocialLinks.add(url.trim());
                }
            }
        });
    }
    
    // Show social media container only if we have social links
    if (socialContainer && socialLinks) {
        if (allSocialLinks.size > 0) {
            let socialHtml = '';
            allSocialLinks.forEach(url => {
                const platform = getSocialPlatform(url);
                socialHtml += `<a href="${url}" target="_blank" rel="noopener" class="social-link ${platform}" title="${platform}">${getSocialIcon(platform)}</a>`;
            });
            socialLinks.innerHTML = socialHtml;
            socialContainer.style.display = 'flex';
        } else {
            socialLinks.innerHTML = '';
            socialContainer.style.display = 'none';
        }
    }
}

function getSocialPlatform(url) {
    const domain = url.toLowerCase();
    if (domain.includes('instagram')) return 'instagram';
    if (domain.includes('twitter') || domain.includes('x.com')) return 'twitter';
    if (domain.includes('facebook')) return 'facebook';
    if (domain.includes('linkedin')) return 'linkedin';
    if (domain.includes('youtube')) return 'youtube';
    if (domain.includes('tiktok')) return 'tiktok';
    if (domain.includes('behance')) return 'behance';
    if (domain.includes('dribbble')) return 'dribbble';
    if (domain.includes('github')) return 'github';
    if (domain.includes('flickr')) return 'flickr';
    if (domain.includes('500px')) return '500px';
    if (domain.includes('unsplash')) return 'unsplash';
    return 'website';
}

function getSocialIcon(platform) {
    // SVG icons for social media platforms
    const icons = {
        instagram: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>`,
        twitter: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
        linkedin: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
        facebook: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
        youtube: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,
        tiktok: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>`,
        behance: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M22 7h-7V5h7v2zm1.726 10c-.442 1.297-2.029 3-5.101 3-3.074 0-5.564-1.729-5.564-5.675 0-3.91 2.325-5.92 5.466-5.92 3.082 0 4.964 1.782 5.375 4.426.078.506.109 1.188.095 2.14H15.97c.13 3.211 3.483 3.312 4.588 2.029h3.168zm-7.686-4h4.965c-.105-1.547-1.136-2.219-2.477-2.219-1.466 0-2.277.768-2.488 2.219zm-9.574 6.988H0V5.021h6.953c5.476.081 5.58 5.444 2.72 6.906 3.461 1.26 3.577 8.061-3.207 8.061zM3 11h3.584c2.508 0 2.906-3-.312-3H3v3zm3.391 3H3v3.016h3.341c3.055 0 2.868-3.016.05-3.016z"/></svg>`,
        dribbble: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 24C5.385 24 0 18.615 0 12S5.385 0 12 0s12 5.385 12 12-5.385 12-12 12zm10.12-10.358c-.35-.11-3.17-.953-6.384-.438 1.34 3.684 1.887 6.684 1.992 7.308 2.3-1.555 3.936-4.02 4.395-6.87zm-6.115 7.808c-.153-.9-.75-4.032-2.19-7.77l-.066.02c-5.79 2.015-7.86 6.025-8.04 6.4 1.73 1.36 3.94 2.166 6.27 2.166 1.42 0 2.77-.29 4-.814zm-11.62-2.58c.232-.4 3.045-5.055 8.332-6.765.135-.045.27-.084.405-.12-.26-.585-.54-1.167-.832-1.74C7.17 11.775 2.206 11.71 1.756 11.7l-.004.312c0 2.633.998 5.037 2.634 6.855zm-2.42-8.955c.46.008 4.683.026 9.477-1.248-1.698-3.018-3.53-5.558-3.8-5.928-2.868 1.35-5.01 3.99-5.676 7.17zM9.6 2.052c.282.38 2.145 2.914 3.822 6 3.645-1.365 5.19-3.44 5.373-3.702-1.81-1.61-4.19-2.586-6.795-2.586-.825 0-1.63.1-2.4.285zm10.335 3.483c-.218.29-1.935 2.493-5.724 4.04.24.49.47.985.68 1.486.08.18.15.36.22.53 3.41-.43 6.8.26 7.14.33-.02-2.42-.88-4.64-2.31-6.38z"/></svg>`,
        github: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>`,
        flickr: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 22C6.486 22 2 17.514 2 12S6.486 2 12 2s10 4.486 10 10-4.486 10-10 10zm0-16c-3.314 0-6 2.686-6 6s2.686 6 6 6 6-2.686 6-6-2.686-6-6-6zm0 10c-2.206 0-4 1.794-4 4s1.794 4 4 4 4-1.794 4-4-1.794-4-4-4z"/></svg>`,
        '500px': `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 22.08c-1.336 0-2.436-1.08-2.436-2.436 0-1.344 1.08-2.436 2.436-2.436 1.344 0 2.436 1.08 2.436 2.436 0 1.344-1.08 2.436-2.436 2.436zm5.04-9.72c-1.548-1.488-4.104-1.8-6.336-1.04-1.02.344-2.04.66-3.12.96-2.544.72-4.728.24-6.576-.24l.96 5.88c1.44 1.08 3.24 1.68 5.16 1.68 2.88 0 5.04-1.32 6.136-2.904.473-.685.751-1.496.751-2.376 0-1.776-1.416-3.24-3.031-3.24v.24z"/></svg>`,
        unsplash: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7.5 6.75V0h9v6.75h-9zm9 3.75H24V24H0V10.5h7.5v6.75h9V10.5z"/></svg>`,
        website: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`
    };
    return icons[platform] || icons.website;
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

function renderSourceThumbnail(thumbnails) {
    const sourceImage = document.getElementById('sourceImage');
    const placeholder = document.getElementById('thumbnailPlaceholder');
    
    if (thumbnails?.ingredient_thumbnail) {
        sourceImage.src = `data:image/jpeg;base64,${thumbnails.ingredient_thumbnail}`;
        sourceImage.style.display = 'block';
        
        if (placeholder) {
            placeholder.style.display = 'none';
        }
        
        sourceImage.addEventListener('load', function() {
            this.style.margin = '0 auto';
        });
        
        sourceImage.addEventListener('error', function() {
            this.style.display = 'none';
            if (placeholder) {
                placeholder.style.display = 'flex';
            }
        });
    } else {
        sourceImage.style.display = 'none';
        if (placeholder) {
            placeholder.style.display = 'flex';
        }
    }
}

function clearAllMetadata() {
    // Clear Image Overview
    const sourceImage = document.getElementById('sourceImage');
    const thumbnailPlaceholder = document.getElementById('thumbnailPlaceholder');
    const filename = document.getElementById('filename');
    const overviewDimensions = document.getElementById('overviewDimensions');
    const overviewFileSize = document.getElementById('overviewFileSize');
    
    if (sourceImage) {
        sourceImage.src = '';
        sourceImage.style.display = 'none';
    }
    if (thumbnailPlaceholder) {
        thumbnailPlaceholder.style.display = 'flex';
    }
    if (filename) {
        filename.textContent = '';
    }
    updateImageTitle(null);
    if (overviewDimensions) {
        overviewDimensions.textContent = '';
    }
    if (overviewFileSize) {
        overviewFileSize.textContent = '';
    }
    
    // Clear Technical Details
    const fields = ['cameraMake', 'cameraModel', 'lensModel', 'exposureMode', 'whiteBalance', 
                   'flash', 'aperture', 'shutterSpeed', 'iso', 'focalLength', 'resolution',
                   'dimensions', 'colorSpace', 'colorProfile', 'software'];
    fields.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
    
    // Clear Creator Information
    const artist = document.getElementById('artist');
    const dateOriginal = document.getElementById('dateOriginal');
    const dateDigitized = document.getElementById('dateDigitized');
    const gpsCoordinates = document.getElementById('gpsCoordinates');
    const gpsItem = document.getElementById('gpsItem');
    
    if (artist) artist.textContent = '';
    if (dateOriginal) dateOriginal.textContent = '';
    if (dateDigitized) dateDigitized.textContent = '';
    if (gpsCoordinates) gpsCoordinates.textContent = '';
    if (gpsItem) gpsItem.style.display = 'none';
    
    // Clear Author contact info
    const authorFields = ['authorWebsite', 'authorEmail', 'authorPhone', 'authorJob', 'authorOrg'];
    const authorItems = ['authorWebsiteItem', 'authorEmailItem', 'authorPhoneItem', 'authorJobItem', 'authorOrgItem'];
    
    authorFields.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
    authorItems.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    
    // Clear Social Media
    const socialLinks = document.getElementById('socialLinks');
    const authorSocial = document.getElementById('authorSocial');
    if (socialLinks) socialLinks.innerHTML = '';
    if (authorSocial) authorSocial.style.display = 'none';
    
    // Clear Provenance
    const provenanceList = document.getElementById('provenanceList');
    const provenanceEmpty = document.getElementById('provenanceEmpty');
    if (provenanceList) {
        provenanceList.innerHTML = '';
        provenanceList.style.display = 'none';
    }
    if (provenanceEmpty) {
        provenanceEmpty.style.display = 'flex';
    }
    
    // Clear Description
    const imageDescription = document.getElementById('imageDescription');
    if (imageDescription) imageDescription.textContent = '';
}

async function uploadImageFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    
    // Clear previous metadata before loading new image
    clearAllMetadata();
    
    showLoading();
    
    try {
        const response = await fetch(`/c2pa/api/upload`, {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        const imageKey = Object.keys(data)[0];
        const metadata = data[imageKey];
        
        // Display the image
        const mainImage = document.getElementById('mainImage');
        mainImage.src = metadata.image_data;
        mainImage.style.display = 'block';
        
        // Hide drag and drop zone completely to reveal main image
        const dragDropZone = document.getElementById('dragDropZone');
        if (dragDropZone) {
            dragDropZone.classList.add('hidden');
        }
        
        // Show filename and update title header
        const filenameElement = document.getElementById('filename');
        if (filenameElement) {
            filenameElement.textContent = metadata.filename || 'Unknown';
        }
        updateImageTitle(metadata.filename);
        
        hideLoading();
        
        // Render metadata - this will "bring to life" the empty fields
        try {
            renderPhotographyMetadata(metadata);
            renderExifMetadata(metadata);
            renderGPSMetadata(metadata);
            renderIPTCMetadata(metadata);
        } catch (renderError) {
            console.error('Error rendering metadata:', renderError);
        }
        
        // Update Content Credentials status
        const hasProvenance = metadata.provenance && metadata.provenance.length > 0;
        updateC2PAStatus(hasProvenance, metadata.provenance?.length || 0);
        
        // Render C2PA provenance data from upload response
        if (hasProvenance) {
            renderC2PAMetadata(metadata.provenance, true);
        } else {
            renderC2PAMetadata(null, false);
        }
        
        // Render author info from C2PA data if available
        if (metadata.author_info) {
            renderAuthorInfo(metadata.author_info);
        }
        
        // Update digital source type badge
        updateDigitalSourceType(metadata.digital_source_type);
        
        // Load and display C2PA metadata
        if (metadata.thumbnails && metadata.thumbnails.ingredient_thumbnail) {
            const sourceImage = document.getElementById('sourceImage');
            sourceImage.src = `data:image/jpeg;base64,${metadata.thumbnails.ingredient_thumbnail}`;
            sourceImage.style.display = 'block';
            
            const placeholder = document.getElementById('thumbnailPlaceholder');
            if (placeholder) {
                placeholder.style.display = 'none';
            }
            
            sourceImage.addEventListener('load', function() {
                this.style.margin = '0 auto';
            });
        }
        
    } catch (error) {
        console.error('Error uploading image:', error);
        hideLoading();
        displayError(`Failed to upload image: ${error.message}`);
    }
}

function setupDragAndDrop() {
    const dropZone = document.getElementById('dropZone');
    const dragDropZone = document.getElementById('dragDropZone');
    const fileInput = document.getElementById('fileInput');
    
    if (!dropZone || !dragDropZone || !fileInput) {
        console.error('Required elements not found for drag and drop');
        return;
    }
    
    // Prevent default drag behaviors on the whole document
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        document.body.addEventListener(eventName, preventDefaults, false);
    });
    
    // Highlight drop zone when dragging over
    function highlight(e) {
        dragDropZone.classList.add('dragover');
    }
    
    function unhighlight(e) {
        dragDropZone.classList.remove('dragover');
    }
    
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, highlight, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, unhighlight, false);
    });
    
    // Handle dropped files
    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        
        if (files.length > 0 && files[0].type.startsWith('image/')) {
            uploadImageFile(files[0]);
        } else if (files.length > 0) {
            displayError('Please select a valid image file');
        }
    }
    
    dropZone.addEventListener('drop', handleDrop, false);
    
    // Handle file selection via button
    fileInput.addEventListener('change', function(e) {
        console.log('File input change event triggered');
        if (e.target.files && e.target.files.length > 0) {
            console.log('File selected:', e.target.files[0].name);
            uploadImageFile(e.target.files[0]);
        }
    });
    
    // Note: Clicking on the "select a file" label will trigger the file input
    // via the label's "for" attribute. Drag and drop still works anywhere.
}

async function init() {
    const params = await extractParamsFromUrl();
    
    // Always set up drag and drop (works even when image is showing)
    setupDragAndDrop();
    
    if (!params.imageUri) {
        // Sidebar now shows empty template with em-dashes by default
        // No placeholder needed - all sections visible with empty state
        
        return;
    }
    
    showLoading();
    
    try {
        // Load EXIF/IPTC/GPS metadata (fast, no cryptographic verification)
        const metadata = await loadExifMetadataFromApi(params.imageUri);
        
        if (metadata) {
            const mainImage = document.getElementById('mainImage');
            if (metadata.image_data) {
                mainImage.src = metadata.image_data;
            } else {
                mainImage.src = params.imageUri;
            }
            mainImage.style.display = 'block';
            
            // Hide the welcome zone completely when image loads
            const dragDropZone = document.getElementById('dragDropZone');
            if (dragDropZone) {
                dragDropZone.classList.add('hidden');
            }
            
            hideLoading();
            
            // Check if C2PA verification container exists before accessing style
            const c2paVerificationContainer = document.querySelector('.c2pa-verification-container');
            if (c2paVerificationContainer) {
                c2paVerificationContainer.style.display = 'block';
            }
            
            // Show filename under source thumbnail and update title header
            const filenameElement = document.getElementById('filename');
            if (filenameElement) {
                filenameElement.textContent = metadata.filename;
                filenameElement.style.display = 'block';
            }
            updateImageTitle(metadata.filename);
            renderPhotographyMetadata(metadata);
            renderExifMetadata(metadata);
            renderGPSMetadata(metadata);
            renderIPTCMetadata(metadata);
            
            // Load C2PA metadata (slower, involves cryptographic verification)
            const c2paData = await loadC2PAMetadataFromApi(params.imageUri);
            if (c2paData && c2paData.provenance && c2paData.provenance.length > 0) {
                updateC2PAStatus(true, c2paData.provenance.length);
                renderC2PAMetadata(c2paData.provenance, true);
            } else {
                updateC2PAStatus(false, 0);
                renderC2PAMetadata(null, false);
            }
            
            // Render author info from C2PA data if available
            if (c2paData && c2paData.author_info) {
                renderAuthorInfo(c2paData.author_info);
            }
            
            // Update digital source type badge
            updateDigitalSourceType(c2paData?.digital_source_type);
            
            // Render thumbnails from C2PA data
            renderSourceThumbnail(c2paData?.thumbnails);
        }
    } catch (error) {
        console.error('Error initializing:', error);
        hideLoading();
        displayError(`Failed to initialize: ${error.message}`);
    }
}

// Theme Management
function initTheme() {
    const themeToggle = document.getElementById('themeToggle');
    const html = document.documentElement;

    // Load saved theme or default to light
    const savedTheme = localStorage.getItem('theme') || 'light';
    html.setAttribute('data-theme', savedTheme);

    // Toggle theme on button click
    themeToggle.addEventListener('click', () => {
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    });
}

// Reset Button - Go back to welcome page
function initResetButton() {
    const resetBtn = document.getElementById('resetBtn');
    if (!resetBtn) return;

    resetBtn.addEventListener('click', () => {
        // Scroll to top (especially important for mobile)
        window.scrollTo({ top: 0, behavior: 'smooth' });
        
        // Clear URL parameters to go back to welcome state
        window.history.pushState({}, '', window.location.pathname);
        
        // Clear all metadata
        clearAllMetadata();
        
        // Hide main image
        const mainImage = document.getElementById('mainImage');
        if (mainImage) {
            mainImage.src = '';
            mainImage.style.display = 'none';
        }
        
        // Show welcome zone again
        const dragDropZone = document.getElementById('dragDropZone');
        if (dragDropZone) {
            dragDropZone.classList.remove('hidden');
        }
        
        // Reset C2PA status
        updateC2PAStatus(false, 0);
        
        // Reset digital source type
        updateDigitalSourceType(null);
    });
}

// Info Button - Show About modal
function initInfoButton() {
    const infoBtn = document.getElementById('infoBtn');
    const aboutModal = document.getElementById('aboutModal');
    const modalClose = document.getElementById('modalClose');
    
    if (!infoBtn || !aboutModal) return;

    // Open modal
    infoBtn.addEventListener('click', () => {
        aboutModal.classList.add('active');
        document.body.style.overflow = 'hidden';
    });

    // Close modal on close button
    if (modalClose) {
        modalClose.addEventListener('click', () => {
            aboutModal.classList.remove('active');
            document.body.style.overflow = '';
        });
    }

    // Close modal on overlay click
    aboutModal.addEventListener('click', (e) => {
        if (e.target === aboutModal) {
            aboutModal.classList.remove('active');
            document.body.style.overflow = '';
        }
    });

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && aboutModal.classList.contains('active')) {
            aboutModal.classList.remove('active');
            document.body.style.overflow = '';
        }
    });
}

// Update image title header with filename
function updateImageTitle(filename) {
    const imageTitleHeader = document.getElementById('imageTitleHeader');
    const imageTitle = document.getElementById('imageTitle');
    const imageCaption = document.getElementById('imageCaption');
    
    if (!imageTitleHeader || !imageTitle) return;
    
    if (filename) {
        // Show full filename with extension
        imageTitle.textContent = filename;
        imageTitleHeader.classList.add('has-content');
    } else {
        imageTitle.textContent = '';
        if (imageCaption) imageCaption.textContent = '';
        imageTitleHeader.classList.remove('has-content');
    }
}

// Initialize theme when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initTheme();
        initResetButton();
        initInfoButton();
        init();
    });
} else {
    initTheme();
    initResetButton();
    initInfoButton();
    init();
}