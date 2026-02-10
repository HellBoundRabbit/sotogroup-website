/**
 * Offline Storage & Upload Queue System for Expenses
 * Handles IndexedDB storage and smart photo upload queue
 */

/** Returns true only for non-empty HTTP/HTTPS URLs (avoids storing/displaying placeholders or broken entries). */
function isValidPhotoURL(url) {
    return typeof url === 'string' && url.trim().length > 0 && (url.startsWith('http://') || url.startsWith('https://'));
}
/** Normalize Firebase Storage URL to path (strip token) so same file = same key; retries produce new token. */
function storagePathKey(url) {
    return (url || '').replace(/\&token=[^&]*/i, '').trim();
}
/** Dedupe photo URL array by storage path (keeps first URL per file). */
function dedupePhotoURLsByPath(urls) {
    if (!Array.isArray(urls)) return [];
    const seen = new Set();
    return urls.filter(u => {
        if (!isValidPhotoURL(u)) return false;
        const key = storagePathKey(u);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
if (typeof window !== 'undefined') {
    window.isValidPhotoURL = isValidPhotoURL;
    window.dedupePhotoURLsByPath = dedupePhotoURLsByPath;
}

// IndexedDB wrapper for expense drafts
class ExpenseDraftDB {
    constructor() {
        this.dbName = 'ExpenseDraftsDB';
        this.version = 3; // Updated to support waitTimeUploadQueue store
        this.db = null;
    }

    sanitizeForStorage(value) {
        if (value === undefined) {
            return undefined;
        }
        if (value === null) {
            return null;
        }
        if (value instanceof File || value instanceof Blob) {
            return null;
        }
        if (value instanceof Date) {
            return value.getTime();
        }
        if (value && typeof value === 'object') {
            if (typeof value.toDate === 'function') {
                try {
                    return value.toDate().getTime();
                } catch (error) {
                    return null;
                }
            }
            if (Array.isArray(value)) {
                return value.map((item) => this.sanitizeForStorage(item)).filter((item) => item !== undefined);
            }
            const sanitized = {};
            for (const [key, val] of Object.entries(value)) {
                const result = this.sanitizeForStorage(val);
                if (result !== undefined) {
                    sanitized[key] = result;
                }
            }
            return sanitized;
        }
        if (typeof value === 'function') {
            return undefined;
        }
        return value;
    }

    async init() {
        const openDb = () => new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('batches')) {
                    const batchStore = db.createObjectStore('batches', { keyPath: 'localId' });
                    batchStore.createIndex('batchId', 'batchId', { unique: false });
                    batchStore.createIndex('driverId', 'driverId', { unique: false });
                    batchStore.createIndex('status', 'status', { unique: false });
                }
                if (!db.objectStoreNames.contains('photos')) {
                    const photoStore = db.createObjectStore('photos', { keyPath: 'photoId' });
                    photoStore.createIndex('expenseKey', 'expenseKey', { unique: false });
                }
                if (!db.objectStoreNames.contains('uploadQueue')) {
                    const queueStore = db.createObjectStore('uploadQueue', { keyPath: 'uploadId' });
                    queueStore.createIndex('batchId', 'batchId', { unique: false });
                    queueStore.createIndex('status', 'status', { unique: false });
                }
                if (!db.objectStoreNames.contains('photoBlobs')) {
                    const photoBlobStore = db.createObjectStore('photoBlobs', { keyPath: 'blobId' });
                }
                // New write-first upload queue store
                if (!db.objectStoreNames.contains('expenseUploadQueue')) {
                    const expenseUploadStore = db.createObjectStore('expenseUploadQueue', { keyPath: 'uploadId' });
                    expenseUploadStore.createIndex('batchId', 'batchId', { unique: false });
                    expenseUploadStore.createIndex('status', 'status', { unique: false });
                    expenseUploadStore.createIndex('expenseDocId', 'expenseDocId', { unique: false });
                }
                // Wait time upload queue store
                if (!db.objectStoreNames.contains('waitTimeUploadQueue')) {
                    const waitTimeUploadStore = db.createObjectStore('waitTimeUploadQueue', { keyPath: 'uploadId' });
                    waitTimeUploadStore.createIndex('status', 'status', { unique: false });
                    waitTimeUploadStore.createIndex('waitTimeDocId', 'waitTimeDocId', { unique: false });
                }
            };
        });

        const isRetryableDbError = (err) => {
            if (!err || !err.message) return false;
            const msg = String(err.message);
            const name = err.name || '';
            return msg.includes('Internal error opening backing store') ||
                msg.includes('backing store') ||
                name === 'UnknownError' ||
                name === 'InternalError';
        };

        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await openDb();
            } catch (err) {
                lastErr = err;
                if (attempt < 2 && isRetryableDbError(err)) {
                    await new Promise((r) => setTimeout(r, 400));
                    continue;
                }
                throw err;
            }
        }
        throw lastErr;
    }

    async saveDraft(batch, photos) {
        if (!this.db) await this.init();
        if (!batch.expenses) {
             return batch.localId;
         }
        const transaction = this.db.transaction(['batches', 'photos'], 'readwrite');
        if (!batch.localId) {
            batch.localId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        batch.lastSaved = Date.now();
        const sanitizedBatch = this.sanitizeForStorage(batch);
        await transaction.objectStore('batches').put(sanitizedBatch);
        if (photos && batch.expenses) {
            for (let expIndex = 0; expIndex < batch.expenses.length; expIndex++) {
                const expense = batch.expenses[expIndex];
                if (expense.photos && Array.isArray(expense.photos)) {
                    for (let photoIndex = 0; photoIndex < expense.photos.length; photoIndex++) {
                        const photo = expense.photos[photoIndex];
                        if (photo instanceof File || photo instanceof Blob) {
                            const photoId = `${batch.localId}_exp${expIndex}_photo${photoIndex}`;
                            const expenseKey = `${batch.localId}_exp${expIndex}`;
                            await transaction.objectStore('photos').put({
                                photoId, expenseKey, batchLocalId: batch.localId,
                                blob: photo, timestamp: Date.now()
                            });
                        }
                    }
                }
            }
        }
        return batch.localId;
    }

    async savePhotoBlob(localId, expenseIndex, photoIndex, blob) {
        if (!this.db) await this.init();
        
        // Ensure we have a proper Blob object (not File, which can't be cloned)
        let blobToStore = blob;
        if (blob instanceof File) {
            // Convert File to Blob to ensure it can be stored in IndexedDB
            try {
                const arrayBuffer = await blob.arrayBuffer();
                blobToStore = new Blob([arrayBuffer], { type: blob.type || 'image/jpeg' });
                console.log('[savePhotoBlob] Converted File to Blob', {
                    localId,
                    expenseIndex,
                    photoIndex,
                    originalType: blob.type,
                    size: blob.size
                });
            } catch (error) {
                console.error('[savePhotoBlob] Error converting File to Blob:', error);
                throw new Error(`Failed to convert File to Blob: ${error.message}`);
            }
        }
        
        const photoId = `${localId}_exp${expenseIndex}_photo${photoIndex}`;
        const expenseKey = `${localId}_exp${expenseIndex}`;
        
        try {
            const transaction = this.db.transaction(['photos'], 'readwrite');
            await transaction.objectStore('photos').put({
                photoId,
                expenseKey,
                batchLocalId: localId,
                blob: blobToStore,
                timestamp: Date.now()
            });
            console.log('[savePhotoBlob] Successfully saved photo blob', { photoId, expenseKey, size: blobToStore.size });
        } catch (error) {
            console.error('[savePhotoBlob] Failed to save photo blob to IndexedDB:', error, {
                photoId,
                expenseKey,
                blobType: blobToStore.constructor.name,
                blobSize: blobToStore.size
            });
            throw error;
        }
    }

    async getPhotoBlob(localId, expenseIndex, photoIndex) {
        if (!this.db) await this.init();
        const transaction = this.db.transaction(['photos'], 'readonly');
        return new Promise((resolve, reject) => {
            const request = transaction.objectStore('photos').get(`${localId}_exp${expenseIndex}_photo${photoIndex}`);
            request.onsuccess = () => resolve(request.result ? request.result.blob : null);
            request.onerror = () => reject(request.error);
        });
    }

    async deletePhotoBlob(localId, expenseIndex, photoIndex) {
        if (!this.db) await this.init();
        const transaction = this.db.transaction(['photos'], 'readwrite');
        await transaction.objectStore('photos').delete(`${localId}_exp${expenseIndex}_photo${photoIndex}`);
    }

    async getDraft(localIdOrBatchId) {
        if (!this.db) await this.init();
        const transaction = this.db.transaction(['batches', 'photos'], 'readonly');
        const batchStore = transaction.objectStore('batches');
        let batch = await batchStore.get(localIdOrBatchId);
        if (!batch) {
            const index = batchStore.index('batchId');
            const request = index.openCursor(IDBKeyRange.only(localIdOrBatchId));
            const result = await new Promise((resolve) => {
                request.onsuccess = (e) => resolve(e.target.result);
                request.onerror = () => resolve(null);
            });
            if (result) batch = result.value;
        }
        if (!batch) return null;
        const photoStore = transaction.objectStore('photos');
        const expenseKeyIndex = photoStore.index('expenseKey');
        const photos = {};
        if (batch.expenses) {
            for (let expIndex = 0; expIndex < batch.expenses.length; expIndex++) {
                const expenseKey = `${batch.localId}_exp${expIndex}`;
                const request = expenseKeyIndex.getAll(expenseKey);
                const photoRecords = await new Promise((resolve) => {
                    request.onsuccess = (e) => resolve(e.target.result || []);
                    request.onerror = () => resolve([]);
                });
                if (photoRecords.length > 0) {
                    if (!photos[expIndex]) photos[expIndex] = [];
                    // Preserve order: derive from photoId (e.g. "..._photo0", "..._photo1")
                    const photoIndexFromId = (r) => {
                        const m = (r.photoId || '').match(/_photo(\d+)$/);
                        return m ? parseInt(m[1], 10) : 0;
                    };
                    photoRecords.sort((a, b) => photoIndexFromId(a) - photoIndexFromId(b));
                    for (const record of photoRecords) {
                        photos[expIndex].push(record.blob);
                    }
                }
            }
        }
        if (batch.expenses) {
            for (let expIndex = 0; expIndex < batch.expenses.length; expIndex++) {
                const existingPhotos = batch.expenses[expIndex].photos;
                const existingURLs = Array.isArray(existingPhotos) ? existingPhotos.filter(p => typeof p === 'string' && isValidPhotoURL(p)) : [];
                const rehydratedBlobs = photos[expIndex] || [];
                // Leakproof: merge existing URLs with rehydrated blobs (do not replace — preserve already-uploaded URLs)
                batch.expenses[expIndex].photos = [...existingURLs, ...rehydratedBlobs];
            }
        }
        return batch;
    }

    async getAllDrafts(driverId) {
        if (!this.db) await this.init();
        const transaction = this.db.transaction(['batches'], 'readonly');
        const store = transaction.objectStore('batches');
        const index = store.index('driverId');
        const request = index.openCursor(IDBKeyRange.only(driverId));
        const drafts = [];
        return new Promise((resolve) => {
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    drafts.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(drafts);
                }
            };
            request.onerror = () => resolve([]);
        });
    }

    async deleteDraft(localId) {
        if (!this.db) await this.init();
        const transaction = this.db.transaction(['batches', 'photos'], 'readwrite');
        const photoStore = transaction.objectStore('photos');
        const request = photoStore.openCursor();
        request.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                if (cursor.value.batchLocalId === localId) {
                    cursor.delete();
                }
                cursor.continue();
            }
        };
        await transaction.objectStore('batches').delete(localId);
    }
}

