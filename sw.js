/**
 * Service Worker for Expense Photo Upload Queue
 * Handles background uploads to Firebase Storage using fetch API
 * Works offline-first: uploads resume when connection is restored
 */

const CACHE_NAME = 'expense-upload-v1';
const STORAGE_BUCKET = 'soto-routes.firebasestorage.app';
const DB_NAME = 'ExpenseDraftsDB';
const DB_VERSION = 3; // Match the version in expense-offline-storage.js (includes waitTimeUploadQueue)

// Firebase Storage REST API helper
function getStorageUploadUrl(path, uploadType = 'multipart') {
  // For Firebase Storage REST API v0, use the bucket ID (without .firebasestorage.app)
  // But try full bucket name if ID doesn't work
  const bucketId = 'soto-routes'; // Bucket ID, not full domain
  const encodedPath = encodeURIComponent(path);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketId}/o?name=${encodedPath}&uploadType=${uploadType}`;
}

function getStorageDownloadUrl(path) {
  const bucketId = 'soto-routes';
  const encodedPath = encodeURIComponent(path);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketId}/o/${encodedPath}?alt=media`;
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

// Request main thread to upload photo using Firebase SDK
// Service Workers can't use Firebase SDK, so we delegate to the main thread
async function requestMainThreadUpload(blob, path, expenseDocId) {
  return new Promise((resolve, reject) => {
    const messageChannel = new MessageChannel();
    
    messageChannel.port1.onmessage = (event) => {
      const { success, downloadURL, error } = event.data;
      if (success && downloadURL) {
        resolve(downloadURL);
      } else {
        reject(new Error(error || 'Upload failed'));
      }
      messageChannel.port1.close();
    };

    // Send upload request to main thread
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
      if (clients.length === 0) {
        reject(new Error('No client windows available for upload'));
        return;
      }

      const uploadRequest = {
        type: 'upload-photo-request',
        blob: blob,
        path: path,
        expenseDocId: expenseDocId
      };

      clients[0].postMessage(uploadRequest, [messageChannel.port2]);
      
      // Timeout after 60 seconds
      setTimeout(() => {
        messageChannel.port1.close();
        reject(new Error('Upload request timeout'));
      }, 60000);
    }).catch(reject);
  });
}

// Upload photo blob to Firebase Storage using fetch (DEPRECATED - doesn't work in SW)
async function uploadPhotoBlob(blob, path, authToken) {
  if (!authToken) {
    throw new Error('Auth token required for upload');
  }

  // Try using FormData first (should work in Service Workers)
  try {
    const metadata = JSON.stringify({
      contentType: 'image/jpeg'
    });
    
    const formData = new FormData();
    formData.append('metadata', new Blob([metadata], { type: 'application/json' }));
    formData.append('file', blob, path.split('/').pop());

    const uploadUrl = getStorageUploadUrl(path, 'multipart');
    
    const headers = {
      'Authorization': `Bearer ${authToken}`
      // Don't set Content-Type - FormData sets it with boundary automatically
    };

    console.log('[SW] Starting upload (FormData):', { path, size: blob.size, url: uploadUrl });

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: headers,
      body: formData,
      keepalive: true
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SW] Upload failed (FormData):', response.status, response.statusText, errorText);
      throw new Error(`Upload failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    const downloadURL = getStorageDownloadUrl(result.name);
    console.log('[SW] Upload successful (FormData):', downloadURL);
    return downloadURL;
  } catch (error) {
    // If FormData fails, try simple media upload
    if (error.message.includes('Failed to fetch') || error.name === 'TypeError') {
      console.warn('[SW] FormData upload failed, trying media upload:', error.message);
      return await uploadPhotoBlobMedia(blob, path, authToken);
    }
    throw error;
  }
}

// Fallback: Simple media upload (no metadata, just the file)
async function uploadPhotoBlobMedia(blob, path, authToken) {
  const uploadUrl = getStorageUploadUrl(path, 'media');
  
  const headers = {
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'image/jpeg'
  };

  console.log('[SW] Starting upload (media):', { path, size: blob.size, url: uploadUrl });

  try {
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: headers,
      body: blob,
      keepalive: true
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SW] Upload failed (media):', response.status, response.statusText, errorText);
      throw new Error(`Upload failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    const downloadURL = getStorageDownloadUrl(result.name);
    console.log('[SW] Upload successful (media):', downloadURL);
    return downloadURL;
  } catch (error) {
    console.error('[SW] Upload error (media):', error);
    // Add more detailed error info
    if (error.message.includes('Failed to fetch')) {
      console.error('[SW] Network/CORS error detected. Check:', {
        url: uploadUrl,
        hasAuthToken: !!authToken,
        blobSize: blob.size,
        error: error.message
      });
    }
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

            // Process all photos for this expense task IN PARALLEL
            const photoBlobIds = task.photoBlobIds || [];
            
            // Upload all photos in parallel instead of sequentially
            const uploadPromises = photoBlobIds.map(async (photoBlobRef) => {
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
                return null;
              }

              // Request main thread to upload using Firebase SDK
              // Service Workers can't use Firebase SDK, so we delegate to main thread
              try {
                const downloadURL = await requestMainThreadUpload(blobRecord.blob, filename, task.expenseDocId);
                console.log(`[SW] Photo uploaded via main thread: ${filename} -> ${downloadURL}`);
                return downloadURL;
              } catch (error) {
                console.error(`[SW] Failed to upload via main thread: ${filename}`, error);
                throw error; // Re-throw to trigger retry
              }
            });
            
            // Wait for all photos to upload in parallel
            const uploadedURLs = (await Promise.all(uploadPromises)).filter(url => url !== null);

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
      if (!db.objectStoreNames.contains('waitTimeUploadQueue')) {
        const waitTimeUploadStore = db.createObjectStore('waitTimeUploadQueue', { keyPath: 'uploadId' });
        waitTimeUploadStore.createIndex('status', 'status', { unique: false });
        waitTimeUploadStore.createIndex('waitTimeDocId', 'waitTimeDocId', { unique: false });
      }
      resolve({ processed: 0, failed: 0 });
    };
  });
}

