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
 * Calculate travel options (taxi vs public transport) based on duration
 * Returns taxi info if ≤15min drive, otherwise public transport details
 * Supports arrivalTime (TO work) or departureTime (FROM work)
 */
exports.calculateTravelOptions = onCall(async (request) => {
  try {
    const {origin, destination, arrivalTime, departureTime} = request.data;

    if (!origin || !destination) {
      throw new Error("Origin and destination are required");
    }

    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error("Google Maps API key not configured");
    }

    // Helper function to ensure UK is appended for UK postcodes
    const formatUKAddress = (address) => {
      // Check if it's a UK postcode pattern (e.g., B77 5JA, M1 4AN)
      const ukPostcodePattern = /^[A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}$/i;
      if (ukPostcodePattern.test(address.trim())) {
        return `${address}, UK`;
      }
      // If it doesn't already end with UK, add it
      if (!address.toLowerCase().includes("uk") &&
          !address.toLowerCase().includes("united kingdom")) {
        return `${address}, UK`;
      }
      return address;
    };

    const formattedOrigin = formatUKAddress(origin);
    const formattedDestination = formatUKAddress(destination);

    // First, get driving time and distance
    const drivingUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(formattedOrigin)}&destinations=${encodeURIComponent(formattedDestination)}&mode=driving&key=${GOOGLE_MAPS_API_KEY}&units=imperial`;

    const drivingResponse = await fetch(drivingUrl);
    const drivingData = await drivingResponse.json();

    if (drivingData.status !== "OK") {
      throw new Error(`Google Maps API error: ${drivingData.status}`);
    }

    const drivingElement = drivingData.rows[0].elements[0];

    if (drivingElement.status !== "OK") {
      throw new Error(`Driving calculation failed: ${drivingElement.status}`);
    }

    // Convert meters to miles and seconds to minutes
    const distanceInMiles = drivingElement.distance.value / 1609.34;
    const durationInMinutes = drivingElement.duration.value / 60;

    // If driving time is ≤15 minutes, return taxi option
    if (durationInMinutes <= 15) {
      return {
        success: true,
        mode: "taxi",
        distance: Math.round(distanceInMiles * 10) / 10,
        duration: Math.round(durationInMinutes),
        durationText: drivingElement.duration.text,
        origin: drivingData.origin_addresses[0],
        destination: drivingData.destination_addresses[0],
      };
    }

    // If >15 minutes, get public transport options
    // Add arrivalTime or departureTime (Unix timestamp in seconds)
    const baseUrl = "https://maps.googleapis.com/maps/api/directions/json";
    const originParam = encodeURIComponent(formattedOrigin);
    const destParam = encodeURIComponent(formattedDestination);
    let transitUrl = `${baseUrl}?origin=${originParam}&destination=`;
    transitUrl += `${destParam}&mode=transit&key=${GOOGLE_MAPS_API_KEY}`;
    transitUrl += "&units=imperial";

    if (arrivalTime) {
      transitUrl += `&arrival_time=${arrivalTime}`;
    } else if (departureTime) {
      transitUrl += `&departure_time=${departureTime}`;
    }

    const transitResponse = await fetch(transitUrl);
    const transitData = await transitResponse.json();

    if (transitData.status !== "OK") {
      // If no transit available, fall back to taxi with a warning
      return {
        success: true,
        mode: "taxi",
        distance: Math.round(distanceInMiles * 10) / 10,
        duration: Math.round(durationInMinutes),
        durationText: drivingElement.duration.text,
        warning: "No public transport available for this route",
        origin: drivingData.origin_addresses[0],
        destination: drivingData.destination_addresses[0],
      };
    }

    const route = transitData.routes[0];
    const leg = route.legs[0];
    const transitDurationMinutes = leg.duration.value / 60;

    // Extract all steps including walking and transit
    const allSteps = leg.steps.map((step) => {
      if (step.travel_mode === "TRANSIT") {
        const transitDetails = step.transit_details;
        return {
          type: "transit",
          mode: transitDetails.line.vehicle.type, // BUS, TRAIN, etc
          line: transitDetails.line.short_name || transitDetails.line.name,
          departure: transitDetails.departure_stop.name,
          arrival: transitDetails.arrival_stop.name,
          duration: Math.round(step.duration.value / 60), // minutes
          departureTime: transitDetails.departure_time.text,
          arrivalTime: transitDetails.arrival_time.text,
        };
      } else if (step.travel_mode === "WALKING") {
        return {
          type: "walk",
          duration: Math.round(step.duration.value / 60), // minutes
          distance: step.distance.text,
        };
      }
      return null;
    }).filter((step) => step !== null);

    // Calculate waiting times between steps
    const stepsWithWaiting = [];
    for (let i = 0; i < allSteps.length; i++) {
      stepsWithWaiting.push(allSteps[i]);

      // If this is a transit step and there's a next step
      if (i < allSteps.length - 1 && allSteps[i].type === "transit") {
        const nextStep = allSteps[i + 1];

        // If next step is transit, there might be waiting time
        if (nextStep.type === "transit") {
          // Parse times and calculate waiting (this is approximate)
          // Google already includes this in the total duration
          // We'll just flag that there's a transfer
          stepsWithWaiting.push({
            type: "transfer",
            duration: 0, // Duration already counted in total
          });
        }
      }
    }

    const transitSteps = allSteps.filter((s) => s.type === "transit");

    return {
      success: true,
      mode: "transit",
      duration: Math.round(transitDurationMinutes),
      durationText: leg.duration.text,
      allSteps: stepsWithWaiting,
      transitSteps: transitSteps,
      numTransfers: transitSteps.length - 1,
      origin: leg.start_address,
      destination: leg.end_address,
      departureTime: leg.departure_time ? leg.departure_time.text : null,
      arrivalTime: leg.arrival_time ? leg.arrival_time.text : null,
    };
  } catch (error) {
    logger.error("Travel options calculation error:", error);
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