// Upload Queue Manager
class UploadQueue {
    constructor() {
        this.db = null;
        this.isProcessing = false;
        this.maxRetries = 5;
        this.persistentStorageRequested = false; // Track if we've already requested persistent storage
    }

    async init() {
        // Only request persistent storage once per page load to avoid interfering with keyboard
        if (!this.persistentStorageRequested && navigator.storage && navigator.storage.persist) {
            this.persistentStorageRequested = true;
            try {
                const alreadyGranted = localStorage.getItem('expense_persisted') === 'true';
                const isPersisted = await navigator.storage.persisted();
                if (!alreadyGranted && !isPersisted) {
                    // Only request if user is NOT actively typing (prevents keyboard from closing)
                    const activeElement = document.activeElement;
                    const isTyping = activeElement && (
                        activeElement.tagName === 'INPUT' || 
                        activeElement.tagName === 'TEXTAREA'
                    );
                    
                    if (!isTyping) {
                        const granted = await navigator.storage.persist();
                        if (granted) {
                            localStorage.setItem('expense_persisted', 'true');
                        } else {
                            console.warn('[UploadQueue] Persistent storage request was denied. Receipts may not upload when the page is backgrounded.');
                        }
                    } else {
                        // User is typing - defer the request
                        setTimeout(() => {
                            if (!localStorage.getItem('expense_persisted')) {
                                navigator.storage.persist().then(granted => {
                                    if (granted) {
                                        localStorage.setItem('expense_persisted', 'true');
                                    }
                                }).catch(() => {});
                            }
                        }, 5000); // Wait 5 seconds after typing stops
                    }
                }
            } catch (error) {
                console.warn('[UploadQueue] Unable to request persistent storage', error);
            }
        }

        if (!window.expenseDraftDB) {
            window.expenseDraftDB = new ExpenseDraftDB();
        }
        
        // Ensure database is initialized
        await window.expenseDraftDB.init();
        
        // Wait for database to be available (handles upgrade delays)
        let retries = 0;
        while (!window.expenseDraftDB.db && retries < 20) {
            await new Promise(resolve => setTimeout(resolve, 50));
            retries++;
        }
        
        if (!window.expenseDraftDB.db) {
            console.error('Failed to initialize IndexedDB after retries');
            throw new Error('Failed to initialize IndexedDB');
        }
        
        this.db = window.expenseDraftDB.db;
    }

    async enqueue(uploadTask) {
        await this.init();
        if (!this.db) {
            console.error('Database not initialized in enqueue');
            return null;
        }
        const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const task = {
            uploadId, batchId: uploadTask.batchId, batchLocalId: uploadTask.batchLocalId,
            expenseIndex: uploadTask.expenseIndex, photoIndex: uploadTask.photoIndex,
            expenseDocId: uploadTask.expenseDocId || null,
            photoFilename: uploadTask.filename,
            status: 'pending', retries: 0, error: null, createdAt: Date.now()
        };
        const transaction = this.db.transaction(['uploadQueue'], 'readwrite');
        await transaction.objectStore('uploadQueue').put(task);

        if (uploadTask.photoFile) {
            try {
                console.log('[UploadQueue] Saving photo blob to IndexedDB', {
                    batchLocalId: uploadTask.batchLocalId,
                    batchId: uploadTask.batchId,
                    expenseIndex: uploadTask.expenseIndex,
                    photoIndex: uploadTask.photoIndex,
                    fileType: uploadTask.photoFile.constructor.name,
                    fileSize: uploadTask.photoFile.size
                });
                await window.expenseDraftDB.savePhotoBlob(uploadTask.batchLocalId || uploadTask.batchId, uploadTask.expenseIndex, uploadTask.photoIndex, uploadTask.photoFile);
                console.log('[UploadQueue] Photo blob saved successfully');
            } catch (error) {
                console.error('[UploadQueue] Failed to cache photo blob', error, {
                    batchLocalId: uploadTask.batchLocalId,
                    batchId: uploadTask.batchId,
                    expenseIndex: uploadTask.expenseIndex,
                    photoIndex: uploadTask.photoIndex,
                    errorMessage: error.message,
                    errorStack: error.stack
                });
                // Don't throw - we'll try to get the blob again during upload
            }
        } else {
            console.warn('[UploadQueue] No photoFile provided in uploadTask', uploadTask);
        }

        console.log('[UploadQueue] Enqueued task', task);
        if (navigator.onLine) {
            setTimeout(() => this.processQueue(), 100);
        }
        await this.updateGlobalUploadStatus();
        return uploadId;
    }

