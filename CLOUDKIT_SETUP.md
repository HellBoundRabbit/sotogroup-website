# CloudKit Integration Setup Guide

## Overview
This guide explains how to integrate your SwiftUI app's CloudKit database with the SOTO Group website for client code validation and dynamic pricing formulas.

## CloudKit Database Structure

### Required Record Type: `SOTOGroupWebsite`
Your CloudKit database should have a record type with the following fields:

```
Record Type: SOTOGroupWebsite
Fields:
- clientCode (String) - The client's unique code
- pricingFormula (String) - The formula to calculate price
- companyName (String) - The company name (optional)
- isActive (Boolean) - Whether this client code is active
```

### Example Records:
```
clientCode: "EC001"
pricingFormula: "distance * 2.5"
companyName: "EC Logistics"
isActive: true

clientCode: "EC002" 
pricingFormula: "50 + distance * 1.8"
companyName: "EC Logistics Premium"
isActive: true
```

## Setup Steps

### 1. Get Your CloudKit Credentials

1. **Container Identifier**: Find your CloudKit container ID in Xcode
   - Open your SwiftUI project
   - Go to Signing & Capabilities
   - Look for CloudKit container identifier

2. **Web Services URL**: Your CloudKit web services URL will be:
   ```
   https://api.apple-cloudkit.com/database/1/YOUR_CONTAINER_ID/public
   ```

### 2. Update the Integration Script

Edit `cloudkit-integration.js` and replace:
```javascript
this.containerIdentifier = 'YOUR_CLOUDKIT_CONTAINER_ID';
```

With your actual container ID:
```javascript
this.containerIdentifier = 'iCloud.com.yourcompany.sotoapp';
```

### 3. Authentication Setup

For production, you'll need to implement proper authentication. Options:

#### Option A: Server-Side Proxy (Recommended)
Create a simple server that handles CloudKit requests:

```javascript
// Example Node.js server
app.post('/validate-client', async (req, res) => {
    const { clientCode } = req.body;
    
    // Make authenticated request to CloudKit
    const response = await fetch('https://api.apple-cloudkit.com/...', {
        headers: {
            'Authorization': 'Bearer YOUR_SERVER_TOKEN'
        }
    });
    
    res.json(await response.json());
});
```

#### Option B: CloudKit Web Services Token
Generate a web services token in CloudKit Dashboard and use it directly.

### 4. Formula Parser

The current implementation supports simple formulas:
- `distance * 2.5` - Multiplies distance by 2.5
- `50 + distance * 1.8` - Base price + per mile rate

For more complex formulas, extend the `calculatePrice` method:

```javascript
calculatePrice(distance, clientData) {
    const formula = clientData.pricingFormula;
    
    // Add more formula parsing logic here
    if (formula.includes('if')) {
        // Handle conditional formulas
    }
    
    // Default parsing
    if (formula.includes('*')) {
        const multiplier = parseFloat(formula.split('*')[1]);
        return distance * multiplier;
    }
}
```

## Testing

### 1. Add Test Records
Add some test records to your CloudKit database:
```
clientCode: "TEST001"
pricingFormula: "distance * 2"
companyName: "Test Company"
```

### 2. Test the Website
1. Open the quotes page
2. Enter "TEST001" as client code
3. Fill in addresses
4. Click "Get Quote"
5. Should show "Incorrect client code" for invalid codes

## Security Considerations

### 1. Rate Limiting
Implement rate limiting to prevent abuse:
```javascript
// Add rate limiting to prevent too many requests
const rateLimiter = new Map();

function checkRateLimit(clientCode) {
    const now = Date.now();
    const key = `client_${clientCode}`;
    
    if (rateLimiter.has(key)) {
        const lastRequest = rateLimiter.get(key);
        if (now - lastRequest < 5000) { // 5 seconds
            return false;
        }
    }
    
    rateLimiter.set(key, now);
    return true;
}
```

### 2. Input Validation
Always validate input on both client and server side:
```javascript
function validateClientCodeInput(clientCode) {
    // Only allow alphanumeric characters
    return /^[A-Za-z0-9]+$/.test(clientCode);
}
```

## Troubleshooting

### Common Issues:

1. **CORS Errors**: Use a server-side proxy
2. **Authentication Errors**: Check your CloudKit credentials
3. **Formula Parsing Errors**: Test formulas in development first
4. **Rate Limiting**: Implement proper rate limiting

### Debug Mode:
Enable debug logging by adding to the script:
```javascript
console.log('CloudKit validation result:', clientValidation);
```

## Next Steps

1. **Deploy to Production**: Set up proper authentication
2. **Add More Formulas**: Extend the formula parser
3. **Add Analytics**: Track which client codes are used
4. **Add Caching**: Cache validated client codes for performance

## SwiftUI App Integration

In your SwiftUI app, create a function to update the CloudKit records:

```swift
func updateClientCode(_ clientCode: String, formula: String, companyName: String) {
    let record = CKRecord(recordType: "SOTOGroupWebsite")
    record["clientCode"] = clientCode
    record["pricingFormula"] = formula
    record["companyName"] = companyName
    record["isActive"] = true
    
    CKContainer.default().publicCloudDatabase.save(record) { _, error in
        if let error = error {
            print("Error saving record: \(error)")
        } else {
            print("Client code updated successfully")
        }
    }
}
``` 