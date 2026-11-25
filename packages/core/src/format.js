// Date / claim-generator formatting ported verbatim from src/compute.js
// (which ported server.py).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDateFields(y, mo, d, h, mi) {
    const h12 = h % 12 || 12;
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${MONTHS[mo]} ${pad2(d)}, ${y} at ${h12}:${pad2(mi)} ${ampm}`;
}

function tzName(date) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
            .formatToParts(date);
        const tz = parts.find(p => p.type === 'timeZoneName');
        return tz ? tz.value : '';
    } catch { return ''; }
}

export function formatDatetimeFull(dtString, includeTimezone = false) {
    if (!dtString || dtString === 'Unknown') return 'Unknown';
    try {
        if (typeof dtString !== 'string') dtString = String(dtString);

        // ISO 8601 (contains 'T')
        if (dtString.includes('T')) {
            const m = dtString.match(/(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
            if (!m) return dtString;
            const [, y, mo, d, h, mi] = m;
            if (includeTimezone) {
                const dt = new Date(dtString.replace('Z', '+00:00'));
                if (isNaN(dt)) return dtString;
                const tz = tzName(dt);
                return formatDateFields(dt.getFullYear(), dt.getMonth(), dt.getDate(),
                    dt.getHours(), dt.getMinutes()) + (tz ? ` ${tz}` : '');
            }
            // Python strftime uses the datetime's own (source-tz) fields.
            return formatDateFields(+y, +mo - 1, +d, +h, +mi);
        }

        // EXIF format YYYY:MM:DD HH:MM:SS
        const em = dtString.match(/(\d{4}):(\d{1,2}):(\d{1,2}) (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
        if (em) {
            const [, y, mo, d, h, mi] = em;
            return formatDateFields(+y, +mo - 1, +d, +h, +mi);
        }
    } catch (e) {
        console.warn('datetime format failed:', e);
    }
    return dtString;
}

export function formatClaimGenerator(generator) {
    if (!generator) return 'Unknown';
    if (generator.includes('/')) {
        const parts = generator.split('/');
        const software = parts[0].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const version = parts.length > 1 ? parts[1] : '';
        return version ? `${software} ${version}` : software;
    }
    return generator;
}