    async processQueue() {
        if (this.isProcessing || !navigator.onLine) {
            if (!navigator.onLine) {
                console.debug('[UploadQueue] Skipping processing because navigator.onLine is false');
            }
            return;
        }
        await this.init();
        if (!this.db) {
            console.error('Database not initialized in processQueue');
            this.isProcessing = false;
            return;
        }
        this.isProcessing = true;
        try {
            const allTasks = await this.getAllTasks();
            const tasksToProcess = allTasks.filter((task) => task.status === 'pending' || task.status === 'uploading');

            // Reset stuck uploads
            for (const task of tasksToProcess) {
                if (task.status === 'uploading') {
                    task.status = 'pending';
                    await this.saveTask(task);
                }
            }

            // Process tasks in parallel (up to 5 at a time for better performance)
            const CONCURRENT_UPLOADS = 5;
            const pendingTasks = tasksToProcess.filter(t => t.status === 'pending' && t.retries < this.maxRetries);
            
            // Process in batches of CONCURRENT_UPLOADS
            for (let i = 0; i < pendingTasks.length; i += CONCURRENT_UPLOADS) {
                const batch = pendingTasks.slice(i, i + CONCURRENT_UPLOADS);
                const uploadPromises = batch.map(async (task) => {
                    try {
                        console.debug('[UploadQueue] Processing task', task.uploadId, task.filename);
                        await this.uploadPhoto(task);
                        console.debug('[UploadQueue] Upload succeeded', task.uploadId);
                        await this.deleteTask(task.uploadId);
                        await window.expenseDraftDB.deletePhotoBlob(task.batchLocalId || task.batchId, task.expenseIndex, task.photoIndex);
                        return { success: true, task };
                    } catch (error) {
                        if (error && error.code === 'EXPENSE_DOC_MISSING') {
                            console.warn('[UploadQueue] Expense document missing, dropping task', task.uploadId);
                            await this.deleteTask(task.uploadId);
                            await window.expenseDraftDB.deletePhotoBlob(task.batchLocalId || task.batchId, task.expenseIndex, task.photoIndex);
                            return { success: false, task, error: 'EXPENSE_DOC_MISSING' };
                        } else if (error && error.code === 'PHOTO_BLOB_MISSING') {
                            console.warn('[UploadQueue] Cached photo missing, dropping task', task.uploadId);
                            await this.deleteTask(task.uploadId);
                            return { success: false, task, error: 'PHOTO_BLOB_MISSING' };
                        } else {
                            console.error('[UploadQueue] Upload failed', task.uploadId, error);
                            task.retries++;
                            task.status = 'pending';
                            task.error = error.message;
                            task.lastRetryAt = Date.now();
                            await this.saveTask(task);
                            return { success: false, task, error: error.message };
                        }
                    }
                });
                
                await Promise.all(uploadPromises);
                await this.updateGlobalUploadStatus();
            }

            // Remove tasks that exceeded max retries
            const failedTasks = tasksToProcess.filter(t => t.retries >= this.maxRetries);
            for (const task of failedTasks) {
                console.warn('[UploadQueue] Task exceeded max retries, removing', task.uploadId);
                await this.deleteTask(task.uploadId);
                await window.expenseDraftDB.deletePhotoBlob(task.batchLocalId || task.batchId, task.expenseIndex, task.photoIndex);
            }
        } catch (error) {
            console.error('Error processing queue:', error);
        } finally {
            this.isProcessing = false;
            await this.updateGlobalUploadStatus();
        }
    }

    async getAllTasks() {
        await this.init();
        if (!this.db) return [];
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['uploadQueue'], 'readonly');
            const store = transaction.objectStore('uploadQueue');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Check if there are any pending or uploading photos for a batch
     * @param {string} batchId - The batch ID (Firestore ID) or localId
     * @param {boolean} useLocalId - If true, match by batchLocalId; if false, match by batchId
     * @returns {Promise<{hasPending: boolean, count: number, tasks: Array}>}
     */
    async checkPendingUploads(batchId, useLocalId = false) {
        await this.init();
        if (!this.db || !batchId) {
            return { hasPending: false, count: 0, tasks: [] };
        }
        
        const allTasks = await this.getAllTasks();
        const pendingTasks = allTasks.filter(task => {
            if (task.status !== 'pending' && task.status !== 'uploading') {
                return false;
            }
            if (useLocalId) {
                return (task.batchLocalId === batchId);
            } else {
                return (task.batchId === batchId);
            }
        });
        
        return {
            hasPending: pendingTasks.length > 0,
            count: pendingTasks.length,
            tasks: pendingTasks
        };
    }

