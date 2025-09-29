/**
 * Firebase Configuration - Secure Version
 * This file contains environment-specific Firebase configuration
 */

// Environment detection
const isProduction = window.location.hostname !== 'localhost' && 
                     window.location.hostname !== '127.0.0.1';

// Firebase configuration based on environment
export const firebaseConfig = {
    // Production config (secure)
    production: {
        apiKey: process.env.FIREBASE_API_KEY || "AIzaSyCkXzYFC1jQcA6yw6qY1Ao3luEYU4Rd0yA",
        authDomain: "soto-routes.firebaseapp.com",
        projectId: "soto-routes",
        storageBucket: "soto-routes.firebasestorage.app",
        messagingSenderId: "440989695549",
        appId: "1:440989695549:web:0bce8b92a46f7f79953454",
        measurementId: "G-4E3G40QQ9L"
    },
    
    // Development config (can be more permissive)
    development: {
        apiKey: "AIzaSyCkXzYFC1jQcA6yw6qY1Ao3luEYU4Rd0yA",
        authDomain: "soto-routes.firebaseapp.com",
        projectId: "soto-routes",
        storageBucket: "soto-routes.firebasestorage.app",
        messagingSenderId: "440989695549",
        appId: "1:440989695549:web:0bce8b92a46f7f79953454",
        measurementId: "G-4E3G40QQ9L"
    }
};

// Export the appropriate config
export const config = isProduction ? firebaseConfig.production : firebaseConfig.development;
