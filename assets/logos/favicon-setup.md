# Favicon Setup Instructions

## What You Need to Do:

### Step 1: Convert Your SG Logo to Favicon Format
1. **Save your SG logo image** as `soto-favicon.png` in `/assets/logos/`
2. **Convert to .ico format** using one of these methods:
   - **Online converter**: https://favicon.io/favicon-converter/
   - **Photoshop**: File → Export → Export As → ICO
   - **GIMP**: File → Export As → Change extension to .ico

### Step 2: Place Favicon Files
Put these files in `/assets/logos/`:
- `favicon.ico` (16x16, 32x32, 48x48 sizes)
- `favicon-16x16.png` (16x16 pixels)
- `favicon-32x32.png` (32x32 pixels)
- `apple-touch-icon.png` (180x180 pixels for iOS)

### Step 3: Update HTML Pages
I'll add the favicon links to all your HTML pages.

## Current Favicon Links (Will Be Added):
```html
<!-- Favicon -->
<link rel="icon" type="image/x-icon" href="/assets/logos/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/logos/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/logos/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/logos/apple-touch-icon.png">
```

## File Structure:
```
/assets/logos/
├── favicon.ico          (main favicon)
├── favicon-16x16.png    (16x16 version)
├── favicon-32x32.png    (32x32 version)
├── apple-touch-icon.png (iOS version)
└── soto-favicon.png     (your original SG logo)
```
