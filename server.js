const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// CloudKit configuration
const CLOUDKIT_TOKEN = 'b63a53650fa6e18285979526369eb0d186b24b32cf498c3f89a22c9c549bf72b';
const CONTAINER_ID = 'icloud.com.soto.SOTO';
const BASE_URL = `https://api.apple-cloudkit.com/database/1/${CONTAINER_ID}/public`;

// Proxy endpoint for CloudKit validation
app.post('/api/validate-client', async (req, res) => {
    try {
        const { clientCode } = req.body;
        
        if (!clientCode) {
            return res.status(400).json({ error: 'Client code is required' });
        }

        // Create the query for CloudKit
        const query = {
            recordType: 'SOTOGroupWebsite',
            filterBy: [
                {
                    fieldName: 'clientCode',
                    comparator: 'EQUALS',
                    fieldValue: {
                        value: clientCode,
                        type: 'STRING'
                    }
                }
            ]
        };

        // Make the request to CloudKit
        const response = await fetch(`${BASE_URL}/records/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CloudKit-Protocol-Version': '1',
                'Authorization': `Bearer ${CLOUDKIT_TOKEN}`
            },
            body: JSON.stringify(query)
        });

        if (!response.ok) {
            console.error('CloudKit request failed:', response.status, response.statusText);
            return res.status(response.status).json({ 
                error: `CloudKit request failed: ${response.status}` 
            });
        }

        const data = await response.json();
        
        // Check if we found a matching client code
        if (data.records && data.records.length > 0) {
            const record = data.records[0];
            res.json({
                valid: true,
                clientCode: record.fields.clientCode.value,
                pricingFormula: record.fields.pricingFormula.value,
                companyName: record.fields.companyName?.value || 'Unknown'
            });
        } else {
            res.json({
                valid: false,
                message: 'Incorrect client code'
            });
        }

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ 
            error: 'Error validating client code. Please try again.' 
        });
    }
});

// Proxy endpoint for booking submissions
app.post('/api/submit-booking', async (req, res) => {
    try {
        const { companyNameString, distanceDouble, locationALocation, locationBLocation, priceDouble } = req.body;
        
        if (!companyNameString || !distanceDouble || !locationALocation || !locationBLocation || !priceDouble) {
            return res.status(400).json({ error: 'All booking fields are required' });
        }

        // Create the booking record for CloudKit
        const bookingRecord = {
            recordType: 'SOTOWebsiteBookings',
            fields: {
                companyNameString: {
                    value: companyNameString,
                    type: 'STRING'
                },
                distanceDouble: {
                    value: parseFloat(distanceDouble),
                    type: 'DOUBLE'
                },
                locationALocation: {
                    value: locationALocation,
                    type: 'STRING'
                },
                locationBLocation: {
                    value: locationBLocation,
                    type: 'STRING'
                },
                priceDouble: {
                    value: parseFloat(priceDouble),
                    type: 'DOUBLE'
                }
            }
        };

        // Make the request to CloudKit to save the booking
        const response = await fetch(`${BASE_URL}/records/modify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CloudKit-Protocol-Version': '1',
                'Authorization': `Bearer ${CLOUDKIT_TOKEN}`
            },
            body: JSON.stringify({
                operations: [{
                    operationType: 'create',
                    record: bookingRecord
                }]
            })
        });

        if (!response.ok) {
            console.error('CloudKit booking save failed:', response.status, response.statusText);
            return res.status(response.status).json({ 
                error: `CloudKit booking save failed: ${response.status}` 
            });
        }

        const data = await response.json();
        
        res.json({
            success: true,
            message: 'Booking submitted successfully',
            recordID: data.records?.[0]?.recordName || 'unknown'
        });

    } catch (error) {
        console.error('Server booking error:', error);
        res.status(500).json({ 
            error: 'Error submitting booking. Please try again.' 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`CloudKit proxy ready for client validation and booking submissions`);
}); 