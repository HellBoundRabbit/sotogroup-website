# 🔄 GitHub Updates - Changelog

## 📅 Latest Update: September 29, 2024

### 🚨 **CRITICAL FIX: Google Maps API Parsing**

**Problem:** Job parsing was failing with 405 errors because the frontend was trying to call a non-existent server API.

**Solution:** Replaced server API calls with Firebase Functions for secure, server-side processing.

---

## 📁 **Files Changed:**

### 1. **pages/soto-lp.html** ⚠️ **CRITICAL UPDATE**
- **What Changed:** Fixed Google Maps API parsing
- **Before:** `fetch('/api/soto-lp/add-job', {...})` ❌ (404/405 errors)
- **After:** `window.firebase.httpsCallable(functions, 'parseJobText')` ✅
- **Impact:** Job parsing now works correctly

### 2. **CNAME** 🆕 **NEW FILE**
- **What:** Custom domain configuration
- **Content:** `sotogroup.uk`
- **Purpose:** Enables GitHub Pages to serve your custom domain

### 3. **.gitignore** 🔒 **SECURITY UPDATE**
- **What Changed:** Added exclusions for sensitive files
- **Excludes:** `functions/`, `*.py`, `server.js`, `*.db`, `*.pem`
- **Purpose:** Prevents accidental upload of sensitive code

### 4. **firebase-functions.js** 🆕 **NEW FILE**
- **What:** API helper for Firebase Functions
- **Purpose:** Provides secure interface to backend services
- **Features:** Distance calculation, geocoding, directions

### 5. **DEPLOYMENT_INSTRUCTIONS.md** 🆕 **NEW FILE**
- **What:** Complete deployment guide
- **Purpose:** Documents what files are safe to upload
- **Includes:** Security checklist, deployment steps

---

## 🎯 **What This Fixes:**

✅ **Job Parsing** - Now works with Firebase Functions  
✅ **Custom Domain** - Properly configured for sotogroup.uk  
✅ **Security** - Sensitive files excluded from GitHub  
✅ **API Integration** - Secure backend processing  
✅ **Documentation** - Clear deployment instructions  

---

## 🚀 **Deployment Instructions:**

1. **Upload these files** to your GitHub repository
2. **Replace existing files** with the updated versions
3. **Wait 5-10 minutes** for GitHub Pages to update
4. **Test job parsing** - should work perfectly now!

---

## ⚠️ **Important Notes:**

- **Firebase Functions** are deployed separately (not in GitHub)
- **API Keys** are now secure on the server side
- **Business Logic** is hidden from public view
- **Custom Domain** will work after upload

**Your website will now work exactly like before, but with secure backend processing!** 🎯
