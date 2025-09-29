# Upload to GitHub Pages - Step by Step Guide

## Step 1: Create GitHub Account
1. Go to [github.com](https://github.com)
2. Click "Sign up" and create a free account
3. Verify your email

## Step 2: Create New Repository
1. Click the "+" icon in top right
2. Select "New repository"
3. Name it: `sotogroup-website`
4. Make it **Public** (required for free GitHub Pages)
5. Click "Create repository"

## Step 3: Upload Files
Once your repository is created, you'll see upload options:

### Option A: Drag and Drop (Easiest)
1. **Drag these files** into the upload area:
   - `index.html`
   - `assets/` folder (with your logos)
   - `README.md`

### Option B: Upload Button
1. Click "uploading an existing file"
2. Upload each file individually

## Step 4: Enable GitHub Pages
1. Go to **Settings** tab in your repository
2. Scroll down to **"Pages"** section
3. Under **"Source"**, select **"Deploy from a branch"**
4. Select **"main"** branch
5. Click **"Save"**

## Step 5: Set Custom Domain
1. In the same Pages section
2. Under **"Custom domain"**, enter: `sotogroup.uk`
3. Click **"Save"**
4. Check **"Enforce HTTPS"**

## Step 6: Update DNS Settings
You'll need to update your domain's DNS settings:

### If your domain is with Squarespace:
1. Go to your Squarespace domain settings
2. Add these DNS records:
   - **Type**: CNAME
   - **Name**: @
   - **Value**: `yourusername.github.io`

### If your domain is elsewhere:
1. Go to your domain registrar
2. Add the same CNAME record

## Step 7: Wait for Deployment
- GitHub Pages takes a few minutes to deploy
- Your site will be available at: `https://sotogroup.uk`

## Files to Upload:
- ✅ `index.html` (main website file)
- ✅ `assets/logos/soto-logo.png`
- ✅ `assets/logos/EC-Logistics-logo.png`
- ✅ `README.md`

## Need Help?
If you get stuck at any step, let me know and I'll help you through it! 