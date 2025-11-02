# Firebase Storage CORS Configuration

## Problem
When uploading photos from `https://sotogroup.uk`, you're getting CORS errors because Firebase Storage hasn't been configured to allow requests from your domain.

## Solution
Configure CORS on your Firebase Storage bucket using Google Cloud's `gsutil` tool.

## Step 1: Install Google Cloud SDK (if not already installed)

### On macOS:
```bash
brew install --cask google-cloud-sdk
```

### Or download from:
https://cloud.google.com/sdk/docs/install

## Step 2: Authenticate with Google Cloud
```bash
gcloud auth login
gcloud config set project soto-routes
```

## Step 3: Apply CORS Configuration

The CORS configuration file (`firebase-storage-cors.json`) is already created in your project root.

Run this command to apply it:

```bash
gsutil cors set firebase-storage-cors.json gs://soto-routes.firebasestorage.app
```

## Step 4: Verify CORS is Applied
```bash
gsutil cors get gs://soto-routes.firebasestorage.app
```

You should see the CORS configuration returned, including `https://sotogroup.uk` in the origins list.

## Alternative: Using Firebase Console

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project: `soto-routes`
3. Go to **Storage** → **Files**
4. Click the **Settings** gear icon
5. Look for **CORS configuration** (this may require using gsutil instead)

**Note:** The Firebase Console doesn't always show CORS settings, so using `gsutil` (Step 3) is the most reliable method.

## What This Does

The CORS configuration allows:
- **Origins**: `sotogroup.uk`, `www.sotogroup.uk`, and localhost for development
- **Methods**: GET, HEAD, POST, PUT, DELETE (all operations needed for file uploads)
- **Headers**: All necessary headers for Firebase Storage uploads
- **Max Age**: 3600 seconds (1 hour) for preflight cache

After applying this, photo uploads from `https://sotogroup.uk` should work!

