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
            };
        });
    }

    async saveDraft(batch, photos) {
        if (!this.db) await this.init();
        const transaction = this.db.transaction(['batches', 'photos'], 'readwrite');
        if (!batch.localId) {
            batch.localId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        batch.lastSaved = Date.now();
        await transaction.objectStore('batches').put(batch);
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
            photoFile: uploadTask.photoFile, filename: uploadTask.filename,
            status: 'pending', retries: 0, error: null, createdAt: Date.now()
        };
        const transaction = this.db.transaction(['uploadQueue'], 'readwrite');
        await transaction.objectStore('uploadQueue').put(task);
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
            const transaction = this.db.transaction(['uploadQueue'], 'readwrite');
            const store = transaction.objectStore('uploadQueue');
            const statusIndex = store.index('status');
            const request = statusIndex.openCursor(IDBKeyRange.only('pending'));
            request.onsuccess = async (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const task = cursor.value;
                    console.debug('[UploadQueue] Processing task', task.uploadId, task.filename);
                    if (task.retries >= this.maxRetries) {
                        console.warn('[UploadQueue] Task exceeded max retries, marking failed', task.uploadId);
                        await this.markFailed(task.uploadId, 'Max retries exceeded');
                        cursor.continue();
                        return;
                    }
                    task.status = 'uploading';
                    await cursor.update(task);
                    try {
                        await this.uploadPhoto(task);
                        console.debug('[UploadQueue] Upload succeeded', task.uploadId);
                        task.status = 'completed';
                        task.completedAt = Date.now();
                        await cursor.update(task);
                        await cursor.delete();
                        this.updateUploadStatus(task.batchId, task.expenseIndex);
                        await this.updateGlobalUploadStatus();
                    } catch (error) {
                        console.error('[UploadQueue] Upload failed', task.uploadId, error);
                        task.retries++;
                        task.status = 'pending';
                        task.error = error.message;
                        task.lastRetryAt = Date.now();
                        await cursor.update(task);
                        this.updateUploadStatus(task.batchId, task.expenseIndex);
                        await this.updateGlobalUploadStatus();
                    }
                    cursor.continue();
                } else {
                    this.isProcessing = false;
                    await this.updateGlobalUploadStatus();
                }
            };
            request.onerror = (error) => {
                console.error('[UploadQueue] Cursor error', error);
                this.isProcessing = false;
            };
        } catch (error) {
            console.error('Error processing queue:', error);
            this.isProcessing = false;
        }
    }

    async uploadPhoto(task) {
        const photoRef = window.ref(window.storage, task.filename);
        const blob = task.photoFile instanceof File ? task.photoFile : task.photoFile;
        await window.uploadBytes(photoRef, blob);
        const downloadURL = await window.getDownloadURL(photoRef);
        await this.updateExpensePhotoUrl(task, downloadURL);
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
                    return;
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
                    return;
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

            if (window.currentBatch && window.currentBatch.id === batchId && window.currentBatch.expenses && window.currentBatch.expenses[expenseIndex]) {
                const localExpense = window.currentBatch.expenses[expenseIndex];
                if (!Array.isArray(localExpense.photos)) {
                    localExpense.photos = [];
                }
                localExpense.photos[photoIndex] = downloadURL;
            }
        } catch (error) {
            console.error('Error updating expense photo URL:', error);
            throw error;
        }
    }

    async markFailed(uploadId, error) {
        await this.init();
        const transaction = this.db.transaction(['uploadQueue'], 'readwrite');
        const store = transaction.objectStore('uploadQueue');
        const task = await store.get(uploadId);
        if (task) {
            task.status = 'failed';
            task.error = error;
            await store.put(task);
        }
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
                if (text) text.textContent = uploading > 0 ? `Uploading ${uploading}...` : `${pending} pending`;
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
