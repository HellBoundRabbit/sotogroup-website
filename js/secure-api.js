/**
 * Secure API Wrapper
 * This file provides a secure interface to backend services
 * Business logic is hidden from the frontend
 */

class SecureAPI {
    constructor() {
        this.baseUrl = 'https://us-central1-soto-routes.cloudfunctions.net';
        this.cache = new Map();
    }

    /**
     * Secure route optimization - business logic hidden
     */
    async optimizeRoutes(routes, drivers, selectedDay) {
        try {
            const optimizeFunction = window.firebase.httpsCallable(window.firebase.functions, 'optimizeRoutes');
            const result = await optimizeFunction({
                routes: this.sanitizeRoutes(routes),
                drivers: this.sanitizeDrivers(drivers),
                selectedDay: selectedDay
            });
            
            return result.data;
        } catch (error) {
            console.error('Route optimization failed:', error);
            throw new Error('Unable to optimize routes at this time');
        }
    }

    /**
     * Secure distance calculation
     */
    async calculateDistance(origin, destination) {
        try {
            const calculateDistanceFunction = window.firebase.httpsCallable(window.firebase.functions, 'calculateDistance');
            const result = await calculateDistanceFunction({
                origin: origin,
                destination: destination
            });
            
            return result.data;
        } catch (error) {
            console.error('Distance calculation failed:', error);
            return { success: false, distance: 0, error: 'Distance calculation unavailable' };
        }
    }

    /**
     * Secure driver availability check
     */
    async getDriverAvailability(officeId, date) {
        try {
            const availabilityFunction = window.firebase.httpsCallable(window.firebase.functions, 'getDriverAvailability');
            const result = await availabilityFunction({
                officeId: officeId,
                date: date
            });
            
            return result.data;
        } catch (error) {
            console.error('Driver availability check failed:', error);
            return { available: 0, total: 0, error: 'Availability data unavailable' };
        }
    }

    /**
     * Sanitize route data before sending to backend
     */
    sanitizeRoutes(routes) {
        return routes.map(route => ({
            id: route.id,
            jobs: route.jobs?.map(job => ({
                collectionAddress: job.collectionAddress,
                deliveryAddress: job.deliveryAddress,
                // Hide sensitive business data
            })) || []
        }));
    }

    /**
     * Sanitize driver data before sending to backend
     */
    sanitizeDrivers(drivers) {
        return drivers.map(driver => ({
            id: driver.id,
            name: driver.name,
            postcode: driver.postcode,
            // Hide sensitive driver data
        }));
    }

    /**
     * Secure route saving
     */
    async saveRoutes(routes, userId) {
        try {
            const saveRoutesFunction = window.firebase.httpsCallable(window.firebase.functions, 'saveRoutes');
            const result = await saveRoutesFunction({
                routes: this.sanitizeRoutes(routes),
                userId: userId
            });
            
            return result.data;
        } catch (error) {
            console.error('Route saving failed:', error);
            throw new Error('Unable to save routes at this time');
        }
    }
}

// Create singleton instance
window.secureAPI = new SecureAPI();
