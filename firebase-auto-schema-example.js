// Firebase Auto-Schema Creation Example
// This shows how Firebase automatically creates collections and documents

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, collection, addDoc, getDocs, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCkXzYFC1jQcA6yw6qY1Ao31uEYU4Rd0yA",
    authDomain: "soto-routes.firebaseapp.com",
    projectId: "soto-routes",
    storageBucket: "soto-routes.firebasestorage.app",
    messagingSenderId: "440989695549",
    appId: "1:440989695549:web:0bce8b92a46f7f79953454",
    measurementId: "G-4E3G40QQ9L"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// =============================================================================
// AUTO-SCHEMA CREATION EXAMPLES
// =============================================================================

// 1. CLIENT MANAGEMENT - Auto-creates 'clients' collection
async function createClient() {
    // This automatically creates the 'clients' collection if it doesn't exist
    const clientData = {
        clientCode: '1001',
        companyName: 'EC Logistics',
        pricingFormula: 'distance * 10',
        contactEmail: 'contact@eclogistics.com',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
    };
    
    // Firebase auto-creates the collection and document
    const docRef = await addDoc(collection(db, 'clients'), clientData);
    console.log('Client created with ID:', docRef.id);
    return docRef.id;
}

// 2. ROUTES SYSTEM - Auto-creates 'routes' and 'jobs' collections
async function createRoute() {
    // Auto-creates 'routes' collection
    const routeData = {
        routeId: 'route_' + Date.now(),
        userId: 'user_123',
        routeName: 'B797RU, Tamworth, Staffordshire',
        driverName: 'John Smith',
        driverLocation: 'B775JA, Birmingham',
        totalJobs: 3,
        totalDistance: 45.2,
        estimatedDuration: 120,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date()
    };
    
    const routeRef = await addDoc(collection(db, 'routes'), routeData);
    
    // Auto-creates 'jobs' collection
    const jobData = {
        routeId: routeData.routeId,
        jobNumber: 1,
        collectionAddress: '123 Main Street, B797RU, Tamworth',
        deliveryAddress: '456 High Street, M1 4AN, Manchester',
        collectionPostcode: 'B797RU',
        deliveryPostcode: 'M1 4AN',
        price: 150.00,
        distance: 15.2,
        duration: 45,
        notes: 'Fragile items',
        isCompleted: false,
        createdAt: new Date()
    };
    
    const jobRef = await addDoc(collection(db, 'jobs'), jobData);
    console.log('Route and job created:', routeRef.id, jobRef.id);
    return { routeId: routeRef.id, jobId: jobRef.id };
}

// 3. BOOKINGS SYSTEM - Auto-creates 'bookings' collection
async function createBooking() {
    // Auto-creates 'bookings' collection
    const bookingData = {
        companyName: 'EC Logistics',
        clientCode: '1001',
        distance: 25.5,
        locationA: '123 Collection Street, B775JA, Birmingham',
        locationB: '456 Delivery Avenue, M1 4AN, Manchester',
        price: 255.00,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
    };
    
    const bookingRef = await addDoc(collection(db, 'bookings'), bookingData);
    console.log('Booking created with ID:', bookingRef.id);
    return bookingRef.id;
}

// 4. TEST SYSTEM - Auto-creates 'testMessages' collection
async function createTestMessage() {
    // Auto-creates 'testMessages' collection
    const testData = {
        messageText: 'Hello from Firebase! This is a test message.',
        timestamp: new Date(),
        messageId: 'test_msg_' + Date.now(),
        createdAt: new Date().toISOString(),
        testType: 'connection_test',
        status: 'success'
    };
    
    const testRef = await addDoc(collection(db, 'testMessages'), testData);
    console.log('Test message created with ID:', testRef.id);
    return testRef.id;
}

// 5. DRIVERS SYSTEM - Auto-creates 'drivers' collection
async function createDriver() {
    // Auto-creates 'drivers' collection
    const driverData = {
        driverId: 'driver_' + Date.now(),
        firstName: 'John',
        lastName: 'Smith',
        homePostcode: 'B775JA',
        carryover: 1,
        carryoverPostcode: 'M1 4AN',
        phoneNumber: '+44 7700 900001',
        email: 'john.smith@soto.com',
        licenseNumber: 'DL123456789',
        vehicleType: 'Van',
        maxCapacity: 1000,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
    };
    
    const driverRef = await addDoc(collection(db, 'drivers'), driverData);
    console.log('Driver created with ID:', driverRef.id);
    return driverRef.id;
}

// 6. DRIVER AVAILABILITY SYSTEM - Auto-creates 'driverAvailability' collection
async function createDriverAvailability() {
    // Auto-creates 'driverAvailability' collection
    const availabilityData = {
        driverId: 'driver_001',
        date: new Date(),
        isAvailable: true,
        startTime: '08:00',
        endTime: '17:00',
        maxJobs: 5,
        notes: 'Available for standard routes',
        createdAt: new Date()
    };
    
    const availabilityRef = await addDoc(collection(db, 'driverAvailability'), availabilityData);
    console.log('Driver availability created with ID:', availabilityRef.id);
    return availabilityRef.id;
}

