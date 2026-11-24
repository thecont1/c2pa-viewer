// Digital-source-type heuristics ported verbatim from src/compute.js.

export const DIGITAL_SOURCE_TYPE_LABELS = {
    'digitalCapture': 'Digital Camera',
    'negativeFilm': 'Negative Film Scan',
    'positiveFilm': 'Slide Film Scan',
    'print': 'Print Scan',
    'screenCapture': 'Screen Capture',
    'trainedAlgorithmicMedia': 'Generative AI',
    'algorithmicallyEnhanced': 'AI Enhanced',
    'minorHumanEdits': 'Lightly Edited',
    'compositeCapture': 'Composite (Camera)',
    'compositeDigital': 'Composite (Digital)',
    'compositeSynthetic': 'Composite (Synthetic)',
    'compositeWithTrainedAlgorithmicMedia': 'Composite (AI + Camera)',
    'multiFrameComputationalCapture': 'Computational Photography',
    'virtualRecording': 'Virtual Recording',
    'digitalArt': 'Digital Art',
    'dataDrivenMedia': 'Data-Driven Media',
};

export function getDigitalSourceType(c2paData) {
    if (!c2paData) return [null, null];

    const claimGenerator = ((c2paData.basic_info && c2paData.basic_info.claim_generator) || '').toLowerCase();
    const aiTools = ['firefly', 'dall-e', 'dalle', 'midjourney', 'stable diffusion',
        'generative fill', 'generative remove', 'generative'];
    if (aiTools.some(t => claimGenerator.includes(t))) {
        return ['trainedAlgorithmicMedia', 'Generative AI'];
    }

    const scanActions = (actionsList) => {
        for (const action of actionsList || []) {
            const actionName = (action.action || '').toLowerCase();
            const softwareAgent = (action.softwareAgent || '').toLowerCase();
            const parameters = action.parameters || {};
            if (actionName.includes('generative') || actionName.includes('ai')) {
                return ['trainedAlgorithmicMedia', 'Generative AI'];
            }
            if (aiTools.some(t => softwareAgent.includes(t))) {
                return ['trainedAlgorithmicMedia', 'Generative AI'];
            }
            for (const [key, value] of Object.entries(parameters)) {
                const keyLower = (key || '').toLowerCase();
                const valueLower = String(value || '').toLowerCase();
                if (['firefly', 'generative', 'ai', 'text_to_image'].some(kw => keyLower.includes(kw))) {
                    return ['trainedAlgorithmicMedia', 'Generative AI'];
                }
                if (['text_to_image', 'generative', 'firefly'].some(kw => valueLower.includes(kw))) {
                    return ['trainedAlgorithmicMedia', 'Generative AI'];
                }
            }
        }
        return null;
    };

    for (const assertion of c2paData.assertions || []) {
        const label = assertion.label || '';
        const data = assertion.data || {};
        const labelLower = label.toLowerCase();
        if (labelLower.includes('iptc') || labelLower.includes('photo-metadata')) {
            const st = data.digitalSourceType;
            if (st) return [st, DIGITAL_SOURCE_TYPE_LABELS[st] || st];
        }
        if (label.includes('CreativeWork')) {
            const st = data.digitalSourceType;
            if (st) return [st, DIGITAL_SOURCE_TYPE_LABELS[st] || st];
        }
        if (labelLower.includes('actions')) {
            const hit = scanActions(data.actions);
            if (hit) return hit;
        }
    }

    const legacyHit = scanActions(c2paData.actions);
    if (legacyHit) return legacyHit;

    const ingredients = c2paData.ingredients || [];
    for (const ingredient of ingredients) {
        const fmt = (ingredient.format || '').toLowerCase();
        const title = (ingredient.title || '').toLowerCase();
        if (fmt.includes('dng') || fmt.includes('raw') || title.endsWith('.dng') || title.endsWith('.raw')) {
            return ['digitalCapture', 'Digital Camera (RAW)'];
        }
        if (fmt.includes('jpeg') || fmt.includes('jpg') || fmt.includes('tiff')) {
            return ['digitalCapture', 'Digital Camera'];
        }
    }

    if ((c2paData.actions && c2paData.actions.length) || (c2paData.ingredients && c2paData.ingredients.length)) {
        return ['digitalCapture', 'Digital Camera'];
    }
    return [null, null];
}