    /**
     * Wait for all pending uploads for a batch to complete
     * @param {string} batchId - The batch ID (Firestore ID) or localId
     * @param {boolean} useLocalId - If true, match by batchLocalId; if false, match by batchId
     * @param {number} timeoutMs - Maximum time to wait in milliseconds (default: 60000 = 60 seconds)
     * @returns {Promise<{success: boolean, remaining: number}>}
     */
    async waitForUploads(batchId, useLocalId = false, timeoutMs = 60000) {
        const startTime = Date.now();
        const checkInterval = 500; // Check every 500ms
        
        while (Date.now() - startTime < timeoutMs) {
            // Process the queue to keep uploads moving
            if (navigator.onLine && !this.isProcessing) {
                await this.processQueue();
            }
            
            const check = await this.checkPendingUploads(batchId, useLocalId);
            
            if (!check.hasPending) {
                console.log(`[UploadQueue] All uploads completed for batch ${batchId}`);
                return { success: true, remaining: 0 };
            }
            
            // Wait before checking again
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
        
        // Timeout reached
        const finalCheck = await this.checkPendingUploads(batchId, useLocalId);
        console.warn(`[UploadQueue] Timeout waiting for uploads for batch ${batchId}, ${finalCheck.count} still pending`);
        return { success: false, remaining: finalCheck.count };
    }

    async uploadPhoto(task) {
        const blob = await window.expenseDraftDB.getPhotoBlob(task.batchLocalId || task.batchId, task.expenseIndex, task.photoIndex);
        if (!blob) {
            const error = new Error('Missing cached photo for upload task.');
            error.code = 'PHOTO_BLOB_MISSING';
            throw error;
        }
        const photoRef = window.ref(window.storage, task.photoFilename);
        await window.uploadBytes(photoRef, blob);
        const downloadURL = await window.getDownloadURL(photoRef);
        console.log('[UploadQueue] Upload complete, updating expense', {expenseDocId: task.expenseDocId, batchId: task.batchId, expenseIndex: task.expenseIndex});
        const updated = await this.updateExpensePhotoUrl(task, downloadURL);
        if (!updated) {
            const error = new Error('Expense document missing');
            error.code = 'EXPENSE_DOC_MISSING';
            throw error;
        }
        return downloadURL;
    }

    async updateExpensePhotoUrl(task, downloadURL) {
        const {batchId, expenseIndex, photoIndex, expenseDocId} = task;
        try {
            let expenseDocRef = null;
            let expenseData = null;

            if (expenseDocId) {
                expenseDocRef = window.doc(window.db, 'expenses', expenseDocId);
                const docSnap = await window.getDoc(expenseDocRef);
                if (!docSnap.exists()) {
                    console.warn('Expense document not found for upload task', task);
                    return false;
                }
                expenseData = docSnap.data() || {};
            } else {
                const expensesQuery = window.query(
                    window.collection(window.db, 'expenses'),
                    window.where('batchId', '==', batchId)
                );
                const snapshot = await window.getDocs(expensesQuery);
                const expenseDocs = snapshot.docs;
                if (!expenseDocs[expenseIndex]) {
                    console.warn('Unable to resolve expense document for upload task', task);
                    return false;
                }
                expenseDocRef = expenseDocs[expenseIndex].ref;
                expenseData = expenseDocs[expenseIndex].data() || {};
            }

            if (!Array.isArray(expenseData.photos)) {
                expenseData.photos = [];
            }

            if (expenseData.photos[photoIndex]) {
                expenseData.photos[photoIndex] = downloadURL;
            } else {
                expenseData.photos.push(downloadURL);
            }
            // Only persist valid image URLs; dedupe by storage path (same file can have multiple tokens from retries)
            const validPhotos = dedupePhotoURLsByPath(expenseData.photos);

            await window.updateDoc(expenseDocRef, {
                photos: validPhotos,
                updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date()
            });
            console.log('[UploadQueue] Expense photo array updated in Firestore', {expenseDocId: expenseDocRef.id, photoIndex});

            if (window.currentBatch && window.currentBatch.id === batchId && window.currentBatch.expenses && window.currentBatch.expenses[expenseIndex]) {
                const localExpense = window.currentBatch.expenses[expenseIndex];
                if (!Array.isArray(localExpense.photos)) {
                    localExpense.photos = [];
                }
                localExpense.photos[photoIndex] = downloadURL;
            }
            return true;
        } catch (error) {
            console.error('Error updating expense photo URL:', error);
            throw error;
        }
    }

    async markFailed(uploadId, error) {
        await this.init();
        const transaction = this.db.transaction(['uploadQueue'], 'readwrite');
        const store = transaction.objectStore('uploadQueue');
        store.openCursor(IDBKeyRange.only(uploadId)).onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                const task = cursor.value;
                task.status = 'failed';
                task.error = error;
                cursor.update(task);
            }
        };
    }

    async getBatchUploadStatus(batchId) {
        await this.init();
        const transaction = this.db.transaction(['uploadQueue'], 'readonly');
        const store = transaction.objectStore('uploadQueue');
        const index = store.index('batchId');
        const request = index.openCursor(IDBKeyRange.only(batchId));
        const status = { pending: 0, uploading: 0, completed: 0, failed: 0, total: 0 };
        return new Promise((resolve) => {
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    status[cursor.value.status]++;
                    status.total++;
                    cursor.continue();
                } else {
                    resolve(status);
                }
            };
            request.onerror = () => resolve(status);
        });
    }

    updateUploadStatus(batchId, expenseIndex) {
        if (typeof renderExpenses === 'function' && window.currentBatch && window.currentBatch.id === batchId) {
            renderExpenses();
        }
    }

    async updateGlobalUploadStatus() {
        await this.init();
        if (!this.db) {
            console.error('Database not initialized in updateGlobalUploadStatus');
            this.hideUploadBanner();
            return;
        }
        
        // Don't update if user is actively typing (prevents keyboard from closing)
        // Check both the global flag and active element
        const activeElement = document.activeElement;
        const isTyping = (typeof window.isUserTyping !== 'undefined' && window.isUserTyping) ||
            (activeElement && (
                activeElement.tagName === 'INPUT' || 
                activeElement.tagName === 'TEXTAREA'
            ));
        
        // If user is typing, skip this update to avoid interfering with keyboard
        if (isTyping) {
            return;
        }
        
        const transaction = this.db.transaction(['uploadQueue'], 'readonly');
        const store = transaction.objectStore('uploadQueue');
        const statusIndex = store.index('status');
        const [pending, uploading, failed] = await Promise.all([
            new Promise(r => { 
                const req = statusIndex.count(IDBKeyRange.only('pending'));
                req.onsuccess = () => r(req.result); req.onerror = () => r(0);
            }),
            new Promise(r => { 
                const req = statusIndex.count(IDBKeyRange.only('uploading'));
                req.onsuccess = () => r(req.result); req.onerror = () => r(0);
            }),
            new Promise(r => { 
                const req = statusIndex.count(IDBKeyRange.only('failed'));
                req.onsuccess = () => r(req.result); req.onerror = () => r(0);
            })
        ]);

        let submissionQueued = 0;
        if (typeof window.getExpenseSubmissionQueueInfo === 'function') {
            try {
                const info = window.getExpenseSubmissionQueueInfo();
                if (info && typeof info.pending === 'number') {
                    submissionQueued = info.pending;
                }
            } catch (error) {
                console.warn('[UploadQueue] Unable to read submission queue info', error);
            }
        }
        
        const totalPhotos = pending + uploading;
        const isUploading = submissionQueued > 0 || totalPhotos > 0;
        
        console.debug('[UploadQueue] status counts', {pending, uploading, failed, submissionQueued, isUploading});
        
        const banner = document.getElementById('uploadBanner');
        const bannerText = document.getElementById('uploadBannerText');
        const topNav = document.getElementById('topNav');
        const mainContent = document.getElementById('mainContent');
        
        // Track previous upload state to detect when uploads complete
        const wasUploading = banner && !banner.classList.contains('hidden');
        
        if (isUploading) {
            // Show banner
            if (banner) {
                banner.classList.remove('hidden');
            }
            
            // Adjust top nav and content to account for banner
            if (topNav) {
                topNav.style.marginTop = '48px'; // Banner height
            }
            if (mainContent) {
                mainContent.style.marginTop = '0';
            }
            
            // Update banner text
            if (bannerText) {
                if (submissionQueued > 0) {
                    bannerText.textContent = `Uploading ${submissionQueued} Expense${submissionQueued === 1 ? '' : 's'}`;
                } else if (totalPhotos > 0) {
                    bannerText.textContent = `Uploading ${totalPhotos} Photo${totalPhotos === 1 ? '' : 's'}`;
                } else {
                    bannerText.textContent = 'Uploading...';
                }
            }
            
            // Show speed if available
            const speedContainer = document.getElementById('uploadBannerSpeed');
            const speedValue = document.getElementById('uploadSpeedValue');
            if (speedContainer && speedValue && parseFloat(speedValue.textContent) > 0) {
                speedContainer.classList.remove('hidden');
            }
        } else {
            // Hide banner
            this.hideUploadBanner();
            
            // Clear upload flag when all uploads are complete
            if (typeof window !== 'undefined') {
                window.isUploadingExpense = false;
            }
            
            // If banner was visible before and now it's hidden, refresh the expense list
            if (wasUploading && typeof window.loadExpenseBatches === 'function') {
                console.log('[UploadQueue] All uploads complete, refreshing expense list');
                // Small delay to ensure Firestore has propagated
                setTimeout(async () => {
                    try {
                        await window.loadExpenseBatches();
                    } catch (error) {
                        console.error('[UploadQueue] Error refreshing expense list:', error);
                    }
                }, 500);
            }
        }
    }
    
    hideUploadBanner() {
        const banner = document.getElementById('uploadBanner');
        const topNav = document.getElementById('topNav');
        const mainContent = document.getElementById('mainContent');
        const speedContainer = document.getElementById('uploadBannerSpeed');
        const speedValue = document.getElementById('uploadSpeedValue');
        
        if (banner) {
            banner.classList.add('hidden');
        }
        if (topNav) {
            topNav.style.marginTop = '0';
        }
        if (mainContent) {
            mainContent.style.marginTop = '0';
        }
        // Hide speed when banner is hidden
        if (speedContainer) {
            speedContainer.classList.add('hidden');
        }
        if (speedValue) {
            speedValue.textContent = '0';
        }
    }

    async clearAll() {
        await this.init();
        if (!this.db) {
            console.error('Database not initialized in clearAll');
            return;
        }
        console.debug('[UploadQueue] Clearing queue');
        await new Promise((resolve, reject) => {
            const tx = this.db.transaction(['uploadQueue'], 'readwrite');
            const store = tx.objectStore('uploadQueue');
            const req = store.clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
        await this.updateGlobalUploadStatus();
    }

    async deleteTask(uploadId) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['uploadQueue'], 'readwrite');
            const store = transaction.objectStore('uploadQueue');
            const request = store.delete(uploadId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async saveTask(task) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['uploadQueue'], 'readwrite');
            const store = transaction.objectStore('uploadQueue');
            const request = store.put(task);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

function sanitizeRegForStoragePath(reg) {
    if (!reg || typeof reg !== 'string') return '';
    return String(reg).replace(/[/\\]/g, '_').trim() || '';
}

// NEW: Write-First Expense Upload Queue (replaces old UploadQueue)
class ExpenseUploadQueue {
    constructor() {
        this.db = null;
    }

    async init() {
        if (this.db) return;
        try {
            if (!window.expenseDraftDB) {
                window.expenseDraftDB = new ExpenseDraftDB();
            }
            await window.expenseDraftDB.init();
            let retries = 0;
            while (!window.expenseDraftDB.db && retries < 20) {
                await new Promise(resolve => setTimeout(resolve, 50));
                retries++;
            }
            if (window.expenseDraftDB.db) {
                this.db = window.expenseDraftDB.db;
            } else {
                this.db = null;
            }
        } catch (err) {
            console.warn('[ExpenseUploadQueue] IndexedDB unavailable, upload queue disabled:', err?.message || err);
            this.db = null;
        }
    }

    /**
     * Write-first: Save expense data and photo blobs to IndexedDB immediately
     * NO UPLOAD - that happens later via service worker
     */
    async enqueueExpenseUpload(batchId, expenseData, photoBlobs = [], expenseDocId = null) {
        await this.init();
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        const uploadId = `expense_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const timestamp = Date.now();
        const uid = window.currentUser?.uid || null;

        // Convert all Files to Blobs in parallel (avoids sequential arrayBuffer() + single transaction below)
        const blobsToStore = await Promise.all(
            photoBlobs.map(async (blob, i) => {
                if (!(blob instanceof File || blob instanceof Blob)) return null;
                if (blob instanceof Blob && !(blob instanceof File)) return { blob, i };
                try {
                    const arrayBuffer = await blob.arrayBuffer();
                    return { blob: new Blob([arrayBuffer], { type: blob.type || 'image/jpeg' }), i };
                } catch (error) {
                    console.error('[ExpenseUploadQueue] Error converting File to Blob:', error);
                    throw new Error(`Failed to convert File to Blob: ${error.message}`);
                }
            })
        );

        const storageFolder = sanitizeRegForStoragePath(expenseData.registration) || batchId;
        const photoBlobIds = [];
        const recordsToPut = blobsToStore.filter(Boolean).map(({ blob: blobToStore, i }) => {
            const blobId = `${uploadId}_photo${i}`;
            photoBlobIds.push({
                blobId,
                photoIndex: i,
                filename: `expenses/${storageFolder}/${expenseData.category}_${timestamp}_${i}.jpg`
            });
            return { blobId, blob: blobToStore, uploadId, photoIndex: i, timestamp };
        });

        const uploadTask = {
            uploadId,
            batchId,
            expenseDocId,
            expenseData,
            photoBlobIds,
            uid,
            timestamp,
            status: 'pending',
            retries: 0,
            error: null,
            createdAt: timestamp,
            updatedAt: timestamp
        };

        // Single transaction: all blobs + one task (much faster than N+1 transactions)
        const tx = this.db.transaction(['photoBlobs', 'expenseUploadQueue'], 'readwrite');
        const blobStore = tx.objectStore('photoBlobs');
        const taskStore = tx.objectStore('expenseUploadQueue');
        for (const rec of recordsToPut) {
            blobStore.put({
                blobId: rec.blobId,
                blob: rec.blob,
                uploadId: rec.uploadId,
                photoIndex: rec.photoIndex,
                timestamp: rec.timestamp
            });
        }
        taskStore.put(uploadTask);
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        console.log('[ExpenseUploadQueue] Enqueued expense upload', { uploadId, batchId, photoCount: photoBlobIds.length });
        
        await this.updateGlobalUploadStatus();
        
        // Trigger service worker to process queue if online
        if (navigator.onLine && 'serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.ready;
                if (registration.active) {
                    // Get Firebase Auth token to pass to Service Worker
                    let authToken = null;
                    try {
                        if (window.auth && window.auth.currentUser) {
                            authToken = await window.auth.currentUser.getIdToken();
                        }
                    } catch (tokenError) {
                        console.warn('[ExpenseUploadQueue] Failed to get auth token:', tokenError);
                    }
                    
                    registration.active.postMessage({ 
                        type: 'process-queue',
                        data: { authToken: authToken }
                    });
                }
            } catch (error) {
                console.warn('[ExpenseUploadQueue] Failed to notify service worker:', error);
            }
        }

        return uploadId;
    }

    /**
     * Get pending upload count for banner
     */
    async getPendingCount() {
        await this.init();
        if (!this.db) return { expenseCount: 0, photoCount: 0 };

        const tx = this.db.transaction(['expenseUploadQueue'], 'readonly');
        const store = tx.objectStore('expenseUploadQueue');
        const statusIndex = store.index('status');
        
        const pending = await new Promise((resolve) => {
            const req = statusIndex.count(IDBKeyRange.only('pending'));
            req.onsuccess = () => resolve(req.result || 0);
            req.onerror = () => resolve(0);
        });

        const uploading = await new Promise((resolve) => {
            const req = statusIndex.count(IDBKeyRange.only('uploading'));
            req.onsuccess = () => resolve(req.result || 0);
            req.onerror = () => resolve(0);
        });

        // Get all tasks to count photos
        const allTasks = await new Promise((resolve) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });

        let photoCount = 0;
        allTasks.forEach(task => {
            if (task.status === 'pending' || task.status === 'uploading') {
                photoCount += (task.photoBlobIds || []).length;
            }
        });

        return {
            expenseCount: pending + uploading,
            photoCount: photoCount
        };
    }

    /**
     * Update global upload status banner
     */
    async updateGlobalUploadStatus() {
        await this.init();
        if (!this.db) {
            this.hideUploadBanner();
            return;
        }

        // Skip if user is typing
        const activeElement = document.activeElement;
        const isTyping = (typeof window.isUserTyping !== 'undefined' && window.isUserTyping) ||
            (activeElement && (
                activeElement.tagName === 'INPUT' || 
                activeElement.tagName === 'TEXTAREA'
            ));
        
        if (isTyping) {
            return;
        }

        const pendingCounts = await this.getPendingCount();
        const { expenseCount, photoCount } = pendingCounts;
        
        // Check for submission queue too
        let submissionQueued = 0;
        if (typeof window.getExpenseSubmissionQueueInfo === 'function') {
            try {
                const info = window.getExpenseSubmissionQueueInfo();
                if (info && typeof info.pending === 'number') {
                    submissionQueued = info.pending;
                }
            } catch (error) {
                console.warn('[ExpenseUploadQueue] Unable to read submission queue info', error);
            }
        }

        const totalExpenseCount = expenseCount + submissionQueued;
        const isUploading = totalExpenseCount > 0 || photoCount > 0;

        const banner = document.getElementById('uploadBanner');
        const bannerText = document.getElementById('uploadBannerText');
        const bannerSubtitle = document.getElementById('uploadBannerSubtitle');
        const progressFill = document.getElementById('uploadProgressFill');
        const topNav = document.getElementById('topNav');
        const mainContent = document.getElementById('mainContent');

        const wasUploading = banner && !banner.classList.contains('hidden');

        if (isUploading) {
            if (banner) {
                banner.classList.remove('hidden');
            }
            if (topNav) {
                topNav.style.marginTop = '56px'; // Thinner banner with progress bar
            }
            if (mainContent) {
                mainContent.style.marginTop = '0';
            }
            
            // Update banner text - show expense count
            if (bannerText) {
                if (submissionQueued > 0) {
                    bannerText.textContent = `Uploading ${submissionQueued} Job Expense${submissionQueued === 1 ? '' : 's'}`;
                } else if (totalExpenseCount > 0) {
                    bannerText.textContent = `Uploading ${totalExpenseCount} Job Expense${totalExpenseCount === 1 ? '' : 's'}`;
                } else {
                    bannerText.textContent = 'Uploading expenses...';
                }
            }
            
            // Update subtitle - show what's actually happening
            if (bannerSubtitle) {
                if (photoCount > 0) {
                    bannerSubtitle.textContent = `Uploading ${photoCount} photo${photoCount === 1 ? '' : 's'}...`;
                } else if (submissionQueued > 0) {
                    bannerSubtitle.textContent = 'Saving expenses...';
                } else {
                    bannerSubtitle.textContent = 'Processing...';
                }
            }
            
            // Update progress bar (simplified - shows based on tasks)
            if (progressFill) {
                // Simple progress: if we have tasks, show indeterminate progress
                // In future, can track actual upload progress per task
                progressFill.style.width = '50%'; // Indeterminate progress
            }
        } else {
            this.hideUploadBanner();
            if (typeof window !== 'undefined') {
                window.isUploadingExpense = false;
            }
            if (wasUploading && typeof window.loadExpenseBatches === 'function') {
                setTimeout(async () => {
                    try {
                        await window.loadExpenseBatches();
                    } catch (error) {
                        console.error('[ExpenseUploadQueue] Error refreshing expense list:', error);
                    }
                }, 500);
            }
        }
    }

    hideUploadBanner() {
        const banner = document.getElementById('uploadBanner');
        const progressFill = document.getElementById('uploadProgressFill');
        const topNav = document.getElementById('topNav');
        const mainContent = document.getElementById('mainContent');
        
        if (banner) {
            banner.classList.add('hidden');
        }
        if (progressFill) {
            progressFill.style.width = '0%';
        }
        if (topNav) {
            topNav.style.marginTop = '0';
        }
        if (mainContent) {
            mainContent.style.marginTop = '0';
        }
    }

    /**
     * Get auth token and trigger Service Worker to process queue
     */
    async getAuthTokenAndProcessQueue() {
        if (!navigator.onLine || !('serviceWorker' in navigator)) {
            return;
        }

        try {
            const registration = await navigator.serviceWorker.ready;
            if (!registration.active) {
                console.warn('[ExpenseUploadQueue] Service Worker not active');
                return;
            }

            // Get Firebase Auth token
            let authToken = null;
            try {
                if (window.auth && window.auth.currentUser) {
                    authToken = await window.auth.currentUser.getIdToken();
                    console.log('[ExpenseUploadQueue] Got auth token, triggering Service Worker to process queue');
                } else {
                    console.warn('[ExpenseUploadQueue] No authenticated user');
                    return;
                }
            } catch (tokenError) {
                console.warn('[ExpenseUploadQueue] Failed to get auth token:', tokenError);
                return;
            }

            // Send message to Service Worker to process queue
            const messageChannel = new MessageChannel();
            messageChannel.port1.onmessage = (event) => {
                const { success, result, error } = event.data || {};
                if (success) {
                    console.log('[ExpenseUploadQueue] Service Worker processed queue:', result);
                } else {
                    console.error('[ExpenseUploadQueue] Service Worker queue processing failed:', error);
                }
            };

            registration.active.postMessage(
                { 
                    type: 'process-queue',
                    data: { authToken: authToken }
                },
                [messageChannel.port2]
            );

            // Also update UI status
            await this.updateGlobalUploadStatus();
        } catch (error) {
            console.error('[ExpenseUploadQueue] Failed to trigger Service Worker:', error);
        }
    }

    /**
     * Clean up upload queue entries for a deleted batch
     */
    async cleanupBatchUploads(batchId) {
        await this.init();
        if (!this.db || !batchId) return;

        try {
            // First, get all tasks for this batch (read-only transaction)
            const readTx = this.db.transaction(['expenseUploadQueue'], 'readonly');
            const readStore = readTx.objectStore('expenseUploadQueue');
            const batchIndex = readStore.index('batchId');
            
            const tasks = await new Promise((resolve, reject) => {
                const req = batchIndex.getAll(batchId);
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });

            if (tasks.length === 0) {
                return; // No tasks to clean up
            }

            // Collect all blob IDs to delete
            const blobIdsToDelete = [];
            for (const task of tasks) {
                if (task.photoBlobIds && Array.isArray(task.photoBlobIds)) {
                    for (const photoBlobRef of task.photoBlobIds) {
                        blobIdsToDelete.push(photoBlobRef.blobId);
                    }
                }
            }

            // Delete all tasks in one transaction
            const taskTx = this.db.transaction(['expenseUploadQueue'], 'readwrite');
            const taskStore = taskTx.objectStore('expenseUploadQueue');
            
            await Promise.all(tasks.map(task => {
                return new Promise((resolve, reject) => {
                    const req = taskStore.delete(task.uploadId);
                    req.onsuccess = () => resolve();
                    req.onerror = () => reject(req.error);
                });
            }));

            // Wait for transaction to complete
            await new Promise((resolve, reject) => {
                taskTx.oncomplete = () => resolve();
                taskTx.onerror = () => reject(taskTx.error);
            });

            // Delete all photo blobs in separate transaction(s)
            if (blobIdsToDelete.length > 0) {
                const blobTx = this.db.transaction(['photoBlobs'], 'readwrite');
                const blobStore = blobTx.objectStore('photoBlobs');
                
                await Promise.all(blobIdsToDelete.map(blobId => {
                    return new Promise((resolve, reject) => {
                        const req = blobStore.delete(blobId);
                        req.onsuccess = () => resolve();
                        req.onerror = () => reject(req.error);
                    }).catch(error => {
                        console.warn('[ExpenseUploadQueue] Failed to delete photo blob:', blobId, error);
                        // Don't throw - continue with other deletions
                    });
                }));

                // Wait for blob transaction to complete
                await new Promise((resolve, reject) => {
                    blobTx.oncomplete = () => resolve();
                    blobTx.onerror = () => reject(blobTx.error);
                });
            }

            console.log(`[ExpenseUploadQueue] Cleaned up ${tasks.length} upload tasks for batch ${batchId}`);
            
            // Update banner status
            await this.updateGlobalUploadStatus();
        } catch (error) {
            console.error('[ExpenseUploadQueue] Error cleaning up batch uploads:', error);
            // Don't throw - just log the error so batch deletion can continue
        }
    }

    /**
     * Clear all stuck/failed uploads - useful for testing and recovery
     */
    async clearStuckUploads() {
        await this.init();
        if (!this.db) return { cleared: 0 };

        try {
            const tx = this.db.transaction(['expenseUploadQueue'], 'readwrite');
            const store = tx.objectStore('expenseUploadQueue');
            const statusIndex = store.index('status');
            
            // Get all stuck tasks (uploading for more than 5 minutes, or failed)
            const allTasks = await new Promise((resolve, reject) => {
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });

            const now = Date.now();
            const FIVE_MINUTES = 5 * 60 * 1000;
            let cleared = 0;

            for (const task of allTasks) {
                let shouldDelete = false;
                
                // Delete failed tasks
                if (task.status === 'failed') {
                    shouldDelete = true;
                }
                // Delete tasks stuck in "uploading" for more than 5 minutes
                else if (task.status === 'uploading' && task.updatedAt) {
                    const timeSinceUpdate = now - task.updatedAt;
                    if (timeSinceUpdate > FIVE_MINUTES) {
                        shouldDelete = true;
                    }
                }
                // Delete tasks with too many retries
                else if (task.retries >= 5) {
                    shouldDelete = true;
                }

                if (shouldDelete) {
                    // Delete task
                    await new Promise((resolve, reject) => {
                        const req = store.delete(task.uploadId);
                        req.onsuccess = () => resolve();
                        req.onerror = () => reject(req.error);
                    });

                    // Delete associated photo blobs
                    if (task.photoBlobIds && Array.isArray(task.photoBlobIds)) {
                        const blobTx = this.db.transaction(['photoBlobs'], 'readwrite');
                        const blobStore = blobTx.objectStore('photoBlobs');
                        for (const photoBlobRef of task.photoBlobIds) {
                            try {
                                await new Promise((resolve, reject) => {
                                    const req = blobStore.delete(photoBlobRef.blobId);
                                    req.onsuccess = () => resolve();
                                    req.onerror = () => reject(req.error);
                                });
                            } catch (error) {
                                console.warn('[ExpenseUploadQueue] Failed to delete photo blob:', photoBlobRef.blobId, error);
                            }
                        }
                    }

                    cleared++;
                }
            }

            console.log(`[ExpenseUploadQueue] Cleared ${cleared} stuck/failed upload tasks`);
            
            // Update banner status
            await this.updateGlobalUploadStatus();
            
            return { cleared };
        } catch (error) {
            console.error('[ExpenseUploadQueue] Error clearing stuck uploads:', error);
            throw error;
        }
    }

    /**
     * Reset all "uploading" tasks back to "pending" - useful for recovery
     */
    async resetStuckUploads() {
        await this.init();
        if (!this.db) return { reset: 0 };

        try {
            const tx = this.db.transaction(['expenseUploadQueue'], 'readwrite');
            const store = tx.objectStore('expenseUploadQueue');
            const statusIndex = store.index('status');
            
            // Get all uploading tasks
            const uploadingTasks = await new Promise((resolve, reject) => {
                const req = statusIndex.getAll('uploading');
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });

            let reset = 0;
            for (const task of uploadingTasks) {
                task.status = 'pending';
                task.updatedAt = Date.now();
                await new Promise((resolve, reject) => {
                    const req = store.put(task);
                    req.onsuccess = () => resolve();
                    req.onerror = () => reject(req.error);
                });
                reset++;
            }

            console.log(`[ExpenseUploadQueue] Reset ${reset} stuck uploading tasks to pending`);
            
            // Update banner status
            await this.updateGlobalUploadStatus();
            
            return { reset };
        } catch (error) {
            console.error('[ExpenseUploadQueue] Error resetting stuck uploads:', error);
            throw error;
        }
    }

    /**
     * Clear ALL uploads (nuclear option - use with caution)
     */
    async clearAllUploads() {
        await this.init();
        if (!this.db) return { cleared: 0 };

        try {
            const tx = this.db.transaction(['expenseUploadQueue', 'photoBlobs'], 'readwrite');
            const taskStore = tx.objectStore('expenseUploadQueue');
            const blobStore = tx.objectStore('photoBlobs');
            
            // Get all tasks
            const allTasks = await new Promise((resolve, reject) => {
                const req = taskStore.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });

            let cleared = 0;
            for (const task of allTasks) {
                // Delete task
                await new Promise((resolve, reject) => {
                    const req = taskStore.delete(task.uploadId);
                    req.onsuccess = () => resolve();
                    req.onerror = () => reject(req.error);
                });

                // Delete associated photo blobs
                if (task.photoBlobIds && Array.isArray(task.photoBlobIds)) {
                    for (const photoBlobRef of task.photoBlobIds) {
                        try {
                            await new Promise((resolve, reject) => {
                                const req = blobStore.delete(photoBlobRef.blobId);
                                req.onsuccess = () => resolve();
                                req.onerror = () => reject(req.error);
                            });
                        } catch (error) {
                            console.warn('[ExpenseUploadQueue] Failed to delete photo blob:', photoBlobRef.blobId, error);
                        }
                    }
                }

                cleared++;
            }

            console.log(`[ExpenseUploadQueue] Cleared ALL ${cleared} upload tasks`);
            
            // Update banner status
            await this.updateGlobalUploadStatus();
            
            return { cleared };
        } catch (error) {
            console.error('[ExpenseUploadQueue] Error clearing all uploads:', error);
            throw error;
        }
    }
}

// Wait Time Upload Queue (similar to ExpenseUploadQueue but simpler - no photos)
class WaitTimeUploadQueue {
    constructor() {
        this.db = null;
    }

    async init() {
        if (!window.expenseDraftDB) {
            window.expenseDraftDB = new ExpenseDraftDB();
        }
        await window.expenseDraftDB.init();
        
        // Wait for database to be available
        let retries = 0;
        while (!window.expenseDraftDB.db && retries < 20) {
            await new Promise(resolve => setTimeout(resolve, 50));
            retries++;
        }
        
        if (!window.expenseDraftDB.db) {
            throw new Error('Failed to initialize IndexedDB');
        }
        
        this.db = window.expenseDraftDB.db;
    }

    /**
     * Write-first: Save wait time data to IndexedDB immediately
     * Service Worker will upload to Firestore when online
     */
    async enqueueWaitTimeUpload(waitTimeData, waitTimeDocId = null) {
        await this.init();
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        const uploadId = `waittime_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const timestamp = Date.now();
        const uid = window.currentUser?.uid || null;

        // Create upload task record
        const uploadTask = {
            uploadId: uploadId,
            waitTimeDocId: waitTimeDocId, // Firestore wait time document ID (if already created)
            waitTimeData: waitTimeData, // All wait time values
            uid: uid,
            timestamp: timestamp,
            status: 'pending', // Will be 'pending' -> 'uploading' -> 'completed'
            retries: 0,
            error: null,
            createdAt: timestamp,
            updatedAt: timestamp
        };

        // Save upload task to waitTimeUploadQueue
        const taskTx = this.db.transaction(['waitTimeUploadQueue'], 'readwrite');
        await new Promise((resolve, reject) => {
            const req = taskTx.objectStore('waitTimeUploadQueue').put(uploadTask);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });

        console.log('[WaitTimeUploadQueue] Enqueued wait time upload', { uploadId, waitTimeDocId });
        
        // Update banner immediately
        await this.updateGlobalUploadStatus();
        
        // Trigger service worker to process queue if online
        if (navigator.onLine && 'serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.ready;
                if (registration.active) {
                    // Get Firebase Auth token to pass to Service Worker
                    let authToken = null;
                    try {
                        if (window.auth && window.auth.currentUser) {
                            authToken = await window.auth.currentUser.getIdToken();
                        }
                    } catch (tokenError) {
                        console.warn('[WaitTimeUploadQueue] Failed to get auth token:', tokenError);
                    }
                    
                    registration.active.postMessage({ 
                        type: 'process-wait-time-queue',
                        data: { authToken: authToken }
                    });
                }
            } catch (error) {
                console.warn('[WaitTimeUploadQueue] Failed to notify service worker:', error);
            }
        }

        return uploadId;
    }

    /**
     * Get pending upload count for banner
     */
    async getPendingCount() {
        await this.init();
        if (!this.db) return { waitTimeCount: 0 };

        const tx = this.db.transaction(['waitTimeUploadQueue'], 'readonly');
        const store = tx.objectStore('waitTimeUploadQueue');
        const statusIndex = store.index('status');
        
        const pending = await new Promise((resolve) => {
            const req = statusIndex.count(IDBKeyRange.only('pending'));
            req.onsuccess = () => resolve(req.result || 0);
            req.onerror = () => resolve(0);
        });

        const uploading = await new Promise((resolve) => {
            const req = statusIndex.count(IDBKeyRange.only('uploading'));
            req.onsuccess = () => resolve(req.result || 0);
            req.onerror = () => resolve(0);
        });

        return {
            waitTimeCount: pending + uploading
        };
    }

    /**
     * Update global upload status banner
     */
    async updateGlobalUploadStatus() {
        await this.init();
        if (!this.db) {
            this.hideUploadBanner();
            return;
        }

        // Skip if user is typing
        const activeElement = document.activeElement;
        const isTyping = (typeof window.isUserTyping !== 'undefined' && window.isUserTyping) ||
            (activeElement && (
                activeElement.tagName === 'INPUT' || 
                activeElement.tagName === 'TEXTAREA'
            ));
        
        if (isTyping) {
            return;
        }

        const pendingCounts = await this.getPendingCount();
        const { waitTimeCount } = pendingCounts;
        
        const isUploading = waitTimeCount > 0;

        const banner = document.getElementById('uploadBanner');
        const bannerText = document.getElementById('uploadBannerText');
        const bannerSubtitle = document.getElementById('uploadBannerSubtitle');
        const progressFill = document.getElementById('uploadProgressFill');
        const topNav = document.getElementById('topNav');
        const mainContent = document.getElementById('mainContent');

        const wasUploading = banner && !banner.classList.contains('hidden');

        if (isUploading) {
            if (banner) {
                banner.classList.remove('hidden');
            }
            if (topNav) {
                topNav.style.marginTop = '56px';
            }
            if (mainContent) {
                mainContent.style.marginTop = '0';
            }
            
            // Update banner text
            if (bannerText) {
                if (waitTimeCount > 0) {
                    bannerText.textContent = `Uploading ${waitTimeCount} Wait Time${waitTimeCount === 1 ? '' : 's'}`;
                } else {
                    bannerText.textContent = 'Uploading wait times...';
                }
            }
            
            // Update subtitle
            if (bannerSubtitle) {
                bannerSubtitle.textContent = 'Saving to server...';
            }
            
            // Update progress bar
            if (progressFill) {
                progressFill.style.width = '50%'; // Indeterminate progress
            }
        } else {
            this.hideUploadBanner();
        }
    }

    hideUploadBanner() {
        const banner = document.getElementById('uploadBanner');
        const progressFill = document.getElementById('uploadProgressFill');
        const topNav = document.getElementById('topNav');
        const mainContent = document.getElementById('mainContent');
        
        if (banner) {
            banner.classList.add('hidden');
        }
        if (progressFill) {
            progressFill.style.width = '0%';
        }
        if (topNav) {
            topNav.style.marginTop = '0';
        }
        if (mainContent) {
            mainContent.style.marginTop = '0';
        }
    }

    /**
     * Get auth token and trigger Service Worker to process queue
     */
    async getAuthTokenAndProcessQueue() {
        if (!navigator.onLine || !('serviceWorker' in navigator)) {
            return;
        }

        try {
            const registration = await navigator.serviceWorker.ready;
            if (!registration.active) {
                console.warn('[WaitTimeUploadQueue] Service Worker not active');
                return;
            }

            // Get Firebase Auth token
            let authToken = null;
            try {
                if (window.auth && window.auth.currentUser) {
                    authToken = await window.auth.currentUser.getIdToken();
                    console.log('[WaitTimeUploadQueue] Got auth token, triggering Service Worker to process queue');
                } else {
                    console.warn('[WaitTimeUploadQueue] No authenticated user');
                    return;
                }
            } catch (tokenError) {
                console.warn('[WaitTimeUploadQueue] Failed to get auth token:', tokenError);
                return;
            }

            // Send message to Service Worker to process queue
            registration.active.postMessage(
                { 
                    type: 'process-wait-time-queue',
                    data: { authToken: authToken }
                }
            );

            // Also update UI status
            await this.updateGlobalUploadStatus();
        } catch (error) {
            console.error('[WaitTimeUploadQueue] Failed to trigger Service Worker:', error);
        }
    }
}

