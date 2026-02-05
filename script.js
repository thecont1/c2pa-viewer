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
        if (section && section.style) {
            section.style.display = 'none';
        }
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
        statusValue.textContent = 'Verified';
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
    const shouldCollapse = totalItems > 2; // Need at least 3 items to collapse (first, middle(s), last)
    
    let html = '';
    
    // Helper to render a single item
    function renderItem(item, isHidden = false) {
        const hiddenClass = isHidden ? 'style="display: none;"' : '';
        const collapsedClass = isHidden ? 'collapsed-item' : '';
        
        if (item.name === 'Action' && item.action) {
            const actionInfo = metadataMappings.actions[item.action];
            const icon = actionInfo?.icon || '📋';
            const description = actionInfo?.description || item.action;
            const actionLabel = getActionLabel(item);
            
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
                <li class="provenance-item ${item.verification === 'Valid' ? 'verified' : ''} ${collapsedClass}" ${hiddenClass}>
                    <strong>✓ Verification</strong>
                    <p>${item.verification}</p>
                    ${item.issuer ? `<p class="timestamp">Issuer: ${item.issuer}</p>` : ''}
                </li>
            `;
        } else if (item.generator) {
            return `
                <li class="provenance-item ${collapsedClass}" ${hiddenClass}>
                    <strong>⚙️ Software</strong>
                    <p>${item.generator}</p>
                    ${item.version ? `<p class="timestamp">Version: ${item.version}</p>` : ''}
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
    
    // Show first item
    html += renderItem(filteredProvenance[0], false);
    
    // Add collapsed middle items (if any)
    if (shouldCollapse) {
        const middleCount = totalItems - 2; // All except first and last
        for (let i = 1; i < totalItems - 1; i++) {
            html += renderItem(filteredProvenance[i], true);
        }
        
        // Add expand/collapse button
        html += `
            <li class="provenance-item expand-toggle" id="provenanceToggle">
                <button class="expand-btn" onclick="toggleProvenanceExpansion()">
                    <span>+${middleCount} more entries</span>
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
    console.log('Rendering author info:', authorInfo);
    
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
    console.log('Social sameAs:', authorInfo.sameAs, 'length:', authorInfo.sameAs?.length);
    if (authorInfo.sameAs && authorInfo.sameAs.length > 0 && socialContainer && socialLinks) {
        let socialHtml = '';
        authorInfo.sameAs.forEach(url => {
            const platform = getSocialPlatform(url);
            console.log('Adding social link:', url, 'platform:', platform);
            socialHtml += `<a href="${url}" target="_blank" rel="noopener" class="social-link ${platform}">${platform}</a>`;
        });
        socialLinks.innerHTML = socialHtml;
        socialContainer.style.display = 'block';
    } else if (socialContainer) {
        socialContainer.style.display = 'none';
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
        
        // Hide placeholder if exists
        const placeholder = document.getElementById('thumbnailPlaceholder');
        if (placeholder) {
            placeholder.style.display = 'none';
        }
        
        // Ensure thumbnail is centered within container
        sourceImage.addEventListener('load', function() {
            this.style.margin = '0 auto';
        });
    } else {
        const sourceImage = document.getElementById('sourceImage');
        sourceImage.style.display = 'none';
        
        // Show placeholder if exists
        const placeholder = document.getElementById('thumbnailPlaceholder');
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
        const response = await fetch('http://localhost:8080/api/upload', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        const imageKey = Object.keys(data)[0];
        const metadata = data[imageKey];
        
        console.log('Uploaded image metadata:', metadata);
        
        // Display the image
        const mainImage = document.getElementById('mainImage');
        mainImage.src = metadata.image_data;
        mainImage.style.display = 'block';
        
        // Hide drag and drop zone
        const dragDropZone = document.getElementById('dragDropZone');
        dragDropZone.classList.add('hidden');
        
        // Show filename
        const filenameElement = document.getElementById('filename');
        if (filenameElement) {
            filenameElement.textContent = metadata.filename || 'Unknown';
        }
        
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
    
    // Also allow clicking anywhere on the drag-drop zone to trigger file input
    dragDropZone.addEventListener('click', function(e) {
        // Don't trigger if clicking the select button itself (it has its own label behavior)
        if (!e.target.closest('.select-file-btn')) {
            fileInput.click();
        }
    });
}

async function init() {
    const params = await extractParamsFromUrl();
    
    if (!params.imageUri) {
        // Show drag and drop zone
        setupDragAndDrop();
        
        // Sidebar now shows empty template with em-dashes by default
        // No placeholder needed - all sections visible with empty state
        
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
                updateC2PAStatus(true, c2paProvenance.length);
                renderC2PAMetadata(c2paProvenance, true);
            } else {
                updateC2PAStatus(false, 0);
                renderC2PAMetadata(null, false);
            }
            
            await renderSourceThumbnail(params.imageUri);
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

// Initialize theme when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initTheme();
        init();
    });
} else {
    initTheme();
    init();
}