/**
 * Direct Firebase Storage line uploads for driver expenses (no IndexedDB / SW queue).
 * Uses resumable uploads + 15s stall cancel; merges into expenseBatches via server read (same safety as upload-complete).
 */
(function (global) {
    'use strict';

    var STALL_MS = 15000;
    var mergeChain = Promise.resolve();

    /** @type {Object<string, { status: string, progress: number, error: string|null, uploadTask: * }>} */
    var stateByLine = {};
    var stallTimers = {};
    var lastBytesByLine = {};
    var lastBytesTimeByLine = {};

    function setState(lineKey, patch) {
        stateByLine[lineKey] = Object.assign({}, stateByLine[lineKey] || {}, patch);
        if (typeof global.onExpenseLineUploadStateChange === 'function') {
            try { global.onExpenseLineUploadStateChange(lineKey, stateByLine[lineKey]); } catch (e) { /* ignore */ }
        }
    }

    function clearStallTimer(lineKey) {
        if (stallTimers[lineKey]) {
            clearInterval(stallTimers[lineKey]);
            delete stallTimers[lineKey];
        }
        delete lastBytesByLine[lineKey];
        delete lastBytesTimeByLine[lineKey];
    }

    function startStallWatch(lineKey, getTask) {
        clearStallTimer(lineKey);
        lastBytesByLine[lineKey] = -1;
        lastBytesTimeByLine[lineKey] = Date.now();
        stallTimers[lineKey] = setInterval(function () {
            var t = getTask();
            if (!t || t._cancelled) return;
            var snap = t.snapshot;
            if (!snap) return;
            var b = snap.bytesTransferred;
            if (b !== lastBytesByLine[lineKey]) {
                lastBytesByLine[lineKey] = b;
                lastBytesTimeByLine[lineKey] = Date.now();
                return;
            }
            if (Date.now() - (lastBytesTimeByLine[lineKey] || 0) >= STALL_MS) {
                try {
                    t.cancel();
                } catch (e) { /* ignore */ }
            }
        }, 1000);
    }

    function getBatchFromServerWithRetry(batchRef, maxAttempts) {
        maxAttempts = maxAttempts || 3;
        var attempt = 0;
        function tryGet() {
            attempt++;
            return global.getDocFromServer(batchRef).catch(function (e) {
                if (attempt < maxAttempts && e && (e.code === 'unavailable' || (e.message && (e.message.indexOf('network') !== -1 || e.message.indexOf('unavailable') !== -1)))) {
                    return new Promise(function (resolve) { setTimeout(resolve, 400); }).then(tryGet);
                }
                throw e;
            });
        }
        return tryGet();
    }

    function isValidPhotoURL(u) {
        if (global.isValidPhotoURL) return global.isValidPhotoURL(u);
        return typeof u === 'string' && u.trim().length > 0 && (u.startsWith('http://') || u.startsWith('https://'));
    }

    function storagePathKey(url) {
        return (url || '').replace(/&token=[^&]*/i, '').trim();
    }

    function hasSameFile(existingList, url) {
        return existingList.some(function (ex) { return storagePathKey(ex) === storagePathKey(url); });
    }

    function mergeLinePhotosToFirestore(batchId, lineKey, newUrls, morePending) {
        if (!batchId || !lineKey || !newUrls || !newUrls.length) return Promise.resolve();
        var batchRef = global.doc(global.db, 'expenseBatches', batchId);
        var readPromise = typeof global.getDocFromServer === 'function'
            ? getBatchFromServerWithRetry(batchRef)
            : global.getDoc(batchRef);
        return readPromise.then(function (batchSnap) {
            if (!batchSnap.exists()) return;
            var data = batchSnap.data();
            var lines = {};
            var key;
            for (key in (data.lines || {})) {
                if (Object.prototype.hasOwnProperty.call(data.lines, key)) {
                    lines[key] = Object.assign({}, data.lines[key]);
                }
            }
            var line = lines[lineKey] || { amount: 0, photos: [] };
            var existingPhotos = Array.isArray(line.photos) ? line.photos.filter(function (p) { return typeof p === 'string' && isValidPhotoURL(p); }) : [];
            var all = existingPhotos.slice();
            for (var i = 0; i < newUrls.length; i++) {
                var u = newUrls[i];
                if (isValidPhotoURL(u) && !hasSameFile(all, u)) all.push(u);
            }
            var deduped = global.dedupePhotoURLsByPath ? global.dedupePhotoURLsByPath(all) : all;
            var uploading = !!morePending;
            lines[lineKey] = Object.assign({}, line, { photos: deduped, photosUploading: uploading });
            return global.updateDoc(batchRef, {
                lines: lines,
                updatedAt: global.serverTimestamp ? global.serverTimestamp() : new Date()
            });
        });
    }

    function runMergeSerialized(batchId, lineKey, urls, morePending) {
        mergeChain = mergeChain.then(function () {
            return mergeLinePhotosToFirestore(batchId, lineKey, urls, morePending);
        }).catch(function (err) {
            console.error('[ExpenseLineUpload] merge failed', err);
        });
        return mergeChain;
    }

    /**
     * @param {object} params
     * @param {string} params.batchId
     * @param {string} params.lineKey
     * @param {string} params.registration - for storage path
     * @param {string} params.categorySlug - e.g. train, fuel
     * @param {Blob|File[]} params.blobs
     * @param {function} params.onLineUpdated - (urls) => void local batch update
     */
    async function startUploadForLine(params) {
        var batchId = params.batchId;
        var lineKey = params.lineKey;
        var registration = params.registration || '';
        var categorySlug = params.categorySlug || 'expense';
        var blobs = params.blobs || [];
        var onLineUpdated = params.onLineUpdated;

        if (!batchId || !lineKey || !blobs.length) return;

        if (!global.storage || !global.ref || !global.uploadBytesResumable) {
            console.error('[ExpenseLineUpload] missing Firebase Storage APIs');
            return;
        }
        if (!navigator.onLine) {
            setState(lineKey, { status: 'error', error: 'offline', progress: 0 });
            return;
        }

        // Replace any in-progress upload for this line (e.g. user added more photos and we restart with full blob list)
        try {
            cancelLine(lineKey);
        } catch (e) { /* ignore */ }

        clearStallTimer(lineKey);
        // So the batch list / UI can show the bar immediately (no gap waiting on auth / token)
        setState(lineKey, { status: 'uploading', error: null, progress: 0, uploadTask: null });

        if (global.ensureFirebaseAuthReady) {
            try { await global.ensureFirebaseAuthReady(); } catch (e) { /* continue */ }
        }
        if (global.auth && global.auth.currentUser) {
            try { await global.auth.currentUser.getIdToken(true); } catch (e) { console.warn('[ExpenseLineUpload] getIdToken', e); }
        }

        var regFolder = (global.sanitizeRegForStoragePath && global.sanitizeRegForStoragePath(registration)) || batchId;
        var collectedUrls = [];
        var currentTask = null;
        var cancelled = false;

        function uploadOneBlob(blob, i, total) {
            var timestamp = Date.now() + i;
            var path = 'expenses/' + regFolder + '/' + categorySlug + '_' + timestamp + '_' + i + '.jpg';
            var storageRef = global.ref(global.storage, path);
            var metadata = { contentType: 'image/jpeg' };
            var task = global.uploadBytesResumable(storageRef, blob, metadata);
            currentTask = task;
            setState(lineKey, { uploadTask: task, progress: Math.round((i / total) * 100) });
            startStallWatch(lineKey, function () { return currentTask; });
            lastBytesByLine[lineKey] = -1;
            lastBytesTimeByLine[lineKey] = Date.now();

            return new Promise(function (resolve, reject) {
                var lastReported = -1;
                task.on('state_changed', function (snapshot) {
                    var p = (snapshot.totalBytes > 0)
                        ? (i * 100 + (100 * snapshot.bytesTransferred / snapshot.totalBytes) / total)
                        : (i * 100);
                    p = Math.min(99, Math.round(p));
                    if (p !== lastReported) {
                        lastReported = p;
                        setState(lineKey, { progress: p });
                    }
                }, function (err) {
                    clearStallTimer(lineKey);
                    reject(err);
                }, function () {
                    clearStallTimer(lineKey);
                    global.getDownloadURL(storageRef).then(resolve).catch(reject);
                });
            });
        }

        try {
            for (var i = 0; i < blobs.length; i++) {
                if (cancelled) break;
                var downloadURL = await uploadOneBlob(blobs[i], i, blobs.length);
                collectedUrls.push(downloadURL);
                var moreLeft = (i < blobs.length - 1);
                await runMergeSerialized(batchId, lineKey, [downloadURL], moreLeft);
                if (onLineUpdated) onLineUpdated(collectedUrls.slice(), i + 1, blobs.length);
            }
            clearStallTimer(lineKey);
            if (!cancelled) {
                setState(lineKey, { status: 'done', progress: 100, uploadTask: null, error: null });
                if (onLineUpdated) onLineUpdated(collectedUrls.slice(), collectedUrls.length, collectedUrls.length);
            }
        } catch (err) {
            clearStallTimer(lineKey);
            if (err && (err.code === 'storage/canceled' || (err.message && err.message.indexOf('canceled') !== -1))) {
                setState(lineKey, { status: 'stalled', error: 'canceled', progress: 0, uploadTask: null });
            } else {
                console.error('[ExpenseLineUpload] upload error', err);
                setState(lineKey, { status: 'error', error: (err && err.message) || 'upload failed', progress: 0, uploadTask: null });
            }
        }
    }

    function cancelLine(lineKey) {
        var s = stateByLine[lineKey];
        if (s && s.uploadTask && typeof s.uploadTask.cancel === 'function') {
            try { s.uploadTask.cancel(); } catch (e) { /* ignore */ }
        }
        clearStallTimer(lineKey);
        delete stateByLine[lineKey];
    }

    function cancelAll() {
        Object.keys(stateByLine).forEach(cancelLine);
    }

    function hasActive() {
        return Object.keys(stateByLine).some(function (k) {
            var s = stateByLine[k];
            return s && (s.status === 'uploading');
        });
    }

    function isLineStalledOrError(lineKey) {
        var s = stateByLine[lineKey];
        return s && (s.status === 'stalled' || s.status === 'error');
    }

    function getState(lineKey) {
        return stateByLine[lineKey] || null;
    }

    /** Synchronous: set uploading state before any await so the batch list can paint the bar immediately. */
    function setLineUploadingImmediate(lineKey) {
        if (!lineKey) return;
        try {
            cancelLine(lineKey);
        } catch (e) { /* ignore */ }
        clearStallTimer(lineKey);
        setState(lineKey, { status: 'uploading', error: null, progress: 0, uploadTask: null });
    }

    function clearLineState(lineKey) {
        cancelLine(lineKey);
    }

    function resetAll() {
        cancelAll();
        stateByLine = {};
    }

    global.ExpenseLineUpload = {
        startUploadForLine: startUploadForLine,
        setLineUploadingImmediate: setLineUploadingImmediate,
        cancelLine: cancelLine,
        cancelAll: cancelAll,
        hasActive: hasActive,
        isLineStalledOrError: isLineStalledOrError,
        getState: getState,
        clearLineState: clearLineState,
        resetAll: resetAll
    };
})(typeof window !== 'undefined' ? window : globalThis);