// =============================================================================
// QUERYING EXAMPLES - Firebase auto-creates indexes for basic queries
// =============================================================================

// Query clients by clientCode (auto-indexed)
async function getClientByCode(clientCode) {
    const clientsSnapshot = await getDocs(collection(db, 'clients'));
    const clients = [];
    
    clientsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.clientCode === clientCode) {
            clients.push({ id: doc.id, ...data });
        }
    });
    
    return clients;
}

// Query jobs by routeId (auto-indexed)
async function getJobsByRoute(routeId) {
    const jobsSnapshot = await getDocs(collection(db, 'jobs'));
    const jobs = [];
    
    jobsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.routeId === routeId) {
            jobs.push({ id: doc.id, ...data });
        }
    });
    
    return jobs;
}

// Query bookings by status (auto-indexed)
async function getBookingsByStatus(status) {
    const bookingsSnapshot = await getDocs(collection(db, 'bookings'));
    const bookings = [];
    
    bookingsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.status === status) {
            bookings.push({ id: doc.id, ...data });
        }
    });
    
    return bookings;
}

// =============================================================================
// COMPLEX QUERIES - May require composite indexes
// =============================================================================

// Query routes by status and driver (may need composite index)
async function getRoutesByDriverAndStatus(driverName, status) {
    const routesSnapshot = await getDocs(collection(db, 'routes'));
    const routes = [];
    
    routesSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.driverName === driverName && data.status === status) {
            routes.push({ id: doc.id, ...data });
        }
    });
    
    return routes;
}

// Query jobs by price range (may need composite index)
async function getJobsByPriceRange(minPrice, maxPrice) {
    const jobsSnapshot = await getDocs(collection(db, 'jobs'));
    const jobs = [];
    
    jobsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.price >= minPrice && data.price <= maxPrice) {
            jobs.push({ id: doc.id, ...data });
        }
    });
    
    return jobs;
}

// =============================================================================
// USAGE EXAMPLES
// =============================================================================

// Example: Complete workflow
async function exampleWorkflow() {
    try {
        console.log('🚀 Starting Firebase auto-schema creation...');
        
        // 1. Create a client
        const clientId = await createClient();
        console.log('✅ Client created:', clientId);
        
        // 2. Create a route with jobs
        const { routeId, jobId } = await createRoute();
        console.log('✅ Route and job created:', routeId, jobId);
        
        // 3. Create a booking
        const bookingId = await createBooking();
        console.log('✅ Booking created:', bookingId);
        
        // 4. Query the data
        const clients = await getClientByCode('1001');
        console.log('📋 Found clients:', clients);
        
        const jobs = await getJobsByRoute(routeId);
        console.log('📦 Found jobs:', jobs);
        
        const bookings = await getBookingsByStatus('pending');
        console.log('📋 Found pending bookings:', bookings);
        
        console.log('🎉 All operations completed successfully!');
        
    } catch (error) {
        console.error('❌ Error in workflow:', error);
    }
}

// Export functions for use in other files
export {
    createClient,
    createRoute,
    createBooking,
    createTestMessage,
    createDriver,
    createDriverAvailability,
    getClientByCode,
    getJobsByRoute,
    getBookingsByStatus,
    getRoutesByDriverAndStatus,
    getJobsByPriceRange,
    exampleWorkflow
};

// =============================================================================
// KEY BENEFITS OF FIREBASE AUTO-SCHEMA
// =============================================================================

/*
✅ AUTOMATIC CREATION:
- Collections are created when you first write to them
- Documents are created with unique IDs automatically
- Fields are created as you add them
- No manual schema setup required

✅ FLEXIBLE STRUCTURE:
- Add new fields anytime
- Different documents can have different fields
- No rigid schema constraints

✅ AUTO-INDEXING:
- Basic queries work immediately
- Single-field queries are auto-indexed
- Complex queries may need composite indexes

✅ REAL-TIME UPDATES:
- Listen to changes in real-time
- Automatic synchronization across clients
- Offline support built-in

✅ SCALING:
- Handles millions of documents
- Automatic sharding
- Global distribution

✅ COMPLETE SCHEMA:
- clients: Client management (codes, pricing formulas)
- routes: Route information (driver, jobs, status)
- jobs: Individual job details (addresses, prices)
- bookings: Quote requests and bookings
- testMessages: Test data for development
- drivers: Driver information (name, postcode, carryover)
- driverAvailability: Driver schedule and availability

⚠️ CONSIDERATIONS:
- Complex queries may need composite indexes
- No foreign key constraints
- Data validation happens in application code
- Security rules are important for production
*/
