/**
 * Offline Storage & Upload Queue System for Expenses
 * Handles IndexedDB storage and smart photo upload queue
 */

// IndexedDB wrapper for expense drafts
class ExpenseDraftDB {
    constructor() {
        this.dbName = 'ExpenseDraftsDB';
        this.version = 1;
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
        return new Promise((resolve, reject) => {
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
            };
        });
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
        const transaction = this.db.transaction(['photos'], 'readwrite');
        await transaction.objectStore('photos').put({
            photoId: `${localId}_exp${expenseIndex}_photo${photoIndex}`,
            expenseKey: `${localId}_exp${expenseIndex}`,
            batchLocalId: localId,
            blob,
            timestamp: Date.now()
        });
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
                    for (const record of photoRecords) {
                        photos[expIndex].push(record.blob);
                    }
                }
            }
        }
        if (batch.expenses) {
            for (let expIndex = 0; expIndex < batch.expenses.length; expIndex++) {
                if (photos[expIndex]) {
                    batch.expenses[expIndex].photos = photos[expIndex];
                }
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
    }

    async init() {
        if (navigator.storage && navigator.storage.persist) {
            try {
                const alreadyGranted = localStorage.getItem('expense_persisted') === 'true';
                const isPersisted = await navigator.storage.persisted();
                if (!alreadyGranted && !isPersisted) {
                    const granted = await navigator.storage.persist();
                    if (granted) {
                        localStorage.setItem('expense_persisted', 'true');
                    } else {
                        console.warn('[UploadQueue] Persistent storage request was denied. Receipts may not upload when the page is backgrounded.');
                        if (document.activeElement && document.activeElement.blur) {
                            document.activeElement.blur();
                        }
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
                await window.expenseDraftDB.savePhotoBlob(uploadTask.batchLocalId || uploadTask.batchId, uploadTask.expenseIndex, uploadTask.photoIndex, uploadTask.photoFile);
            } catch (error) {
                console.warn('[UploadQueue] Failed to cache photo blob', error);
            }
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

            for (const task of tasksToProcess) {
                if (task.status === 'uploading') {
                    // Reset stuck uploads back to pending
                    task.status = 'pending';
                    await this.saveTask(task);
                }

                console.debug('[UploadQueue] Processing task', task.uploadId, task.filename);

                if (task.retries >= this.maxRetries) {
                    console.warn('[UploadQueue] Task exceeded max retries, removing', task.uploadId);
                    await this.deleteTask(task.uploadId);
                    await window.expenseDraftDB.deletePhotoBlob(task.batchLocalId || task.batchId, task.expenseIndex, task.photoIndex);
                    continue;
                }

                try {
                    await this.uploadPhoto(task);
                    console.debug('[UploadQueue] Upload succeeded', task.uploadId);
                    await this.deleteTask(task.uploadId);
                    await window.expenseDraftDB.deletePhotoBlob(task.batchLocalId || task.batchId, task.expenseIndex, task.photoIndex);
                } catch (error) {
                    if (error && error.code === 'EXPENSE_DOC_MISSING') {
                        console.warn('[UploadQueue] Expense document missing, dropping task', task.uploadId);
                        await this.deleteTask(task.uploadId);
                        await window.expenseDraftDB.deletePhotoBlob(task.batchLocalId || task.batchId, task.expenseIndex, task.photoIndex);
                    } else if (error && error.code === 'PHOTO_BLOB_MISSING') {
                        console.warn('[UploadQueue] Cached photo missing, dropping task', task.uploadId);
                        await this.deleteTask(task.uploadId);
                    } else {
                        console.error('[UploadQueue] Upload failed', task.uploadId, error);
                        task.retries++;
                        task.status = 'pending';
                        task.error = error.message;
                        task.lastRetryAt = Date.now();
                        await this.saveTask(task);
                    }
                }

                await this.updateGlobalUploadStatus();
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

            await window.updateDoc(expenseDocRef, {
                photos: expenseData.photos,
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
            const indicator = document.getElementById('uploadStatusIndicator');
            if (indicator) indicator.classList.add('hidden');
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
        console.debug('[UploadQueue] status counts', {pending, uploading, failed});
        const indicator = document.getElementById('uploadStatusIndicator');
        if (indicator) {
            const icon = indicator.querySelector('.material-symbols-outlined');
            const text = indicator.querySelector('span:last-child');
            if (pending > 0 || uploading > 0) {
                 indicator.classList.remove('hidden', 'bg-red-600', 'hover:bg-red-700');
                 indicator.classList.add('bg-blue-600', 'hover:bg-blue-700');
                 if (icon) {
                     icon.textContent = 'cloud_upload';
                     icon.classList.add('animate-pulse');
                 }
                if (text) {
                    const parts = [];
                    if (submissionQueued > 0) {
                        parts.push(`Uploading ${submissionQueued} expense${submissionQueued === 1 ? '' : 's'}...`);
                    }
                    if (uploading > 0) {
                        parts.push(`${uploading} photo${uploading === 1 ? '' : 's'} in progress`);
                    } else if (pending > 0) {
                        parts.push(`${pending} photo${pending === 1 ? '' : 's'} pending`);
                    }
                    if (parts.length === 0) {
                        parts.push('Uploading...');
                    }
                    text.classList.remove('text-red-100');
                    text.textContent = parts.join(' · ');
                }
            } else if (submissionQueued > 0) {
                indicator.classList.remove('hidden', 'bg-red-600', 'hover:bg-red-700');
                indicator.classList.add('bg-blue-600', 'hover:bg-blue-700');
                if (icon) {
                    icon.textContent = 'cloud_upload';
                    icon.classList.add('animate-pulse');
                }
                if (text) {
                    text.classList.remove('text-red-100');
                    text.textContent = `Uploading ${submissionQueued} expense${submissionQueued === 1 ? '' : 's'}...`;
                }
            } else if (failed > 0) {
                indicator.classList.remove('hidden', 'bg-blue-600', 'hover:bg-blue-700');
                indicator.classList.add('bg-red-600', 'hover:bg-red-700');
                if (icon) {
                    icon.textContent = 'error';
                    icon.classList.remove('animate-pulse');
                }
                if (text) {
                    text.textContent = `${failed} failed`;
                    text.classList.add('text-red-100');
                }
            } else {
                indicator.classList.add('hidden');
            }
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

// Initialize storage systems
window.expenseDraftDB = new ExpenseDraftDB();
window.uploadQueue = new UploadQueue();

// Network state monitoring
window.addEventListener('online', async () => {
    console.log('🟢 Network online - processing upload queue');
    if (window.uploadQueue) {
        await window.uploadQueue.processQueue();
        await window.uploadQueue.updateGlobalUploadStatus();
    }
});

window.addEventListener('offline', () => {
    console.log('🔴 Network offline - queueing uploads');
});

// Auto-save helper functions
window.autoSaveDraft = async function() {
    if (!window.currentBatch || !window.currentUser) return;
    try {
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
        console.log('💾 Draft auto-saved to IndexedDB');
    } catch (error) {
        console.error('Error auto-saving draft:', error);
    }
};

// Auto-save on changes (debounced)
let autoSaveTimeout;
window.scheduleAutoSave = function() {
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => {
        if (window.autoSaveDraft) window.autoSaveDraft();
    }, 2000);
};

window.clearUploadQueue = async function() {
    if (window.uploadQueue) {
        try {
            await window.uploadQueue.clearAll();
            console.log('[UploadQueue] Cleared all queued uploads');
        } catch (error) {
            console.error('[UploadQueue] Failed to clear queue', error);
        }
    }
};