// Process wait time upload queue
async function processWaitTimeQueue(authToken) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onsuccess = async () => {
      const db = request.result;
      
      try {
        // Reset any tasks stuck in "uploading" state for more than 5 minutes
        const resetTx = db.transaction(['waitTimeUploadQueue'], 'readwrite');
        const resetStore = resetTx.objectStore('waitTimeUploadQueue');
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
            console.log(`[SW] Reset stuck wait time upload task: ${stuckTask.uploadId}`);
          }
        }

        // Get all pending upload tasks
        const transaction = db.transaction(['waitTimeUploadQueue'], 'readonly');
        const store = transaction.objectStore('waitTimeUploadQueue');
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

        // Process tasks one at a time
        for (const task of tasks) {
          try {
            // Mark as uploading
            const updateTx = db.transaction(['waitTimeUploadQueue'], 'readwrite');
            const updateStore = updateTx.objectStore('waitTimeUploadQueue');
            task.status = 'uploading';
            task.updatedAt = Date.now();
            await new Promise((res, rej) => {
              const req = updateStore.put(task);
              req.onsuccess = () => res();
              req.onerror = () => rej(req.error);
            });

            // Use Firebase REST API to create/update wait time document
            const waitTimeData = task.waitTimeData;
            const firestoreUrl = task.waitTimeDocId
              ? `https://firestore.googleapis.com/v1/projects/soto-routes/databases/(default)/documents/waitTimes/${task.waitTimeDocId}`
              : `https://firestore.googleapis.com/v1/projects/soto-routes/databases/(default)/documents/waitTimes`;

            // Handle createdAt - could be number (timestamp), Date object, or Firestore timestamp
            let createdAtValue;
            if (waitTimeData.createdAt) {
              if (typeof waitTimeData.createdAt === 'number') {
                createdAtValue = new Date(waitTimeData.createdAt).toISOString();
              } else if (waitTimeData.createdAt.toDate && typeof waitTimeData.createdAt.toDate === 'function') {
                // Firestore timestamp object
                createdAtValue = waitTimeData.createdAt.toDate().toISOString();
              } else if (waitTimeData.createdAt instanceof Date) {
                createdAtValue = waitTimeData.createdAt.toISOString();
              } else if (typeof waitTimeData.createdAt === 'string') {
                createdAtValue = new Date(waitTimeData.createdAt).toISOString();
              } else {
                createdAtValue = new Date().toISOString();
              }
            } else {
              createdAtValue = new Date().toISOString();
            }

            const firestoreFields = {
              driverId: { stringValue: waitTimeData.driverId || '' },
              driverEmail: { stringValue: waitTimeData.driverEmail || '' },
              driverName: { stringValue: waitTimeData.driverName || '' },
              officeId: { stringValue: waitTimeData.officeId || '' },
              registration: { stringValue: waitTimeData.registration || '' },
              category: { stringValue: waitTimeData.category || '' },
              categoryLabel: { stringValue: waitTimeData.categoryLabel || '' },
              hours: { integerValue: String(waitTimeData.hours || 0) },
              minutes: { integerValue: String(waitTimeData.minutes || 0) },
              totalMinutes: { integerValue: String(waitTimeData.totalMinutes || 0) },
              delayStartTime: { stringValue: waitTimeData.delayStartTime || '' },
              delayEndTime: { stringValue: waitTimeData.delayEndTime || '' },
              notes: { stringValue: waitTimeData.notes || '' },
              processingStatus: { stringValue: waitTimeData.processingStatus || 'pending' },
              createdAt: { timestampValue: createdAtValue },
              updatedAt: { timestampValue: new Date().toISOString() }
            };

            // Add optional fields if they exist
            if (waitTimeData.firstName) {
              firestoreFields.firstName = { stringValue: waitTimeData.firstName };
            }
            if (waitTimeData.lastName) {
              firestoreFields.lastName = { stringValue: waitTimeData.lastName };
            }

            const response = await fetch(firestoreUrl, {
              method: task.waitTimeDocId ? 'PATCH' : 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
              },
              body: JSON.stringify({
                fields: firestoreFields
              })
            });

            if (!response.ok) {
              throw new Error(`Firestore API error: ${response.status} ${response.statusText}`);
            }

            const firestoreDoc = await response.json();
            const waitTimeDocId = task.waitTimeDocId || firestoreDoc.name.split('/').pop();

            // Mark as completed
            const completeTx = db.transaction(['waitTimeUploadQueue'], 'readwrite');
            const completeStore = completeTx.objectStore('waitTimeUploadQueue');
            task.status = 'completed';
            task.waitTimeDocId = waitTimeDocId;
            task.completedAt = Date.now();
            task.updatedAt = Date.now();
            
            await new Promise((res, rej) => {
              const req = completeStore.put(task);
              req.onsuccess = () => res();
              req.onerror = () => rej(req.error);
            });

            processed++;
          } catch (error) {
            console.error('[SW] Wait time upload task failed:', error);
            
            // Update task with error
            const errorTx = db.transaction(['waitTimeUploadQueue'], 'readwrite');
            const errorStore = errorTx.objectStore('waitTimeUploadQueue');
            task.status = 'pending'; // Retry next time
            task.retries = (task.retries || 0) + 1;
            task.error = error.message;
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
      if (!db.objectStoreNames.contains('waitTimeUploadQueue')) {
        const waitTimeUploadStore = db.createObjectStore('waitTimeUploadQueue', { keyPath: 'uploadId' });
        waitTimeUploadStore.createIndex('status', 'status', { unique: false });
        waitTimeUploadStore.createIndex('waitTimeDocId', 'waitTimeDocId', { unique: false });
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
      // Silently skip if no auth token - this is normal when page hasn't authenticated yet
      return;
    }
    
    // Process expense upload queue
    const expenseResult = await processUploadQueue(authToken);
    console.log('[SW] Expense queue processed:', expenseResult);
    
    // Process wait time upload queue
    const waitTimeResult = await processWaitTimeQueue(authToken);
    console.log('[SW] Wait time queue processed:', waitTimeResult);
    
    // Notify all clients about upload status change
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    clients.forEach(client => {
      client.postMessage({ 
        type: 'upload-status-changed', 
        result: {
          expenses: expenseResult,
          waitTimes: waitTimeResult
        }
      });
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
  } else if (type === 'process-wait-time-queue') {
    const authToken = data?.authToken || null;
    try {
      const result = await processWaitTimeQueue(authToken || await requestAuthToken());
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

