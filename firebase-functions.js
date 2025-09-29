/**
 * Firebase Functions API Helper
 * This file handles all calls to Firebase Functions for secure API access
 */

// Import Firebase Functions
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js';

// Initialize Firebase Functions
const functions = getFunctions(window.firebaseApp);

/**
 * Calculate distance between two addresses using Firebase Functions
 * @param {string} origin - Starting address
 * @param {string} destination - Destination address
 * @returns {Promise<Object>} Distance calculation result
 */
export async function calculateDistance(origin, destination) {
    try {
        const calculateDistanceFunction = httpsCallable(functions, 'calculateDistance');
        const result = await calculateDistanceFunction({
            origin: origin,
            destination: destination
        });
        
        return result.data;
    } catch (error) {
        console.error('Error calculating distance:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Geocode an address using Firebase Functions
 * @param {string} address - Address to geocode
 * @returns {Promise<Object>} Geocoding result
 */
export async function geocodeAddress(address) {
    try {
        const geocodeAddressFunction = httpsCallable(functions, 'geocodeAddress');
        const result = await geocodeAddressFunction({
            address: address
        });
        
        return result.data;
    } catch (error) {
        console.error('Error geocoding address:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Get directions between two points using Firebase Functions
 * @param {string} origin - Starting address
 * @param {string} destination - Destination address
 * @returns {Promise<Object>} Directions result
 */
export async function getDirections(origin, destination) {
    try {
        const getDirectionsFunction = httpsCallable(functions, 'getDirections');
        const result = await getDirectionsFunction({
            origin: origin,
            destination: destination
        });
        
        return result.data;
    } catch (error) {
        console.error('Error getting directions:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Check if Firebase Functions are available
 * @returns {Promise<boolean>} True if functions are available
 */
export async function checkFirebaseFunctionsHealth() {
    try {
        const response = await fetch('https://us-central1-soto-routes.cloudfunctions.net/health');
        const data = await response.json();
        return data.status === 'healthy';
    } catch (error) {
        console.error('Firebase Functions health check failed:', error);
        return false;
    }
}
