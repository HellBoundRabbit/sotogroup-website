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

    /** Extract Firebase Storage object path from a download URL (/o/... enc path). */
    function extractStoragePathFromDownloadURL(downloadURL) {
        try {
            const url = new URL(downloadURL);
            const pathMatch = url.pathname.match(/\/o\/(.+)/);
            if (pathMatch) return decodeURIComponent(pathMatch[1]);
            return null;
        } catch (e) {
            return null;
        }
    }

    function extensionFromMime(mime) {
        if (!mime || typeof mime !== 'string') return null;
        const m = mime.split(';')[0].trim().toLowerCase();
        const map = {
            'image/jpeg': '.jpg',
            'image/jpg': '.jpg',
            'image/pjpeg': '.jpg',
            'image/png': '.png',
            'image/webp': '.webp',
            'image/gif': '.gif',
            'image/bmp': '.bmp',
            'image/heic': '.heic',
            'image/heif': '.heic',
            'image/svg+xml': '.svg',
            'image/tiff': '.tif',
            'image/x-tiff': '.tif'
        };
        if (map[m]) return map[m];
        if (m.startsWith('image/')) return '.jpg';
        return null;
    }

    async function sniffImageExtension(blob) {
        if (!blob || blob.size < 12) return null;
        const buf = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
        if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
        if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
        if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif';
        if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
            buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return '.webp';
        if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp';
        if (buf.length >= 4 && buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) return '.tif';
        if (buf.length >= 4 && buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a) return '.tif';
        return null;
    }

    function declaredMimeType(blobType, headerContentType) {
        const raw = (blobType && String(blobType).trim() ? blobType : headerContentType) || '';
        return raw.split(';')[0].trim().toLowerCase();
    }

    /** HEIC/HEIF/SVG are trusted from MIME only when magic sniff does not apply. */
    function allowsImageWithoutMagicSniff(declaredMime) {
        if (!declaredMime) return false;
        return declaredMime === 'image/heic' || declaredMime === 'image/heif' || declaredMime === 'image/svg+xml';
    }

    /**
     * Fetches a photo URL. Retries on failure. Validates HTTP status, image type, and size.
     * Optional refreshFn(photoURL) returns a fresh URL (e.g. getDownloadURL). When provided, it runs once
     * before the first fetch so stale Firestore tokens do not spam 403s; extra refresh retries remain as fallback.
     * @param {string} photoURL - Firebase Storage download URL
     * @param {number} retries - Retries per URL (default 2)
     * @param {((originalUrl: string) => Promise<string|null|undefined>)|undefined} refreshFn
     * @returns {Promise<{blob:Blob,ext:string}|{error:{url:string,reason:string,status?:number}}>}
     */
    async function fetchPhotoBlob(photoURL, retries = 2, refreshFn) {
        const MIN_VALID_SIZE = 500;

        async function attemptFetch(url) {
            let lastError = null;
            for (let attempt = 0; attempt <= retries; attempt++) {
                try {
                    const fetchOpts =
                        typeof url === 'string' && url.indexOf('firebasestorage.googleapis.com') >= 0
                            ? { cache: 'no-store', mode: 'cors' }
                            : {};
                    const response = await fetch(url, fetchOpts);
                    if (!response.ok) {
                        lastError = {
                            url,
                            reason: 'HTTP ' + response.status + ' ' + response.statusText,
                            status: response.status
                        };
                        if (attempt < retries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                        continue;
                    }
                    const blob = await response.blob();
                    const ct = response.headers.get('Content-Type') || '';
                    const fromMime = extensionFromMime(blob.type) || extensionFromMime(ct);
                    const sniffed = await sniffImageExtension(blob);
                    if (!sniffed && !fromMime) {
                        lastError = {
                            url,
                            reason: 'Not an image (type: ' + (blob.type || '(empty)') + ', Content-Type: ' + (ct || '(empty)') + ')'
                        };
                        if (attempt < retries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                        continue;
                    }
                    const declared = declaredMimeType(blob.type, ct);
                    if (!sniffed && fromMime && !allowsImageWithoutMagicSniff(declared)) {
                        lastError = {
                            url,
                            reason: 'Declared image but body is not a known image (possibly an HTML/XML error page). Declared: ' + (declared || '(none)')
                        };
                        if (attempt < retries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                        continue;
                    }
                    const ext = sniffed || fromMime;
                    const contentLength = response.headers.get('Content-Length');
                    if (contentLength) {
                        const expected = parseInt(contentLength, 10);
                        if (!isNaN(expected) && blob.size !== expected) {
                            lastError = { url, reason: 'Size mismatch: got ' + blob.size + ', expected ' + expected };
                            if (attempt < retries) await new Promise(r => setTimeout(r, 400));
                            continue;
                        }
                    }
                    if (blob.size < MIN_VALID_SIZE) {
                        lastError = {
                            url,
                            reason: 'Suspiciously small (' + blob.size + ' bytes), likely error page'
                        };
                        if (attempt < retries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                        continue;
                    }
                    return { blob, ext };
                } catch (err) {
                    lastError = { url, reason: (err && err.message) ? err.message : String(err) };
                    if (attempt < retries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                }
            }
            return { error: lastError };
        }

        let startUrl = photoURL;
        if (typeof refreshFn === 'function') {
            try {
                let fresh = await refreshFn(photoURL);
                if (fresh && typeof fresh === 'string' && fresh === photoURL) {
                    fresh = await refreshFn(photoURL);
                }
                if (fresh && typeof fresh === 'string') startUrl = fresh;
            } catch (refreshErr) {
                /* keep photoURL */
            }
        }

        let result = await attemptFetch(startUrl);
        if (result.blob) return result;

        if (startUrl !== photoURL) {
            result = await attemptFetch(photoURL);
            if (result.blob) return result;
        }

        if (typeof refreshFn === 'function') {
            try {
                const freshAgain = await refreshFn(photoURL);
                if (freshAgain && typeof freshAgain === 'string' && freshAgain !== startUrl) {
                    result = await attemptFetch(freshAgain);
                    if (result.blob) return result;
                }
            } catch (e) {
                /* ignore */
            }
        }
        return { error: result.error };
    }

    const PHOTO_TRANSFER_FAILURE_FILENAME = 'PHOTOS_NOT_DOWNLOADED.txt';

    function appendPhotoFailureLines(lines, failures) {
        failures.forEach((f, i) => {
            lines.push('[' + (i + 1) + '] ' + (f.reason || 'Unknown'));
            if (f.batch) lines.push('    Batch: ' + f.batch);
            if (f.lineLabel || f.lineKey) lines.push('    Expense line: ' + (f.lineLabel || f.lineKey));
            lines.push('    URL: ' + (f.url || ''));
            lines.push('');
        });
    }

    /**
     * Builds debug text from failed photo fetches for support/debugging.
     * @param {Array<{url:string,reason:string,status?:number}>} failures
     * @param {string} context - e.g. batch registration, "Transfer"
     * @returns {string}
     */
    function buildPhotoFetchDebugText(failures, context) {
        const lines = ['--- Photo download failure report ---', 'Context: ' + (context || 'Expense transfer'), 'Date: ' + new Date().toISOString(), 'Failed count: ' + failures.length, ''];
        appendPhotoFailureLines(lines, failures);
        lines.push('--- End report ---');
        return lines.join('\n');
    }

    /**
     * Plain-language report saved next to the PDF when downloads fail (office folder / ZIP).
     */
    function buildPhotoFailureFolderReport(failures, context) {
        const lines = [
            'IMPORTANT: Not all receipt photos were saved next to the PDF in this folder.',
            '',
            'Each item below failed after HTTP retries and refreshing the Firebase download URL.',
            'Use this file as your record of missing images (same as noticing broken photos in Office Expenses).',
            '',
            'Open Office Expenses in SOTO Routes to view or fix photos, then export again.',
            '',
            '--- Details ---',
            'Context: ' + (context || 'Expense transfer'),
            'Date: ' + new Date().toISOString(),
            'Failed count: ' + failures.length,
            ''
        ];
        appendPhotoFailureLines(lines, failures);
        lines.push('--- End ---');
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
        extractStoragePathFromDownloadURL,
        fetchPhotoBlob,
        PHOTO_TRANSFER_FAILURE_FILENAME,
        buildPhotoFetchDebugText,
        buildPhotoFailureFolderReport
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