// Initialize storage systems
window.expenseDraftDB = new ExpenseDraftDB();
// Old UploadQueue removed - replaced by ExpenseUploadQueue with Service Worker
window.expenseUploadQueue = new ExpenseUploadQueue(); // New write-first system with Service Worker
window.waitTimeUploadQueue = new WaitTimeUploadQueue(); // Wait time upload queue

// Network state monitoring
window.addEventListener('online', async () => {
    console.log('🟢 Network online - Service Worker will process upload queue automatically');
    // Service Worker handles uploads automatically when online - just update status if needed
    if (window.expenseUploadQueue) {
        await window.expenseUploadQueue.getAuthTokenAndProcessQueue();
        await window.expenseUploadQueue.updateGlobalUploadStatus();
    }
});

window.addEventListener('offline', () => {
    console.log('🔴 Network offline - queueing uploads');
});

// Auto-save helper functions
window.autoSaveDraft = async function() {
    if (!window.currentBatch || !window.currentUser) return;
    try {
        // Read notes from textarea before saving
        const notesInput = document.getElementById('notesInput');
        if (notesInput && window.currentBatch) {
            window.currentBatch.notes = notesInput.value.trim() || '';
        }
        
        const batchCopy = JSON.parse(JSON.stringify(window.currentBatch));
        const photos = {};
        if (batchCopy.expenses) {
            for (let i = 0; i < batchCopy.expenses.length; i++) {
                const expense = batchCopy.expenses[i];
                if (expense.photos && Array.isArray(expense.photos)) {
                    photos[i] = expense.photos.filter(p => p instanceof File || p instanceof Blob);
                }
            }
        }
        const localId = await window.expenseDraftDB.saveDraft(batchCopy, photos);
        if (window.currentBatch) {
            window.currentBatch.localId = localId;
        }
        console.log('💾 Draft auto-saved to IndexedDB', { notes: batchCopy.notes || '(no notes)' });
    } catch (error) {
        console.error('Error auto-saving draft:', error);
    }
};

