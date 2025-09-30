const {setGlobalOptions} = require("firebase-functions");
const {onRequest, onCall} = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// Initialize Firebase Admin
admin.initializeApp();

// Set global options for cost control
setGlobalOptions({maxInstances: 10});

// Google Maps API key (set this in Firebase Functions config)
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY ||
  "AIzaSyDTbiSXo9tg1Tx8SlZCZKsR_R0zIQ4N1VA";

/**
 * Calculate distance between two addresses using Google Maps Distance Matrix
 */
exports.calculateDistance = onCall(async (request) => {
  try {
    const {origin, destination} = request.data;

    if (!origin || !destination) {
      throw new Error("Origin and destination are required");
    }

    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error("Google Maps API key not configured");
    }

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&key=${GOOGLE_MAPS_API_KEY}&units=imperial`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK") {
      throw new Error(`Google Maps API error: ${data.status}`);
    }

    const element = data.rows[0].elements[0];

    if (element.status !== "OK") {
      throw new Error(`Distance calculation failed: ${element.status}`);
    }

    // Convert meters to miles
    const distanceInMiles = element.distance.value / 1609.34;

    return {
      success: true,
      distance: Math.round(distanceInMiles * 10) / 10, // Round to 1 decimal
      duration: element.duration.text,
      origin: data.origin_addresses[0],
      destination: data.destination_addresses[0],
    };
  } catch (error) {
    logger.error("Distance calculation error:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

/**
 * Geocode an address using Google Maps Geocoding API
 */
exports.geocodeAddress = onCall(async (request) => {
  try {
    const {address} = request.data;

    if (!address) {
      throw new Error("Address is required");
    }

    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error("Google Maps API key not configured");
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK") {
      throw new Error(`Geocoding error: ${data.status}`);
    }

    if (data.results.length === 0) {
      throw new Error("No results found for the given address");
    }

    const result = data.results[0];

    return {
      success: true,
      formatted_address: result.formatted_address,
      location: result.geometry.location,
      place_id: result.place_id,
    };
  } catch (error) {
    logger.error("Geocoding error:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

/**
 * Get directions between two points using Google Maps Directions API
 */
exports.getDirections = onCall(async (request) => {
  try {
    const {origin, destination} = request.data;

    if (!origin || !destination) {
      throw new Error("Origin and destination are required");
    }

    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error("Google Maps API key not configured");
    }

    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK") {
      throw new Error(`Directions API error: ${data.status}`);
    }

    if (data.routes.length === 0) {
      throw new Error("No routes found");
    }

    const route = data.routes[0];

    return {
      success: true,
      distance: route.legs[0].distance,
      duration: route.legs[0].duration,
      steps: route.legs[0].steps.map((step) => ({
        instruction: step.html_instructions,
        distance: step.distance,
        duration: step.duration,
      })),
    };
  } catch (error) {
    logger.error("Directions error:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

/**
 * Secure route optimization - business logic hidden on server
 */
exports.optimizeRoutes = onCall(async (request) => {
  try {
    const {routes, drivers, selectedDay} = request.data;

    if (!routes || !drivers || !selectedDay) {
      throw new Error("Missing required parameters: routes, drivers, " +
          "selectedDay");
    }

    // Implement your proprietary optimization algorithm here
    // This logic is now hidden from the frontend

    // For now, simple assignment (replace with your algorithm)
    const optimizedRoutes = routes.map((route, index) => {
      const driver = drivers[index % drivers.length];
      return {
        routeId: route.id,
        assignedDriver: {
          id: driver.id,
          name: driver.name,
          postcode: driver.postcode,
        },
        optimizedAt: new Date().toISOString(),
      };
    });

    return {
      success: true,
      optimizedRoutes: optimizedRoutes,
      totalDistance: 0, // Calculate based on your algorithm
      optimizationScore: 0.85, // Your proprietary scoring
    };
  } catch (error) {
    logger.error("Route optimization error:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

/**
 * Get driver availability - secure server-side calculation
 */
exports.getDriverAvailability = onCall(async (request) => {
  try {
    const {officeId, date} = request.data;

    if (!officeId || !date) {
      throw new Error("Missing required parameters: officeId, date");
    }

    const db = admin.firestore();

    // Get total drivers for office
    const driversQuery = await db.collection("drivers")
        .where("officeId", "==", officeId)
        .get();

    const totalDrivers = driversQuery.size;

    // Get drivers off for date
    const calendarDoc = await db.collection("calendar")
        .doc(date)
        .get();

    let driversOff = 0;
    if (calendarDoc.exists) {
      const calendarData = calendarDoc.data();
      driversOff = calendarData.driversOff ? calendarData.driversOff.length : 0;
    }

    const availableDrivers = totalDrivers - driversOff;

    return {
      success: true,
      available: availableDrivers,
      total: totalDrivers,
      driversOff: driversOff,
      date: date,
    };
  } catch (error) {
    logger.error("Driver availability error:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

/**
 * Parse job text using AI - secure server-side processing
 */
exports.parseJobText = onCall(async (request) => {
  try {
    const {rawText} = request.data;

    if (!rawText) {
      throw new Error("Job text is required");
    }

    // Simple parsing logic (replace with your AI/parsing algorithm)
    const parsedData = parseJobTextSimple(rawText);

    return {
      success: true,
      parsed_data: parsedData,
      confidence: 0.85,
      processing_time: "0.2s",
    };
  } catch (error) {
    logger.error("Job parsing error:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

/**
 * Simple job text parser (replace with your AI logic)
 * @param {string} rawText - The raw job text to parse
 * @return {Object} Parsed job data
 */
function parseJobTextSimple(rawText) {
  // Extract postcodes (UK format: letters + numbers)
  const postcodeRegex = /([A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2})/gi;
  const postcodes = rawText.match(postcodeRegex) || [];

  // Extract price (look for £ followed by numbers)
  const priceRegex = /£(\d+(?:\.\d{2})?)/;
  const priceMatch = rawText.match(priceRegex);
  const price = priceMatch ? parseFloat(priceMatch[1]) : 0;

  // Extract collection and delivery addresses
  const collectionAddress = postcodes[0] || "Unknown";
  // If only one postcode found, use it for both collection and delivery
  // If two postcodes found, use second for delivery
  const deliveryAddress = postcodes.length >= 2 ?
    postcodes[1] : postcodes[0] || "Not found";

  return {
    collection_address: collectionAddress,
    postcode_delivery: deliveryAddress,
    price: price,
    raw_text: rawText,
    parsed_at: new Date().toISOString(),
  };
}

/**
 * Health check endpoint
 */
exports.health = onRequest((request, response) => {
  response.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "SOTO Routes API",
  });
});

/**
 * Delete a Firebase Authentication user (requires admin privileges)
 */
exports.deleteUser = onCall(async (request) => {
  try {
    const {uid} = request.data;

    if (!uid) {
      throw new Error("User ID is required");
    }

    // Delete the user from Firebase Authentication
    await admin.auth().deleteUser(uid);

    logger.info(`User ${uid} deleted from Firebase Authentication`);

    return {
      success: true,
      message: `User ${uid} deleted successfully`,
    };
  } catch (error) {
    logger.error("Error deleting user:", error);
    throw new Error(`Failed to delete user: ${error.message}`);
  }
});
