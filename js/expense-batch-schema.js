/**
 * Expense Batch Schema - Single-document batch with fixed line slots.
 * 8 categories × 4 slots = 32 lines. Each line: amount + up to 4 photos.
 */

(function (global) {
    const MAX_PHOTOS_PER_LINE = 4;

    const LINE_KEYS = [
        'train1', 'train2', 'train3', 'train4',
        'taxi1', 'taxi2', 'taxi3', 'taxi4',
        'fuel1', 'fuel2', 'fuel3', 'fuel4',
        'charge1', 'charge2', 'charge3', 'charge4',
        'bus1', 'bus2', 'bus3', 'bus4',
        'carWash1', 'carWash2', 'carWash3', 'carWash4',
        'toll1', 'toll2', 'toll3', 'toll4',
        'other1', 'other2', 'other3', 'other4'
    ];

    const CATEGORY_PREFIXES = [
        { key: 'train', label: 'Train' },
        { key: 'taxi', label: 'Taxi' },
        { key: 'fuel', label: 'Fuel' },
        { key: 'charge', label: 'Charge' },
        { key: 'bus', label: 'Bus' },
        { key: 'carWash', label: 'Car Wash' },
        { key: 'toll', label: 'Toll' },
        { key: 'other', label: 'Other' }
    ];

    function getCategoryLabel(lineKey) {
        if (!lineKey || typeof lineKey !== 'string') return '';
        const num = lineKey.replace(/^\D+/, '') || '1';
        const prefix = CATEGORY_PREFIXES.find(p => lineKey.startsWith(p.key));
        return prefix ? `${prefix.label} ${num}` : lineKey;
    }

    function getCategoryGroup(lineKey) {
        if (!lineKey) return null;
        const prefix = CATEGORY_PREFIXES.find(p => lineKey.startsWith(p.key));
        return prefix ? prefix.key : null;
    }

    function emptyLines() {
        const lines = {};
        LINE_KEYS.forEach(k => {
            lines[k] = { amount: 0, photos: [] };
        });
        return lines;
    }

    function getTotalFromLines(lines) {
        if (!lines || typeof lines !== 'object') return 0;
        let total = 0;
        LINE_KEYS.forEach(k => {
            const line = lines[k];
            if (line && typeof line.amount === 'number' && !isNaN(line.amount)) {
                total += line.amount;
            }
        });
        return Math.round(total * 100) / 100;
    }

    /** True if this line has a value: amount > 0 or at least one photo (URL or File/Blob). Used for "first empty slot" and expense count. */
    function hasLineContent(line) {
        if (!line) return false;
        const amount = typeof line.amount === 'number' && !isNaN(line.amount) ? line.amount : 0;
        const hasAnyPhoto = Array.isArray(line.photos) && line.photos.some(p =>
            (typeof p === 'string' && p.trim()) || (typeof File !== 'undefined' && p instanceof File) || (typeof Blob !== 'undefined' && p instanceof Blob)
        );
        return amount > 0 || !!hasAnyPhoto;
    }

    function getUsedLines(batch) {
        if (!batch || !batch.lines) return [];
        return LINE_KEYS.filter(k => hasLineContent(batch.lines[k]));
    }

    /** Returns used line keys in the order they were added (lineOrder). Falls back to getUsedLines for batches without lineOrder or with partial/stale lineOrder. */
    function getUsedLinesInOrder(batch) {
        if (!batch || !batch.lines) return [];
        const used = getUsedLines(batch);
        const order = batch.lineOrder && Array.isArray(batch.lineOrder) ? batch.lineOrder : null;
        if (!order || order.length === 0) return used;
        const fromOrder = order.filter(k => hasLineContent(batch.lines[k]));
        if (fromOrder.length === used.length && used.every(k => fromOrder.includes(k))) return fromOrder;
        return used;
    }

    function getUsedLineCount(batch) {
        return getUsedLines(batch).length;
    }

    /**
     * Fetches a photo URL. Retries on failure. Returns { blob } on success or { error } on failure.
     * @param {string} photoURL - Firebase Storage download URL
     * @param {number} retries - Number of retries (default 2)
     * @returns {Promise<{blob:Blob}|{error:{url:string,reason:string,status?:number}}>}
     */
    async function fetchPhotoBlob(photoURL, retries = 2) {
        const MIN_VALID_SIZE = 500;
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const response = await fetch(photoURL);
                if (!response.ok) {
                    lastError = { url: photoURL, reason: 'HTTP ' + response.status + ' ' + response.statusText, status: response.status };
                    if (attempt < retries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                    continue;
                }
                const blob = await response.blob();
                const contentLength = response.headers.get('Content-Length');
                if (contentLength) {
                    const expected = parseInt(contentLength, 10);
                    if (!isNaN(expected) && blob.size !== expected) {
                        lastError = { url: photoURL, reason: 'Size mismatch: got ' + blob.size + ', expected ' + expected };
                        if (attempt < retries) { await new Promise(r => setTimeout(r, 400)); continue; }
                        continue;
                    }
                }
                if (blob.size < MIN_VALID_SIZE) {
                    lastError = { url: photoURL, reason: 'Suspiciously small (' + blob.size + ' bytes), likely error page' };
                    if (attempt < retries) continue;
                    continue;
                }
                return { blob };
            } catch (err) {
                lastError = { url: photoURL, reason: (err && err.message) ? err.message : String(err) };
                if (attempt < retries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
            }
        }
        return { error: lastError };
    }

    /**
     * Builds debug text from failed photo fetches for support/debugging.
     * @param {Array<{url:string,reason:string,status?:number}>} failures
     * @param {string} context - e.g. batch registration, "Transfer"
     * @returns {string}
     */
    function buildPhotoFetchDebugText(failures, context) {
        const lines = ['--- Photo download failure report ---', 'Context: ' + (context || 'Expense transfer'), 'Date: ' + new Date().toISOString(), 'Failed count: ' + failures.length, ''];
        failures.forEach((f, i) => {
            lines.push('[' + (i + 1) + '] ' + (f.reason || 'Unknown'));
            if (f.batch) lines.push('    Batch: ' + f.batch);
            lines.push('    URL: ' + (f.url || ''));
            lines.push('');
        });
        lines.push('--- End report ---');
        return lines.join('\n');
    }

    function normalizeLines(lines) {
        if (!lines) return emptyLines();
        const out = emptyLines();
        LINE_KEYS.forEach(k => {
            const src = lines[k];
            if (src && typeof src === 'object') {
                out[k] = {
                    amount: typeof src.amount === 'number' && !isNaN(src.amount) ? src.amount : 0,
                    photos: Array.isArray(src.photos) ? src.photos.filter(p => typeof p === 'string') : []
                };
                if (out[k].photos.length > MAX_PHOTOS_PER_LINE) {
                    out[k].photos = out[k].photos.slice(0, MAX_PHOTOS_PER_LINE);
                }
            }
        });
        return out;
    }

    const schema = {
        MAX_PHOTOS_PER_LINE,
        LINE_KEYS,
        CATEGORY_PREFIXES,
        getCategoryLabel,
        getCategoryGroup,
        emptyLines,
        getTotalFromLines,
        hasLineContent,
        getUsedLines,
        getUsedLinesInOrder,
        getUsedLineCount,
        normalizeLines,
        fetchPhotoBlob,
        buildPhotoFetchDebugText
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = schema;
    } else {
        global.EXPENSE_BATCH_SCHEMA = schema;
        if (typeof global.fetchPhotoBlob === 'undefined') {
            global.fetchPhotoBlob = fetchPhotoBlob;
        }
    }
})(typeof window !== 'undefined' ? window : this);
