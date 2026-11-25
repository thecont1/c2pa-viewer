// Social-link extraction from CreativeWork assertions, ported verbatim.

export function extractSocialLinks(assertionData) {
    const socialLinks = {};
    if (!assertionData) return socialLinks;

    const authorArray = assertionData.author;
    if (Array.isArray(authorArray)) {
        for (const author of authorArray) {
            if (author && typeof author === 'object') {
                const authorId = author['@id'] || '';
                if (authorId && typeof authorId === 'string') {
                    const lower = authorId.toLowerCase();
                    if (lower.includes('instagram.com')) socialLinks.instagram = authorId;
                    else if (lower.includes('twitter.com') || lower.includes('x.com')) socialLinks.twitter = authorId;
                    else if (lower.includes('linkedin.com')) socialLinks.linkedin = authorId;
                }
            }
        }
    }

    const socialMappings = {
        instagram: ['instagram', 'instagram_url'],
        twitter: ['twitter', 'twitter_url', 'x_url'],
        linkedin: ['linkedin', 'linkedin_url'],
    };
    for (const [socialType, keys] of Object.entries(socialMappings)) {
        if (socialLinks[socialType]) continue;
        for (const key of keys) {
            let value = assertionData[key];
            if (value) {
                if (typeof value !== 'string') value = String(value);
                if (!value.startsWith('http://') && !value.startsWith('https://')) {
                    value = `https://${value}`;
                }
                socialLinks[socialType] = value;
                break;
            }
        }
    }

    const urlField = assertionData.url;
    if (typeof urlField === 'string') {
        const lower = urlField.toLowerCase();
        if (lower.includes('instagram.com') && !socialLinks.instagram) socialLinks.instagram = urlField;
        else if ((lower.includes('twitter.com') || lower.includes('x.com')) && !socialLinks.twitter) socialLinks.twitter = urlField;
        else if (lower.includes('linkedin.com') && !socialLinks.linkedin) socialLinks.linkedin = urlField;
    }

    const urls = assertionData.url;
    if (Array.isArray(urls)) {
        for (const url of urls) {
            if (typeof url !== 'string') continue;
            const lower = url.toLowerCase();
            if (lower.includes('instagram.com') && !socialLinks.instagram) socialLinks.instagram = url;
            else if ((lower.includes('twitter.com') || lower.includes('x.com')) && !socialLinks.twitter) socialLinks.twitter = url;
            else if (lower.includes('linkedin.com') && !socialLinks.linkedin) socialLinks.linkedin = url;
        }
    }

    return socialLinks;
}
