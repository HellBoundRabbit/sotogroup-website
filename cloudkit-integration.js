// CloudKit Integration for SOTO Group Website
// This script handles client code validation and pricing formula retrieval

class CloudKitValidator {
    constructor() {
        // Use the server proxy instead of direct CloudKit calls
        this.apiEndpoint = '/api/validate-client';
    }

    async validateClientCode(clientCode) {
        try {
            // Make the request to our server proxy
            const response = await fetch(this.apiEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ clientCode })
            });

            if (!response.ok) {
                throw new Error(`Server request failed: ${response.status}`);
            }

            const data = await response.json();
            
            // Return the validation result
            if (data.valid) {
                return {
                    valid: true,
                    clientCode: data.clientCode,
                    pricingFormula: data.pricingFormula,
                    companyName: data.companyName
                };
            } else {
                return {
                    valid: false,
                    message: data.message || 'Incorrect client code'
                };
            }

        } catch (error) {
            console.error('CloudKit validation error:', error);
            return {
                valid: false,
                message: 'Error validating client code. Please try again.'
            };
        }
    }

    calculatePrice(distance, clientData) {
        try {
            // Use the formula from CloudKit
            const formula = clientData.pricingFormula;
            
            // For now, we'll use a simple formula parser
            // You might want to implement a more sophisticated formula evaluator
            if (formula.includes('*')) {
                const multiplier = parseFloat(formula.split('*')[1]);
                return distance * multiplier;
            } else if (formula.includes('+')) {
                const parts = formula.split('+');
                const basePrice = parseFloat(parts[0]);
                const perMile = parseFloat(parts[1]);
                return basePrice + (distance * perMile);
            } else {
                // Default fallback
                return distance * 2;
            }
        } catch (error) {
            console.error('Price calculation error:', error);
            return distance * 2; // Default fallback
        }
    }
}

// Initialize the validator
const cloudKitValidator = new CloudKitValidator();

// Export for use in other scripts
window.CloudKitValidator = CloudKitValidator;
window.cloudKitValidator = cloudKitValidator; 