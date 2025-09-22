# Logo Setup Guide

## How to Add Your Logos

### Step 1: Prepare Your Logo Files
1. **SOTO Logo**: Save your SOTO logo as `soto-logo.png` (or .jpg, .svg)
2. **EC Logistics Logo**: Save your EC Logistics logo as `ec-logistics-logo.png` (or .jpg, .svg)

### Step 2: Upload Your Logos
Place your logo files in the `assets/logos/` folder:
```
sotogroup-website/
├── assets/
│   └── logos/
│       ├── soto-logo.png          ← Add your SOTO logo here
│       └── ec-logistics-logo.png  ← Add your EC Logistics logo here
```

### Step 3: Supported File Formats
- **PNG** (recommended for logos with transparency)
- **JPG** (for photos or logos without transparency)
- **SVG** (scalable vector graphics - best quality)

### Step 4: Logo Requirements
- **Size**: Recommended 200x200 pixels or larger
- **Format**: Square or circular logos work best
- **Background**: Transparent background preferred
- **File Size**: Keep under 500KB for fast loading

### Step 5: Test Your Logos
1. Open the website in your browser
2. Navigate to the SOTO software page
3. Check that your SOTO logo appears
4. Navigate to EC Logistics page
5. Check that your EC Logistics logo appears

### Fallback System
If your logo fails to load, the website will automatically show the text version:
- SOTO logo → "SOTO" text
- EC Logistics logo → "EC" text

### Alternative: Use Different File Names
If you want to use different filenames, update the HTML files:

**For SOTO logo** (in `software/index.html`):
```html
<img src="../../assets/logos/YOUR_SOTO_LOGO_FILENAME.png" alt="SOTO Logo">
```

**For EC Logistics logo** (in `software/ec-logistics/index.html`):
```html
<img src="../../assets/logos/YOUR_EC_LOGO_FILENAME.png" alt="EC Logistics Logo">
```

### Logo Styling
The logos are displayed in circular containers with:
- Glass morphism background
- Subtle border
- 20px padding around the logo
- Responsive sizing

### Troubleshooting
- **Logo not showing**: Check the file path and filename
- **Logo too small**: Use a larger image file
- **Logo distorted**: Use a square image or SVG format
- **Logo too large**: The container will automatically resize it

### Quick Test
To test without uploading files, you can temporarily use placeholder images:
- Replace `soto-logo.png` with any image file you have
- Replace `ec-logistics-logo.png` with any image file you have 