// Auto-save on changes (debounced)
let autoSaveTimeout;
window.scheduleAutoSave = function() {
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => {
        // Only auto-save if user is not actively typing (prevents keyboard from closing)
        const isTyping = (typeof window.isUserTyping !== 'undefined' && window.isUserTyping) ||
            (document.activeElement && (
                document.activeElement.tagName === 'INPUT' || 
                document.activeElement.tagName === 'TEXTAREA'
            ));
        if (!isTyping && window.autoSaveDraft) {
            window.autoSaveDraft();
        }
    }, 3000); // Increased delay to 3 seconds to avoid interfering with typing
};

// Helper functions for clearing stuck uploads (accessible from browser console)
window.clearStuckUploads = async function() {
    if (window.expenseUploadQueue) {
        try {
            const result = await window.expenseUploadQueue.clearStuckUploads();
            console.log(`✅ Cleared ${result.cleared} stuck/failed upload tasks`);
            alert(`Cleared ${result.cleared} stuck upload tasks. The banner should update shortly.`);
            return result;
        } catch (error) {
            console.error('❌ Failed to clear stuck uploads:', error);
            alert('Failed to clear stuck uploads: ' + error.message);
            throw error;
        }
    } else {
        console.warn('expenseUploadQueue not available');
        alert('Upload queue not available. Please refresh the page.');
    }
};

