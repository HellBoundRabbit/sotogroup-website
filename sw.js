/**
 * Service Worker for Expense Photo Upload Queue
 * Handles background uploads to Firebase Storage using fetch API
 * Works offline-first: uploads resume when connection is restored
 */

const CACHE_NAME = 'expense-upload-v1';
const STORAGE_BUCKET = 'soto-routes.firebasestorage.app';
const DB_NAME = 'ExpenseDraftsDB';
const DB_VERSION = 2; // Match the version in expense-offline-storage.js

// Firebase Storage REST API helper
function getStorageUploadUrl(path) {
  const encodedPath = encodeURIComponent(path);
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o?name=${encodedPath}&uploadType=multipart`;
}

function getStorageDownloadUrl(path) {
  const encodedPath = encodeURIComponent(path);
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodedPath}?alt=media`;
}

// Get Firebase Auth token from IndexedDB (stored by main thread)
async function getAuthToken() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onsuccess = () => {
      const db = request.result;
      // Auth tokens are stored in a separate store
      // For now, we'll request it from main thread via postMessage
      // Main thread will send it when available
      resolve(null);
    };
    request.onerror = () => reject(request.error);
  });
}

// Upload photo blob to Firebase Storage using fetch
async function uploadPhotoBlob(blob, path, authToken) {
  if (!authToken) {
    throw new Error('Auth token required for upload');
  }

  const metadata = JSON.stringify({
    contentType: 'image/jpeg'
  });
  
  // Create multipart form data - Firebase Storage REST API format
  const formData = new FormData();
  formData.append('metadata', new Blob([metadata], { type: 'application/json' }));
  formData.append('file', blob);

  const uploadUrl = getStorageUploadUrl(path);
  
  try {
    // Don't set Content-Type header - FormData sets it automatically with boundary
    const headers = {
      'Authorization': `Bearer ${authToken}`
    };

    console.log('[SW] Starting upload:', { path, size: blob.size, authToken: authToken.substring(0, 20) + '...' });

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: headers,
      body: formData,
      keepalive: true // Important for background uploads
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SW] Upload failed:', response.status, errorText);
      throw new Error(`Upload failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    const downloadURL = getStorageDownloadUrl(result.name);
    console.log('[SW] Upload successful:', downloadURL);
    return downloadURL;
  } catch (error) {
    console.error('[SW] Upload error:', error);
    throw error;
  }
}

// Process upload queue
async function processUploadQueue(authToken) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onsuccess = async () => {
      const db = request.result;
      
      try {
        // Reset any tasks stuck in "uploading" state for more than 5 minutes
        const resetTx = db.transaction(['expenseUploadQueue'], 'readwrite');
        const resetStore = resetTx.objectStore('expenseUploadQueue');
        const resetStatusIndex = resetStore.index('status');
        const stuckRequest = resetStatusIndex.getAll('uploading');
        
        const stuckTasks = await new Promise((res, rej) => {
          stuckRequest.onsuccess = () => res(stuckRequest.result || []);
          stuckRequest.onerror = () => rej(stuckRequest.error);
        });

        const now = Date.now();
        const FIVE_MINUTES = 5 * 60 * 1000;
        for (const stuckTask of stuckTasks) {
          if (stuckTask.updatedAt && (now - stuckTask.updatedAt) > FIVE_MINUTES) {
            // Reset stuck task back to pending
            stuckTask.status = 'pending';
            stuckTask.updatedAt = now;
            await new Promise((res, rej) => {
              const req = resetStore.put(stuckTask);
              req.onsuccess = () => res();
              req.onerror = () => rej(req.error);
            });
            console.log(`[SW] Reset stuck upload task: ${stuckTask.uploadId}`);
          }
        }

        // Get all pending upload tasks
        const transaction = db.transaction(['expenseUploadQueue'], 'readonly');
        const store = transaction.objectStore('expenseUploadQueue');
        const statusIndex = store.index('status');
        const pendingRequest = statusIndex.getAll('pending');
        
        const tasks = await new Promise((res, rej) => {
          pendingRequest.onsuccess = () => res(pendingRequest.result || []);
          pendingRequest.onerror = () => rej(pendingRequest.error);
        });

        if (tasks.length === 0) {
          resolve({ processed: 0, failed: 0 });
          return;
        }

        let processed = 0;
        let failed = 0;

        // Process tasks one at a time (each task can have multiple photos)
        for (const task of tasks) {
          try {
            // Mark as uploading
            const updateTx = db.transaction(['expenseUploadQueue'], 'readwrite');
            const updateStore = updateTx.objectStore('expenseUploadQueue');
            task.status = 'uploading';
            task.updatedAt = Date.now();
            await new Promise((res, rej) => {
              const req = updateStore.put(task);
              req.onsuccess = () => res();
              req.onerror = () => rej(req.error);
            });

            // Process all photos for this expense task
            const photoBlobIds = task.photoBlobIds || [];
            const uploadedURLs = [];
            
            for (const photoBlobRef of photoBlobIds) {
              const { blobId, filename } = photoBlobRef;
              
              // Get photo blob from photoBlobs store
              const blobTx = db.transaction(['photoBlobs'], 'readonly');
              const blobStore = blobTx.objectStore('photoBlobs');
              const blobRecord = await new Promise((res, rej) => {
                const req = blobStore.get(blobId);
                req.onsuccess = () => res(req.result);
                req.onerror = () => rej(req.error);
              });

              if (!blobRecord || !blobRecord.blob) {
                console.warn(`[SW] Photo blob not found: ${blobId}`);
                continue;
              }

              // Upload photo
              const downloadURL = await uploadPhotoBlob(blobRecord.blob, filename, authToken);
              uploadedURLs.push(downloadURL);
              console.log(`[SW] Uploaded photo: ${filename} -> ${downloadURL}`);
            }

            // Update task as completed
            const completeTx = db.transaction(['expenseUploadQueue'], 'readwrite');
            const completeStore = completeTx.objectStore('expenseUploadQueue');
            task.status = 'completed';
            task.downloadURLs = uploadedURLs; // Store all uploaded URLs
            task.completedAt = Date.now();
            task.updatedAt = Date.now();
            
            await new Promise((res, rej) => {
              const req = completeStore.put(task);
              req.onsuccess = () => res();
              req.onerror = () => rej(req.error);
            });

            // Notify main thread via BroadcastChannel to update Firestore
            if (self.BroadcastChannel) {
              const channel = new BroadcastChannel('expense-upload-channel');
              channel.postMessage({
                type: 'upload-complete',
                uploadId: task.uploadId,
                expenseDocId: task.expenseDocId,
                downloadURLs: uploadedURLs,
                task: task
              });
              channel.close();
            }

            processed++;
          } catch (error) {
            console.error('[SW] Upload task failed:', error);
            
            // Update task with error
            const errorTx = db.transaction(['expenseUploadQueue'], 'readwrite');
            const errorStore = errorTx.objectStore('expenseUploadQueue');
            task.status = 'pending'; // Retry next time
            task.retries = (task.retries || 0) + 1;
            task.lastError = error.message;
            task.updatedAt = Date.now();
            
            // Max retries - mark as failed after 5 attempts
            if (task.retries >= 5) {
              task.status = 'failed';
            }
            
            await new Promise((res, rej) => {
              const req = errorStore.put(task);
              req.onsuccess = () => res();
              req.onerror = () => rej(req.error);
            });

            failed++;
          }
        }

        resolve({ processed, failed, total: tasks.length });
      } catch (error) {
        reject(error);
      }
    };

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      // Database upgrade handled by main thread
      const db = request.result;
      if (!db.objectStoreNames.contains('expenseUploadQueue')) {
        const expenseUploadStore = db.createObjectStore('expenseUploadQueue', { keyPath: 'uploadId' });
        expenseUploadStore.createIndex('batchId', 'batchId', { unique: false });
        expenseUploadStore.createIndex('status', 'status', { unique: false });
        expenseUploadStore.createIndex('expenseDocId', 'expenseDocId', { unique: false });
      }
      resolve({ processed: 0, failed: 0 });
    };
  });
}

// Request auth token from any active client
async function requestAuthToken() {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    if (clients.length === 0) {
      return null;
    }
    
    // Request token from first available client
    const client = clients[0];
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        const { authToken } = event.data || {};
        resolve(authToken || null);
      };
      
      // Request token with timeout
      client.postMessage({ type: 'get-auth-token' }, [channel.port2]);
      
      // Timeout after 2 seconds
      setTimeout(() => resolve(null), 2000);
    });
  } catch (error) {
    console.warn('[SW] Error requesting auth token:', error);
    return null;
  }
}

// Periodic queue processing (runs when online)
async function checkAndProcessQueue() {
  if (!self.navigator || !self.navigator.onLine) {
    return;
  }

  try {
    // Request auth token from active client
    const authToken = await requestAuthToken();
    if (!authToken) {
      console.log('[SW] No auth token available, skipping upload processing');
      return;
    }
    
    const result = await processUploadQueue(authToken);
    console.log('[SW] Queue processed:', result);
    
    // Notify all clients about upload status change
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    clients.forEach(client => {
      client.postMessage({ type: 'upload-status-changed', result });
    });
  } catch (error) {
    console.error('[SW] Error processing queue:', error);
  }
}

// Listen for messages from main thread
self.addEventListener('message', async (event) => {
  const { type, data } = event.data || {};

  if (type === 'process-queue') {
    const authToken = data?.authToken || null;
    try {
      const result = await processUploadQueue(authToken || await requestAuthToken());
      event.ports[0]?.postMessage({ success: true, result });
    } catch (error) {
      event.ports[0]?.postMessage({ success: false, error: error.message });
    }
  } else if (type === 'get-auth-token') {
    // Client is responding with auth token
    // This is handled via MessageChannel in requestAuthToken
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ authToken: data?.authToken || null });
    }
  } else if (type === 'get-status') {
    // Return queue status
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = async () => {
        const db = request.result;
        const transaction = db.transaction(['expenseUploadQueue'], 'readonly');
        const store = transaction.objectStore('expenseUploadQueue');
        const statusIndex = store.index('status');
        
        const [pending, uploading, completed] = await Promise.all([
          new Promise(r => {
            const req = statusIndex.count(IDBKeyRange.only('pending'));
            req.onsuccess = () => r(req.result || 0);
            req.onerror = () => r(0);
          }),
          new Promise(r => {
            const req = statusIndex.count(IDBKeyRange.only('uploading'));
            req.onsuccess = () => r(req.result || 0);
            req.onerror = () => r(0);
          }),
          new Promise(r => {
            const req = statusIndex.count(IDBKeyRange.only('completed'));
            req.onsuccess = () => r(req.result || 0);
            req.onerror = () => r(0);
          })
        ]);

        event.ports[0]?.postMessage({
          success: true,
          status: { pending, uploading, completed, total: pending + uploading }
        });
      };
    } catch (error) {
      event.ports[0]?.postMessage({ success: false, error: error.message });
    }
  }
});

// Periodic processing (every 30 seconds when online)
let processingInterval = null;

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients.claim().then(() => {
      // Clear old interval
      if (processingInterval) {
        clearInterval(processingInterval);
      }
      
      // Start periodic processing
      processingInterval = setInterval(() => {
        if (self.navigator.onLine) {
          checkAndProcessQueue();
        }
      }, 30000); // Every 30 seconds
      
      // Process immediately
      checkAndProcessQueue();
    })
  );
});

// Process queue when coming back online
self.addEventListener('online', () => {
  console.log('[SW] Network online - processing upload queue');
  checkAndProcessQueue();
});

// Install event
self.addEventListener('install', (event) => {
  self.skipWaiting(); // Activate immediately
});

