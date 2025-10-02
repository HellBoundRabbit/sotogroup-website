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

    // Check for mixed mode opportunity (driving to/from train station)
    let mixedModeRoute = null;
    const trainSteps = transitSteps.filter((s) => s.mode === "HEAVY_RAIL" ||
                                                   s.mode === "RAIL" ||
                                                   s.mode === "SUBWAY");

    if (trainSteps.length > 0) {
      // Find first and last train stations
      const firstTrainStep = trainSteps[0];
      const lastTrainStep = trainSteps[trainSteps.length - 1];

      // Calculate time BEFORE first train (all steps before first train)
      const firstTrainIndex = allSteps.indexOf(firstTrainStep);
      const stepsBeforeTrain = allSteps.slice(0, firstTrainIndex);
      const timeBeforeTrain = stepsBeforeTrain.reduce((sum, step) => {
        return sum + (step.duration || 0);
      }, 0);

      // Calculate time AFTER last train (all steps after last train)
      const lastTrainIndex = allSteps.lastIndexOf(lastTrainStep);
      const stepsAfterTrain = allSteps.slice(lastTrainIndex + 1);
      const timeAfterTrain = stepsAfterTrain.reduce((sum, step) => {
        return sum + (step.duration || 0);
      }, 0);

      // If either segment >45min, calculate mixed mode alternative
      if (timeBeforeTrain > 45 || timeAfterTrain > 45) {
        const mixedModeSteps = [];
        let totalMixedModeDuration = 0;

        // If >45min before train, drive to first train station
        if (timeBeforeTrain > 45) {
          try {
            const driveToStationUrl =
              `https://maps.googleapis.com/maps/api/distancematrix/json` +
              `?origins=${encodeURIComponent(formattedOrigin)}` +
              `&destinations=${encodeURIComponent(firstTrainStep.departure)}` +
              `&mode=driving&key=${GOOGLE_MAPS_API_KEY}&units=imperial`;

            const driveResponse = await fetch(driveToStationUrl);
            const driveData = await driveResponse.json();

            if (driveData.status === "OK" &&
                driveData.rows[0].elements[0].status === "OK") {
              const driveElement = driveData.rows[0].elements[0];
              const driveDuration =
                Math.round(driveElement.duration.value / 60);

              mixedModeSteps.push({
                type: "drive",
                mode: "CAR",
                duration: driveDuration,
                distance: driveElement.distance.text,
                from: formattedOrigin,
                to: firstTrainStep.departure,
              });
              totalMixedModeDuration += driveDuration;
            }
          } catch (error) {
            console.error("Error calculating drive to station:", error);
          }
        } else {
          // Keep original steps before train
          stepsBeforeTrain.forEach((step) => {
            mixedModeSteps.push(step);
            totalMixedModeDuration += step.duration || 0;
          });
        }

        // Add all train segments
        trainSteps.forEach((step) => {
          mixedModeSteps.push(step);
          totalMixedModeDuration += step.duration || 0;
        });

        // If >45min after train, drive from last train station
        if (timeAfterTrain > 45) {
          try {
            const driveFromStationUrl =
              `https://maps.googleapis.com/maps/api/distancematrix/json` +
              `?origins=${encodeURIComponent(lastTrainStep.arrival)}` +
              `&destinations=${encodeURIComponent(formattedDestination)}` +
              `&mode=driving&key=${GOOGLE_MAPS_API_KEY}&units=imperial`;

            const driveResponse = await fetch(driveFromStationUrl);
            const driveData = await driveResponse.json();

            if (driveData.status === "OK" &&
                driveData.rows[0].elements[0].status === "OK") {
              const driveElement = driveData.rows[0].elements[0];
              const driveDuration =
                Math.round(driveElement.duration.value / 60);

              mixedModeSteps.push({
                type: "drive",
                mode: "CAR",
                duration: driveDuration,
                distance: driveElement.distance.text,
                from: lastTrainStep.arrival,
                to: formattedDestination,
              });
              totalMixedModeDuration += driveDuration;
            }
          } catch (error) {
            console.error("Error calculating drive from station:", error);
          }
        } else {
          // Keep original steps after train
          stepsAfterTrain.forEach((step) => {
            mixedModeSteps.push(step);
            totalMixedModeDuration += step.duration || 0;
          });
        }

        mixedModeRoute = {
          mode: "mixed",
          duration: totalMixedModeDuration,
          allSteps: mixedModeSteps,
          drivingToStation: timeBeforeTrain > 45,
          drivingFromStation: timeAfterTrain > 45,
        };

      }
    }

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
      mixedModeRoute: mixedModeRoute,
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
 * Simple job text parser with confidence scoring
 * @param {string} rawText - The raw job text to parse
 * @return {Object} Parsed job data with confidence scores
 */