window.resetStuckUploads = async function() {
    if (window.expenseUploadQueue) {
        try {
            const result = await window.expenseUploadQueue.resetStuckUploads();
            console.log(`✅ Reset ${result.reset} stuck uploading tasks to pending`);
            alert(`Reset ${result.reset} stuck uploads. They will retry automatically.`);
            return result;
        } catch (error) {
            console.error('❌ Failed to reset stuck uploads:', error);
            alert('Failed to reset stuck uploads: ' + error.message);
            throw error;
        }
    } else {
        console.warn('expenseUploadQueue not available');
        alert('Upload queue not available. Please refresh the page.');
    }
};

window.clearAllUploads = async function() {
    if (window.expenseUploadQueue) {
        const confirmed = confirm('⚠️ WARNING: This will delete ALL pending uploads and their photo data. This cannot be undone. Are you sure?');
        if (!confirmed) {
            console.log('Clear all uploads cancelled');
            return;
        }
        
        try {
            const result = await window.expenseUploadQueue.clearAllUploads();
            console.log(`✅ Cleared ALL ${result.cleared} upload tasks`);
            alert(`Cleared ALL ${result.cleared} upload tasks. The banner should disappear.`);
            return result;
        } catch (error) {
            console.error('❌ Failed to clear all uploads:', error);
            alert('Failed to clear all uploads: ' + error.message);
            throw error;
        }
    } else {
        console.warn('expenseUploadQueue not available');
        alert('Upload queue not available. Please refresh the page.');
    }
};

// Legacy function for old UploadQueue (now redirects to new system)
window.clearUploadQueue = async function() {
    console.warn('clearUploadQueue() is deprecated. Use clearStuckUploads() or clearAllUploads() instead.');
    return window.clearStuckUploads();
};