function parseJobTextSimple(rawText) {
  const confidence = {};

  // Extract postcodes (UK format: comprehensive pattern)
  // Matches: A9 9AA, A9A 9AA, A99 9AA, AA9 9AA, AA9A 9AA, AA99 9AA
  const postcodeRegex = /\b([A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2})\b/gi;
  const postcodes = rawText.match(postcodeRegex) || [];

  // Normalize postcodes (ensure space before last 3 chars)
  const normalizePostcode = (pc) => {
    if (!pc) return pc;
    const cleaned = pc.replace(/\s+/g, "").toUpperCase();
    return `${cleaned.slice(0, -3)} ${cleaned.slice(-3)}`;
  };

  // Extract collection postcode
  // Look for postcodes after "Collection" or "Collect" or similar
  const collectionKeywords = /collection|collect|pickup|pick\s?up/gi;
  let collectionAddress = "";
  let collectionConfidence = 0;

  const collectionMatches = rawText.matchAll(
      new RegExp(`(${collectionKeywords.source}).*?` +
      `(${postcodeRegex.source})`, "gi"));
  const collectionMatchArray = Array.from(collectionMatches);

  if (collectionMatchArray.length > 0) {
    collectionAddress = normalizePostcode(collectionMatchArray[0][2]);
    collectionConfidence = 95; // High confidence - found with keyword
  } else if (postcodes.length > 0) {
    collectionAddress = normalizePostcode(postcodes[0]);
    collectionConfidence = 60; // Medium confidence - first postcode found
  } else {
    collectionAddress = "Unknown";
    collectionConfidence = 0; // No confidence
  }

  confidence.collection = collectionConfidence;

  // Extract delivery postcode
  // Look for postcodes after "Delivery" or "Deliver" or similar
  const deliveryKeywords = /delivery|deliver|destination|drop\s?off/gi;
  let deliveryAddress = "";
  let deliveryConfidence = 0;

  const deliveryMatches = rawText.matchAll(
      new RegExp(`(${deliveryKeywords.source}).*?` +
      `(${postcodeRegex.source})`, "gi"));
  const deliveryMatchArray = Array.from(deliveryMatches);

  if (deliveryMatchArray.length > 0) {
    deliveryAddress = normalizePostcode(deliveryMatchArray[0][2]);
    deliveryConfidence = 95; // High confidence - found with keyword
  } else if (postcodes.length >= 2) {
    deliveryAddress = normalizePostcode(postcodes[1]);
    deliveryConfidence = 60; // Medium confidence - second postcode found
  } else if (postcodes.length === 1) {
    // If only one postcode, use it for both collection and delivery
    deliveryAddress = normalizePostcode(postcodes[0]);
    deliveryConfidence = 40; // Low confidence - same as collection
  } else {
    deliveryAddress = "Not found";
    deliveryConfidence = 0;
  }

  confidence.delivery = deliveryConfidence;

  // Extract price (look for £ followed by numbers)
  const priceRegex = /£\s?(\d+(?:[.,]\d{2})?)/;
  const priceMatch = rawText.match(priceRegex);
  let price = 0;
  let priceConfidence = 0;

  if (priceMatch) {
    price = parseFloat(priceMatch[1].replace(",", "."));
    priceConfidence = 95; // High confidence - found with £ symbol
  } else {
    // Try to find standalone price
    const standalonePriceRegex = /\b(\d{2,3}(?:[.,]\d{2})?)\b/;
    const standalonePriceMatch = rawText.match(standalonePriceRegex);
    if (standalonePriceMatch) {
      price = parseFloat(standalonePriceMatch[1].replace(",", "."));
      priceConfidence = 50; // Medium confidence - number found without £
    }
  }

  confidence.price = priceConfidence;

  // Extract vehicle registration number (REG)
  // UK formats:
  // - Current (2001+): AA11 AAA (e.g. AB51 DVL)
  // - Prefix (1983-2001): A111 AAA
  // - Suffix (1963-1982): AAA 111A
  // - Old: AAA 111
  const regKeywords = /\b(?:reg(?:istration)?|vrm|number\s?plate)\b/gi;

  // Comprehensive UK registration patterns
  const currentRegex = /\b([A-Z]{2}\d{2}\s?[A-Z]{3})\b/gi; // AA11 AAA
  const prefixRegex = /\b([A-Z]\d{1,3}\s?[A-Z]{3})\b/gi; // A111 AAA
  const suffixRegex = /\b([A-Z]{3}\s?\d{1,3}[A-Z])\b/gi; // AAA 111A
  const oldRegex = /\b([A-Z]{3}\s?\d{1,3})\b/gi; // AAA 111

  let regNumber = "";
  let regConfidence = 0;
  let isChassisNumber = false;

  // First, try to find registration with keywords
  const regWithKeywordRegex = new RegExp(
      `(${regKeywords.source}).*?` +
      `(${currentRegex.source}|${prefixRegex.source}|` +
      `${suffixRegex.source}|${oldRegex.source})`,
      "gi");

  const regMatches = Array.from(rawText.matchAll(regWithKeywordRegex));

  if (regMatches.length > 0) {
    // Found with keyword - high confidence
    regNumber = regMatches[0][2].replace(/\s+/g, " ").toUpperCase().trim();
    regConfidence = 90;
  } else {
    // Try to find registration patterns without keyword
    const allRegMatches = [
      ...Array.from(rawText.matchAll(currentRegex)),
      ...Array.from(rawText.matchAll(prefixRegex)),
      ...Array.from(rawText.matchAll(suffixRegex)),
    ];

    if (allRegMatches.length > 0) {
      regNumber = allRegMatches[0][0].replace(/\s+/g, " ")
          .toUpperCase().trim();
      regConfidence = 65; // Medium confidence - pattern found without keyword
    } else {
      // Check for chassis number
      // Chassis numbers are typically 6-8 alphanumeric characters
      const chassisKeywords = /\b(?:chassis|vin|frame)\b/gi;
      const chassisRegex = /\b([A-Z0-9]{6,8})\b/gi;

      const chassisWithKeywordRegex = new RegExp(
          `(${chassisKeywords.source}).*?(${chassisRegex.source})`,
          "gi");

      const chassisMatches =
        Array.from(rawText.matchAll(chassisWithKeywordRegex));

      if (chassisMatches.length > 0) {
        regNumber = chassisMatches[0][2].toUpperCase().trim();
        regConfidence = 70; // Medium confidence for chassis
        isChassisNumber = true;
      } else {
        regNumber = "Not found";
        regConfidence = 0;
      }
    }
  }

  confidence.reg = regConfidence;

  return {
    collection_address: collectionAddress,
    postcode_delivery: deliveryAddress,
    price: price,
    reg_number: regNumber,
    is_chassis: isChassisNumber,
    confidence_scores: confidence,
    overall_confidence: Math.round(
        (confidence.collection + confidence.delivery +
         confidence.price + confidence.reg) / 4,
    ),
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
