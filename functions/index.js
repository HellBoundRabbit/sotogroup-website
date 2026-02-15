/* eslint-disable max-len */
/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */
const functions = require("firebase-functions");
const {onRequest, onCall, HttpsError} = require("firebase-functions/https");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

const resendApiKey = defineSecret("RESEND_API_KEY");

// Initialize Firebase Admin
admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const CALLABLE_OPTIONS = {
  cors: [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "https://sotogroup.uk",
    "https://www.sotogroup.uk",
    "https://soto-routes.web.app",
    "https://soto-routes.firebaseapp.com",
  ],
};

// Set global options for cost control
functions.setGlobalOptions({maxInstances: 10});

// Google Maps API key (set this in Firebase Functions config)
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY ||
  "AIzaSyDTbiSXo9tg1Tx8SlZCZKsR_R0zIQ4N1VA";

/**
 * Helpers
 */
function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }
  return request.auth;
}

function requireRole(request, roles) {
  const auth = requireAuth(request);
  const role = auth.token && auth.token.role;
  if (!role || !roles.includes(role)) {
    throw new HttpsError("permission-denied", "Insufficient permissions.");
  }
  return auth;
}

function getOfficeIdFromRequest(request, requirePresence = true) {
  const auth = requireAuth(request);
  const officeId = auth.token && auth.token.officeId ? auth.token.officeId : null;
  if (requirePresence && !officeId) {
    throw new HttpsError("permission-denied",
        "Office context is required for this operation.");
  }
  return officeId;
}

function generateTempPassword(length = 12) {
  let password = "";
  while (password.length < length) {
    password += crypto.randomBytes(16)
        .toString("base64")
        .replace(/[^a-zA-Z0-9]/g, "");
  }
  return password.slice(0, length);
}

async function syncClaimsWithProfile(uid, profile) {
  if (!profile) return {claimsUpdated: false};

  const expectedClaims = {};
  if (profile.role) {
    expectedClaims.role = profile.role;
  }
  if (profile.officeId) {
    expectedClaims.officeId = profile.officeId;
  }

  const userRecord = await admin.auth().getUser(uid);
  const currentClaims = userRecord.customClaims || {};

  let claimsMatch = Object.keys(expectedClaims).every((key) => {
    return currentClaims[key] === expectedClaims[key];
  });

  // Also ensure no unexpected claims linger (role/officeId only)
  const allowedKeys = Object.keys(expectedClaims);
  const extraKeys = Object.keys(currentClaims)
      .filter((key) => !allowedKeys.includes(key));
  if (extraKeys.length > 0) {
    claimsMatch = false;
  }

  if (!claimsMatch) {
    await admin.auth().setCustomUserClaims(uid, expectedClaims);
    await admin.auth().revokeRefreshTokens(uid);
    return {claimsUpdated: true};
  }

  return {claimsUpdated: false};
}

async function getUserProfile(uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

/**
 * Session bootstrap and access control
 */
exports.bootstrapSession = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireAuth(request);
  const uid = auth.uid;

  const profile = await getUserProfile(uid);
  if (!profile) {
    throw new HttpsError("failed-precondition", "User profile not found.");
  }

  const syncResult = await syncClaimsWithProfile(uid, profile);

  return {
    success: true,
    user: {
      uid,
      email: profile.email || (auth.token && auth.token.email) || null,
      role: profile.role || null,
      officeId: profile.officeId || null,
      name: profile.name || null,
    },
    claimsUpdated: syncResult.claimsUpdated,
  };
});

exports.listOffices = onCall(CALLABLE_OPTIONS, async (request) => {
  requireRole(request, ["admin"]);

  const snapshot = await db.collection("offices").orderBy("name").get();
  const offices = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      name: data.name || "",
      adminEmail: data.adminEmail || "",
      adminName: data.adminName || "",
      adminUid: data.adminUid || null,
      logoUrl: data.logoUrl || null,
      isActive: data.isActive !== false,
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt || null,
    };
  });

  return {offices};
});

exports.createOffice = onCall(CALLABLE_OPTIONS, async (request) => {
  requireRole(request, ["admin"]);

  const {name, adminEmail, adminName, password} = request.data || {};

  if (!name || typeof name !== "string") {
    throw new HttpsError("invalid-argument", "Office name is required.");
  }
  if (!adminEmail || typeof adminEmail !== "string") {
    throw new HttpsError("invalid-argument", "Admin email is required.");
  }
  if (!adminName || typeof adminName !== "string") {
    throw new HttpsError("invalid-argument", "Admin name is required.");
  }

  let initialPassword = null;
  if (password && typeof password === "string") {
    if (password.length < 8) {
      throw new HttpsError(
          "invalid-argument",
          "Admin password must be at least 8 characters long.",
      );
    }
    initialPassword = password;
  } else {
    initialPassword = generateTempPassword(12);
  }

  const officeRef = db.collection("offices").doc();
  const officeId = officeRef.id;

  let createdUid = null;
  try {
    const userRecord = await admin.auth().createUser({
      email: adminEmail,
      password: initialPassword,
      displayName: adminName,
    });

    createdUid = userRecord.uid;

    await admin.auth().setCustomUserClaims(userRecord.uid, {
      role: "office",
      officeId,
    });

    const now = FieldValue.serverTimestamp();

    await officeRef.set({
      name: name.trim(),
      adminEmail: adminEmail.toLowerCase(),
      adminName: adminName.trim(),
      adminUid: userRecord.uid,
      createdAt: now,
      updatedAt: now,
      isActive: true,
    });

    await db.collection("users").doc(userRecord.uid).set({
      email: adminEmail.toLowerCase(),
      name: adminName.trim(),
      role: "office",
      officeId,
      createdAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      officeId,
      adminUid: userRecord.uid,
      temporaryPassword: password ? null : initialPassword,
    };
  } catch (error) {
    logger.error("Error creating office:", error);
    if (createdUid) {
      try {
        await admin.auth().deleteUser(createdUid);
      } catch (cleanupError) {
        logger.error("Failed to clean up partially created admin user:",
            cleanupError);
      }
    }
    throw new HttpsError("internal", `Failed to create office: ${error.message}`);
  }
});

exports.updateOffice = onCall(CALLABLE_OPTIONS, async (request) => {
  requireRole(request, ["admin"]);

  const {officeId, name, logoUrl, isActive, adminName} = request.data || {};

  if (!officeId || typeof officeId !== "string") {
    throw new HttpsError("invalid-argument", "officeId is required.");
  }

  const officeRef = db.collection("offices").doc(officeId);
  const officeSnap = await officeRef.get();

  if (!officeSnap.exists) {
    throw new HttpsError("not-found", "Office not found.");
  }

  const updates = {};

  if (typeof name === "string" && name.trim()) {
    updates.name = name.trim();
  }

  if (typeof adminName === "string" && adminName.trim()) {
    updates.adminName = adminName.trim();
  }

  if (logoUrl === null || typeof logoUrl === "string") {
    updates.logoUrl = logoUrl || null;
  }

  if (typeof isActive === "boolean") {
    updates.isActive = isActive;
  }

  if (Object.keys(updates).length === 0) {
    return {success: true, officeId};
  }

  updates.updatedAt = FieldValue.serverTimestamp();

  await officeRef.update(updates);

  const officeData = officeSnap.data();
  if (officeData.adminUid && updates.adminName) {
    await db.collection("users").doc(officeData.adminUid).set({
      name: updates.adminName,
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
    await admin.auth().updateUser(officeData.adminUid, {
      displayName: updates.adminName,
    });
  }

  return {success: true, officeId};
});

exports.deleteOffice = onCall(CALLABLE_OPTIONS, async (request) => {
  requireRole(request, ["admin"]);

  const {officeId} = request.data || {};
  if (!officeId || typeof officeId !== "string") {
    throw new HttpsError("invalid-argument", "officeId is required.");
  }

  const officeRef = db.collection("offices").doc(officeId);
  const officeSnap = await officeRef.get();

  if (!officeSnap.exists) {
    throw new HttpsError("not-found", "Office not found.");
  }

  const officeData = officeSnap.data();
  const adminUid = officeData.adminUid || null;

  const batch = db.batch();
  batch.delete(officeRef);

  if (adminUid) {
    batch.delete(db.collection("users").doc(adminUid));
  }

  const driverAuthIds = [];
  const driversSnap = await db.collection("drivers")
      .where("officeId", "==", officeId)
      .get();
  driversSnap.forEach((doc) => {
    const data = doc.data();
    batch.delete(doc.ref);
    if (data.uid) {
      driverAuthIds.push(data.uid);
    }
  });

  await batch.commit();

  // Remove availability notifications
  const notificationsSnap = await db.collection("availabilityNotifications")
      .where("officeId", "==", officeId)
      .get();
  if (!notificationsSnap.empty) {
    const notifBatch = db.batch();
    notificationsSnap.forEach((doc) => notifBatch.delete(doc.ref));
    await notifBatch.commit();
  }

  // Remove calendar entries
  const calendarSnap = await db.collection("calendar")
      .where("officeId", "==", officeId)
      .get();
  if (!calendarSnap.empty) {
    const calBatch = db.batch();
    calendarSnap.forEach((doc) => calBatch.delete(doc.ref));
    await calBatch.commit();
  }

  if (adminUid) {
    try {
      await admin.auth().deleteUser(adminUid);
    } catch (error) {
      logger.error("Failed to delete office admin auth user:", error);
    }
  }

  for (const driverUid of driverAuthIds) {
    try {
      await admin.auth().deleteUser(driverUid);
    } catch (error) {
      logger.error("Failed to delete driver auth user:", error);
    }
  }

  return {success: true};
});

exports.listDrivers = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireAuth(request);
  const role = auth.token.role;

  let officeId = null;
  if (role === "admin") {
    officeId = request.data && request.data.officeId ?
      request.data.officeId :
      null;
    if (!officeId) {
      throw new HttpsError("invalid-argument", "officeId is required.");
    }
  } else if (role === "office" || role === "driver") {
    officeId = getOfficeIdFromRequest(request, true);
  } else {
    throw new HttpsError("permission-denied", "Insufficient permissions.");
  }

  const snapshot = await db.collection("drivers")
      .where("officeId", "==", officeId)
      .orderBy("firstName")
      .get();

  const drivers = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      uid: data.uid || doc.id,
      firstName: data.firstName || "",
      lastName: data.lastName || "",
      email: data.email || "",
      homePostcode: data.homePostcode || "",
      officeId: data.officeId || null,
      createdAt: data.createdAt || null,
      photoURL: data.photoURL || data.photoUrl || null,
    };
  });

  return {drivers};
});

exports.createDriver = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireAuth(request);
  const role = auth.token.role;

  const {
    firstName,
    lastName,
    email,
    homePostcode,
    carryover,
    carryoverPostcode,
    officeId: requestedOfficeId,
  } = request.data || {};

  if (!firstName || !lastName || !email) {
    throw new HttpsError("invalid-argument",
        "firstName, lastName, and email are required.");
  }

  let officeId = null;
  if (role === "admin") {
    if (!requestedOfficeId) {
      throw new HttpsError("invalid-argument", "officeId is required.");
    }
    officeId = requestedOfficeId;
  } else if (role === "office") {
    officeId = getOfficeIdFromRequest(request, true);
  } else {
    throw new HttpsError("permission-denied", "Insufficient permissions.");
  }

  const tempPassword = generateTempPassword(12);
  const displayName = `${firstName} ${lastName}`.trim();

  let driverUid = null;
  try {
    const userRecord = await admin.auth().createUser({
      email: email.toLowerCase(),
      password: tempPassword,
      displayName,
    });

    driverUid = userRecord.uid;

    await admin.auth().setCustomUserClaims(userRecord.uid, {
      role: "driver",
      officeId,
    });

    const now = FieldValue.serverTimestamp();
    const driverRef = db.collection("drivers").doc(userRecord.uid);

    await driverRef.set({
      uid: userRecord.uid,
      firstName,
      lastName,
      email: email.toLowerCase(),
      homePostcode: homePostcode || "",
      officeId,
      createdAt: now,
      createdBy: auth.uid,
      carryover: typeof carryover === "number" ? carryover : 0,
      carryoverPostcode: carryoverPostcode || "",
    });

    await db.collection("users").doc(userRecord.uid).set({
      email: email.toLowerCase(),
      name: displayName,
      role: "driver",
      officeId,
      createdAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      driverId: userRecord.uid,
      temporaryPassword: tempPassword,
    };
  } catch (error) {
    logger.error("Error creating driver:", error);
    if (driverUid) {
      try {
        await admin.auth().deleteUser(driverUid);
      } catch (cleanupError) {
        logger.error("Failed to clean up partially created driver:",
            cleanupError);
      }
    }
    throw new HttpsError("internal", `Failed to create driver: ${error.message}`);
  }
});

/**
 * Send driver login credentials by email (Resend API).
 * Uses Secret Manager: create secret RESEND_API_KEY with your Resend API key.
 * gcloud secrets create RESEND_API_KEY --data-file=- (paste key, Ctrl+D)
 * Or: Firebase Console > Project Settings > Service accounts > Secret Manager
 */
exports.sendDriverLoginEmail = onCall(
  {...CALLABLE_OPTIONS, secrets: [resendApiKey]},
  async (request) => {
    requireRole(request, ["office", "admin"]);
    const {toEmail, temporaryPassword, firstName, lastName, loginBaseUrl} =
      request.data || {};
    if (!toEmail || !temporaryPassword) {
      throw new HttpsError(
        "invalid-argument",
        "toEmail and temporaryPassword are required."
      );
    }
    let apiKey;
    try {
      apiKey = resendApiKey.value();
    } catch (e) {
      logger.error("Resend secret not available", e);
      throw new HttpsError(
        "failed-precondition",
        "Email not configured. Add RESEND_API_KEY in Secret Manager."
      );
    }
    if (!apiKey || !apiKey.trim()) {
      throw new HttpsError(
        "failed-precondition",
        "Email not configured. Add RESEND_API_KEY in Secret Manager."
      );
    }
    const baseUrl =
      loginBaseUrl ||
      process.env.LOGIN_BASE_URL ||
      "https://soto-routes.web.app";
    const loginUrl = `${baseUrl.replace(/\/$/, "")}/pages/soto-routes-login.html`;
    // Use verified domain (sotogroup.uk). Override with RESEND_FROM_EMAIL secret if needed.
    const fromEmail =
      process.env.RESEND_FROM_EMAIL ||
      "SOTOGroup <noreply@sotogroup.uk>";
    const name = [firstName, lastName].filter(Boolean).join(" ") || "Driver";
    const html = `
    <p>Hi ${name},</p>
    <p>Your SOTOGroup driver account has been created. Use the details below to sign in:</p>
    <p><strong>Login page:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
    <p><strong>Email:</strong> ${toEmail}</p>
    <p><strong>Temporary password:</strong> <code>${temporaryPassword}</code></p>
    <p>Please change your password after your first login if the app allows.</p>
    <p>— SOTOGroup</p>
  `;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: "Your SOTOGroup driver login details",
        html,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      logger.error("Resend API error", {status: res.status, body: errBody});
      let msg = "Failed to send email.";
      try {
        const j = JSON.parse(errBody);
        if (j && j.message) msg = j.message;
      } catch (_) {}
      throw new HttpsError("internal", msg);
    }
    return {success: true};
  }
);

exports.deleteDriver = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireAuth(request);
  const role = auth.token.role;
  const {driverId} = request.data || {};

  if (!driverId || typeof driverId !== "string") {
    throw new HttpsError("invalid-argument", "driverId is required.");
  }

  const driverRef = db.collection("drivers").doc(driverId);
  const driverSnap = await driverRef.get();

  if (!driverSnap.exists) {
    throw new HttpsError("not-found", "Driver not found.");
  }

  const driverData = driverSnap.data();
  const officeId = driverData.officeId;

  if (role === "office") {
    const claimOfficeId = getOfficeIdFromRequest(request, true);
    if (claimOfficeId !== officeId) {
      throw new HttpsError("permission-denied",
          "Cannot delete driver from another office.");
    }
  } else if (role !== "admin") {
    throw new HttpsError("permission-denied", "Insufficient permissions.");
  }

  const batch = db.batch();
  batch.delete(driverRef);
  batch.delete(db.collection("users").doc(driverId));
  await batch.commit();

  // Remove driver from calendar entries
  const calendarSnap = await db.collection("calendar")
      .where("officeId", "==", officeId)
      .where("driversOff", "array-contains", driverId)
      .get();
  if (!calendarSnap.empty) {
    const calendarBatch = db.batch();
    calendarSnap.forEach((doc) => {
      const data = doc.data();
      const updatedDrivers = (data.driversOff || [])
          .filter((id) => id !== driverId);
      calendarBatch.update(doc.ref, {
        driversOff: updatedDrivers,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    await calendarBatch.commit();
  }

  // Remove pending notifications
  const notificationsSnap = await db.collection("availabilityNotifications")
      .where("officeId", "==", officeId)
      .where("driverId", "==", driverId)
      .get();
  if (!notificationsSnap.empty) {
    const notifBatch = db.batch();
    notificationsSnap.forEach((doc) => notifBatch.delete(doc.ref));
    await notifBatch.commit();
  }

  try {
    await admin.auth().deleteUser(driverId);
  } catch (error) {
    logger.error("Failed to delete driver auth user:", error);
  }

  return {success: true};
});

/**
 * Find nearest train station to a given location using Google Places API
 * @param {string} location - The location to search from
 * @param {number} radiusInMiles - Search radius in miles (default 50)
 * @return {Object} Nearest station details or null
 */
async function findNearestTrainStation(location, radiusInMiles = 50) {
  try {
    // First geocode the location to get coordinates
    const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${GOOGLE_MAPS_API_KEY}`;

    const geocodeResponse = await fetch(geocodeUrl);
    const geocodeData = await geocodeResponse.json();

    if (geocodeData.status !== "OK" || !geocodeData.results[0]) {
      logger.error(`Geocoding failed for ${location}: ${geocodeData.status}`);
      return null;
    }

    const coords = geocodeData.results[0].geometry.location;
    const radiusInMeters = radiusInMiles * 1609.34;

    // Search for train stations near this location
    const placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${coords.lat},${coords.lng}&radius=${radiusInMeters}&type=train_station&key=${GOOGLE_MAPS_API_KEY}`;

    const placesResponse = await fetch(placesUrl);
    const placesData = await placesResponse.json();

    if (placesData.status !== "OK" ||
        !placesData.results ||
        placesData.results.length === 0) {
      logger.error(`No train stations found near ${location}`);
      return null;
    }

    // Get the nearest station (first result is closest)
    const nearestStation = placesData.results[0];

    return {
      name: nearestStation.name,
      address: nearestStation.vicinity,
      location: nearestStation.geometry.location,
      placeId: nearestStation.place_id,
    };
  } catch (error) {
    logger.error("Error finding nearest train station:", error);
    return null;
  }
}

/**
 * Calculate distance between two addresses using Google Maps Distance Matrix
 */
exports.calculateDistance = onCall(CALLABLE_OPTIONS, async (request) => {
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
 * Returns taxi info if ≤18min drive, otherwise public transport details
 * Supports arrivalTime (TO work) or departureTime (FROM work)
 */
exports.calculateTravelOptions = onCall(CALLABLE_OPTIONS, async (request) => {
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

    // If driving time is ≤18 minutes, return taxi option
    if (durationInMinutes <= 18) {
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
      // No direct transit available - find nearest train station
      logger.info(
          `No direct transit from ${formattedOrigin} ` +
          `to ${formattedDestination}`,
      );

      // Try to find nearest station to destination
      const nearestStation = await findNearestTrainStation(
          formattedDestination,
          50,
      );

      if (!nearestStation) {
        // Couldn't find station - return requires_authorization
        return {
          success: true,
          mode: "requires_authorization",
          originalDrivingDistance: Math.round(distanceInMiles * 10) / 10,
          originalDrivingDuration: Math.round(durationInMinutes),
          originalDrivingDurationText: drivingElement.duration.text,
          noStationFound: true,
          origin: drivingData.origin_addresses[0],
          destination: drivingData.destination_addresses[0],
        };
      }

      // Calculate driving from origin to train station
      const driveToStationUrl =
        `https://maps.googleapis.com/maps/api/distancematrix/json` +
        `?origins=${encodeURIComponent(formattedOrigin)}` +
        `&destinations=${encodeURIComponent(nearestStation.address)}` +
        `&mode=driving&key=${GOOGLE_MAPS_API_KEY}&units=imperial`;

      const driveToStationResponse = await fetch(driveToStationUrl);
      const driveToStationData = await driveToStationResponse.json();

      if (driveToStationData.status !== "OK" ||
          driveToStationData.rows[0].elements[0].status !== "OK") {
        // Can't calculate drive to station
        return {
          success: true,
          mode: "requires_authorization",
          originalDrivingDistance: Math.round(distanceInMiles * 10) / 10,
          originalDrivingDuration: Math.round(durationInMinutes),
          originalDrivingDurationText: drivingElement.duration.text,
          noStationFound: true,
          origin: drivingData.origin_addresses[0],
          destination: drivingData.destination_addresses[0],
        };
      }

      const driveToStationElement = driveToStationData.rows[0].elements[0];
      const driveToStationDuration = Math.round(
          driveToStationElement.duration.value / 60,
      );
      const driveToStationDistance = Math.round(
          (driveToStationElement.distance.value / 1609.34) * 10,
      ) / 10;

      // Now get transit from station to destination
      const stationToDestUrl =
        `${baseUrl}?origin=${encodeURIComponent(nearestStation.address)}` +
        `&destination=${destParam}&mode=transit` +
        `&key=${GOOGLE_MAPS_API_KEY}&units=imperial`;
      const stationTransitUrl = arrivalTime ?
        `${stationToDestUrl}&arrival_time=${arrivalTime}` :
        departureTime ?
        `${stationToDestUrl}&departure_time=${departureTime}` :
        stationToDestUrl;

      const stationTransitResponse = await fetch(stationTransitUrl);
      const stationTransitData = await stationTransitResponse.json();

      if (stationTransitData.status !== "OK") {
        // Station to destination transit also failed
        return {
          success: true,
          mode: "requires_authorization",
          originalDrivingDistance: Math.round(distanceInMiles * 10) / 10,
          originalDrivingDuration: Math.round(durationInMinutes),
          originalDrivingDurationText: drivingElement.duration.text,
          trainStation: nearestStation,
          driveToStationDuration: driveToStationDuration,
          driveToStationDistance: driveToStationDistance,
          noTransitFromStation: true,
          origin: drivingData.origin_addresses[0],
          destination: drivingData.destination_addresses[0],
        };
      }

      // Successfully got transit from station to destination
      const stationRoute = stationTransitData.routes[0];
      const stationLeg = stationRoute.legs[0];
      const stationTransitDuration = Math.round(stationLeg.duration.value / 60);

      // Extract transit steps from station to destination
      const stationTransitSteps = stationLeg.steps.map((step) => {
        if (step.travel_mode === "TRANSIT") {
          const transitDetails = step.transit_details;
          return {
            type: "transit",
            mode: transitDetails.line.vehicle.type,
            line: transitDetails.line.short_name || transitDetails.line.name,
            departure: transitDetails.departure_stop.name,
            arrival: transitDetails.arrival_stop.name,
            duration: Math.round(step.duration.value / 60),
            departureTime: transitDetails.departure_time.text,
            arrivalTime: transitDetails.arrival_time.text,
          };
        } else if (step.travel_mode === "WALKING") {
          return {
            type: "walk",
            duration: Math.round(step.duration.value / 60),
            distance: step.distance.text,
          };
        }
        return null;
      }).filter((step) => step !== null);

      // Total duration = drive to station + transit from station
      const totalDuration = driveToStationDuration + stationTransitDuration;

      // Return hybrid route requiring authorization
      return {
        success: true,
        mode: "requires_authorization",
        trainStation: nearestStation,
        driveToStation: {
          duration: driveToStationDuration,
          distance: driveToStationDistance,
          durationText: driveToStationElement.duration.text,
        },
        transitFromStation: {
          duration: stationTransitDuration,
          durationText: stationLeg.duration.text,
          steps: stationTransitSteps,
          departureTime: stationLeg.departure_time ?
            stationLeg.departure_time.text : null,
          arrivalTime: stationLeg.arrival_time ?
            stationLeg.arrival_time.text : null,
        },
        totalDuration: totalDuration,
        originalDrivingDistance: Math.round(distanceInMiles * 10) / 10,
        originalDrivingDuration: Math.round(durationInMinutes),
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
exports.geocodeAddress = onCall(CALLABLE_OPTIONS, async (request) => {
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
exports.getDirections = onCall(CALLABLE_OPTIONS, async (request) => {
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
exports.optimizeRoutes = onCall(CALLABLE_OPTIONS, async (request) => {
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
exports.getDriverAvailability = onCall(CALLABLE_OPTIONS, async (request) => {
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
exports.parseJobText = onCall(CALLABLE_OPTIONS, async (request) => {
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
  // Also matches without spaces: A99AA, AA99AA, etc.
  // Also matches when attached to words: WarwickshireCV378QR
  // Pattern: 1-2 letters, 1-2 digits, optional letter, then 1 digit and 2 letters
  // Use lookbehind/lookahead to handle postcodes attached to words
  const postcodeRegex = /([A-Z]{1,2}\d{1,2}[A-Z]?)\s?(\d[A-Z]{2})/gi;
  const postcodes = [];
  let match;
  while ((match = postcodeRegex.exec(rawText)) !== null) {
    // Combine the two parts (with or without space)
    postcodes.push({
      postcode: match[1] + match[2],
      index: match.index,
      fullMatch: match[0],
    });
  }

  // Normalize postcodes (ensure space before last 3 chars)
  const normalizePostcode = (pc) => {
    if (!pc) return pc;
    const cleaned = pc.replace(/\s+/g, "").toUpperCase();
    return `${cleaned.slice(0, -3)} ${cleaned.slice(-3)}`;
  };

  // Extract collection postcode
  // ONLY use postcodes that come AFTER the word "Collection"
  // NEVER use postcodes that come before "Collection"
  let collectionAddress = "";
  let collectionConfidence = 0;
  let collectionPostcodeEndIndex = -1; // Track end position of collection postcode

  // Find "Collection" keyword (case-insensitive)
  const rawTextLower = rawText.toLowerCase();
  const keywordIndex = rawTextLower.indexOf("collection");

  if (keywordIndex !== -1) {
    // Found "Collection" keyword - only search for postcodes AFTER this position
    const keywordEndIndex = keywordIndex + "collection".length;
    const textAfterCollection = rawText.substring(keywordEndIndex);

    // Find first postcode after "Collection"
    // Regex handles: postcodes with spaces, without spaces, and attached to words (e.g., "WarwickshireCV378QR")
    // Use case-insensitive flag to handle both uppercase and lowercase
    // Pattern: 1-2 letters, 1-2 digits, optional letter, optional space, then 1 digit and 2 letters
    const postcodeRegexAfter = /([A-Za-z]{1,2}\d{1,2}[A-Za-z]?)\s?(\d[A-Za-z]{2})/gi;
    const postcodeMatch = postcodeRegexAfter.exec(textAfterCollection);

    if (postcodeMatch) {
      // Convert to uppercase for consistency
      const postcode = (postcodeMatch[1] + postcodeMatch[2]).toUpperCase();
      collectionAddress = normalizePostcode(postcode);
      // Calculate absolute end index of this postcode in the original text
      // postcodeMatch.index is the position in textAfterCollection
      // postcodeMatch[0].length is the length of the matched postcode (with or without space)
      const postcodeStartInOriginal = keywordEndIndex + postcodeMatch.index;
      collectionPostcodeEndIndex = postcodeStartInOriginal + postcodeMatch[0].length;
      collectionConfidence = 95; // High confidence - found after "Collection"
    }
  }

  // If no collection postcode found, don't use any postcode
  // DO NOT fallback to first postcode - it might be before "Collection"
  if (!collectionAddress) {
    collectionAddress = "Not found";
    collectionConfidence = 0;
  }

  confidence.collection = collectionConfidence;

  // Extract delivery postcode
  // ONLY use postcodes that come AFTER the collection postcode
  let deliveryAddress = "";
  let deliveryConfidence = 0;

  if (collectionPostcodeEndIndex >= 0 && collectionAddress !== "Not found") {
    // Find text after the collection postcode ends
    const textAfterCollectionPostcode = rawText.substring(collectionPostcodeEndIndex);

    // Find first postcode after the collection postcode
    // Use case-insensitive flag to handle both uppercase and lowercase
    const postcodeRegexAfter = /([A-Za-z]{1,2}\d{1,2}[A-Za-z]?)\s?(\d[A-Za-z]{2})/gi;
    const postcodeMatch = postcodeRegexAfter.exec(textAfterCollectionPostcode);

    if (postcodeMatch) {
      // Convert to uppercase for consistency
      const postcode = (postcodeMatch[1] + postcodeMatch[2]).toUpperCase();
      deliveryAddress = normalizePostcode(postcode);
      deliveryConfidence = 95; // High confidence - found after collection postcode
    } else {
      deliveryAddress = "Not found";
      deliveryConfidence = 0;
    }
  } else {
    // No collection postcode found, so no delivery postcode
    deliveryAddress = "Not found";
    deliveryConfidence = 0;
  }

  confidence.delivery = deliveryConfidence;

  // Extract price - look for Price keyword OR £ symbol
  let price = 0;
  let priceConfidence = 0;

  // First: Try to find "Price" keyword followed by number
  const priceKeywordRegex =
    /price\s*(?:\([^)]*\))?\s*:?\s*£?\s*(\d+(?:[.,]\d{2})?)/gi;
  const priceKeywordMatch = rawText.match(priceKeywordRegex);

  if (priceKeywordMatch) {
    // Extract the number from the match
    const numberMatch =
      priceKeywordMatch[0].match(/(\d+(?:[.,]\d{2})?)/);
    if (numberMatch) {
      const parsedPrice = parseFloat(numberMatch[1].replace(",", "."));
      // Validate price is between £20 and £1000
      if (parsedPrice >= 20 && parsedPrice <= 1000) {
        price = parsedPrice;
        priceConfidence = 95; // High confidence with Price keyword
      }
    }
  }

  // Second: Try to find £ symbol followed by numbers
  if (price === 0) {
    const poundSignRegex = /£\s?(\d+(?:[.,]\d{2})?)/;
    const poundSignMatch = rawText.match(poundSignRegex);
    if (poundSignMatch) {
      const parsedPrice =
        parseFloat(poundSignMatch[1].replace(",", "."));
      // Validate price is between £20 and £1000
      if (parsedPrice >= 20 && parsedPrice <= 1000) {
        price = parsedPrice;
        priceConfidence = 90; // High confidence with £ symbol
      }
    }
  }

  // Third: Try to find standalone number in price range
  if (price === 0) {
    const standalonePriceRegex = /\b(\d{2,3}(?:[.,]\d{2})?)\b/g;
    const standalonePriceMatches =
      Array.from(rawText.matchAll(standalonePriceRegex));
    for (const match of standalonePriceMatches) {
      const parsedPrice = parseFloat(match[1].replace(",", "."));
      // Validate price is between £20 and £1000
      if (parsedPrice >= 20 && parsedPrice <= 1000) {
        price = parsedPrice;
        priceConfidence = 50; // Medium confidence
        break;
      }
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
  // Updated to handle cases with or without spaces
  const currentRegex = /([A-Z]{2}\d{2})\s?([A-Z]{3})/gi; // AA11 AAA (with or without space)
  const prefixRegex = /([A-Z]\d{1,3})\s?([A-Z]{3})/gi; // A111 AAA (with or without space)
  const suffixRegex = /([A-Z]{3})\s?(\d{1,3}[A-Z])/gi; // AAA 111A (with or without space)
  const oldRegex = /([A-Z]{3})\s?(\d{1,3})/gi; // AAA 111 (with or without space)

  let regNumber = "";
  let regConfidence = 0;
  let isChassisNumber = false;

  // Helper function to combine REG parts and normalize
  const combineRegParts = (match) => {
    if (match[1] && match[2]) {
      return (match[1] + " " + match[2]).toUpperCase().trim();
    }
    return match[0].replace(/\s+/g, " ").toUpperCase().trim();
  };

  // First, try to find registration with keywords
  let regFound = false;
  const regKeywordMatches = Array.from(rawText.matchAll(regKeywords));

  for (const keywordMatch of regKeywordMatches) {
    const textAfterKeyword = rawText.substring(keywordMatch.index + keywordMatch[0].length);

    // Try each REG pattern in the text after keyword
    let regMatch = currentRegex.exec(textAfterKeyword);
    if (!regMatch) {
      regMatch = prefixRegex.exec(textAfterKeyword);
    }
    if (!regMatch) {
      regMatch = suffixRegex.exec(textAfterKeyword);
    }
    if (!regMatch) {
      regMatch = oldRegex.exec(textAfterKeyword);
    }

    if (regMatch) {
      regNumber = combineRegParts(regMatch);
      regConfidence = 90; // High confidence - found with keyword
      regFound = true;
      break;
    }

    // Reset regex lastIndex for next iteration
    currentRegex.lastIndex = 0;
    prefixRegex.lastIndex = 0;
    suffixRegex.lastIndex = 0;
    oldRegex.lastIndex = 0;
  }

  if (!regFound) {
    // Try to find registration patterns without keyword
    const allRegMatches = [];

    // Reset regex lastIndex
    currentRegex.lastIndex = 0;
    prefixRegex.lastIndex = 0;
    suffixRegex.lastIndex = 0;
    oldRegex.lastIndex = 0;

    let match;
    while ((match = currentRegex.exec(rawText)) !== null) {
      allRegMatches.push({match: combineRegParts(match), index: match.index});
    }
    while ((match = prefixRegex.exec(rawText)) !== null) {
      allRegMatches.push({match: combineRegParts(match), index: match.index});
    }
    while ((match = suffixRegex.exec(rawText)) !== null) {
      allRegMatches.push({match: combineRegParts(match), index: match.index});
    }

    if (allRegMatches.length > 0) {
      // Sort by index to get first occurrence
      allRegMatches.sort((a, b) => a.index - b.index);
      regNumber = allRegMatches[0].match;
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
exports.deleteUser = onCall(CALLABLE_OPTIONS, async (request) => {
  try {
    requireRole(request, ["admin"]);

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

/**
 * Exchange Asana OAuth authorization code for access token
 * SECURE: Client secret is stored server-side only
 */
exports.exchangeAsanaToken = onCall({
  ...CALLABLE_OPTIONS,
  secrets: ["ASANA_CLIENT_ID", "ASANA_CLIENT_SECRET"],
}, async (request) => {
  try {
    requireAuth(request);

    const {code, redirect_uri: redirectUri} = request.data;

    if (!code || !redirectUri) {
      throw new HttpsError("invalid-argument",
          "Code and redirect_uri are required");
    }

    // Get Asana credentials from secrets (Firebase Functions v2)
    // Secrets are automatically available via process.env when declared in function options
    // Trim whitespace/newlines that may have been added when setting secrets
    const ASANA_CLIENT_ID = (process.env.ASANA_CLIENT_ID || "1212057669835882").trim();
    const ASANA_CLIENT_SECRET = (process.env.ASANA_CLIENT_SECRET ||
        "a5e5f2ea1dd6bcaaef390a6af4193407").trim();

    // Debug logging (remove in production)
    logger.info("Asana credentials check", {
      hasClientIdEnv: !!process.env.ASANA_CLIENT_ID,
      clientIdLength: ASANA_CLIENT_ID ? ASANA_CLIENT_ID.length : 0,
      hasSecretEnv: !!process.env.ASANA_CLIENT_SECRET,
      secretLength: ASANA_CLIENT_SECRET ? ASANA_CLIENT_SECRET.length : 0,
      usingFallback: !process.env.ASANA_CLIENT_ID || !process.env.ASANA_CLIENT_SECRET,
    });

    if (!ASANA_CLIENT_ID || ASANA_CLIENT_ID === "") {
      throw new HttpsError("failed-precondition",
          "Asana client ID not configured");
    }

    if (!ASANA_CLIENT_SECRET || ASANA_CLIENT_SECRET === "") {
      throw new HttpsError("failed-precondition",
          "Asana client secret not configured");
    }

    // Exchange code for token
    const tokenUrl = "https://app.asana.com/-/oauth_token";

    // Log for debugging (remove sensitive data in production)
    logger.info("Exchanging Asana token", {
      hasCode: !!code,
      codeLength: code ? code.length : 0,
      redirectUri: redirectUri,
      clientId: ASANA_CLIENT_ID,
      clientIdLength: ASANA_CLIENT_ID ? ASANA_CLIENT_ID.length : 0,
      hasSecret: !!ASANA_CLIENT_SECRET,
      secretLength: ASANA_CLIENT_SECRET ? ASANA_CLIENT_SECRET.length : 0,
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: ASANA_CLIENT_ID,
        client_secret: ASANA_CLIENT_SECRET,
        redirect_uri: redirectUri,
        code: code,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch (e) {
        errorData = {error: errorText};
      }
      logger.error("Asana token exchange failed:", {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        error: errorData,
        hasClientId: !!ASANA_CLIENT_ID,
        hasClientSecret: !!ASANA_CLIENT_SECRET,
        redirectUri: redirectUri,
      });
      throw new HttpsError("internal",
          `Failed to exchange token: ${tokenResponse.status} - ${errorData.error || errorData.error_description || errorText}`);
    }

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      throw new HttpsError("internal", "No access token in response");
    }

    return {
      success: true,
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in || null,
      refresh_token: tokenData.refresh_token || null,
    };
  } catch (error) {
    logger.error("Asana token exchange error:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", `Token exchange failed: ${error.message}`);
  }
});

/**
 * Fetch Asana user info (email, name, etc.)
 * SECURE: Handles API calls server-side
 */
exports.fetchAsanaUser = onCall(CALLABLE_OPTIONS, async (request) => {
  try {
    requireAuth(request);

    const {access_token: accessToken} = request.data;

    if (!accessToken) {
      throw new HttpsError("invalid-argument",
          "access_token is required");
    }

    // Fetch user info from Asana API
    const apiUrl = "https://app.asana.com/api/1.0/users/me";

    const response = await fetch(apiUrl, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new HttpsError("unauthenticated",
            "Asana access token is invalid or expired");
      }
      const errorText = await response.text();
      logger.error("Asana API error:", errorText);
      throw new HttpsError("internal",
          `Asana API error: ${response.status}`);
    }

    const data = await response.json();

    return {
      success: true,
      user: data.data || {},
    };
  } catch (error) {
    logger.error("Asana user fetch error:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", `Failed to fetch user: ${error.message}`);
  }
});

/**
 * Fetch tasks from Asana API for a specific date
 * SECURE: Handles API calls server-side
 */
/**
 * Fetch workspaces from Asana API
 * SECURE: Handles API calls server-side
 */
exports.fetchAsanaWorkspaces = onCall(CALLABLE_OPTIONS, async (request) => {
  try {
    requireAuth(request);

    const {access_token: accessToken} = request.data;

    if (!accessToken) {
      throw new HttpsError("invalid-argument",
          "access_token is required");
    }

    const workspacesUrl = "https://app.asana.com/api/1.0/workspaces";
    const workspacesResponse = await fetch(workspacesUrl, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
      },
    });

    if (!workspacesResponse.ok) {
      if (workspacesResponse.status === 401) {
        throw new HttpsError("unauthenticated",
            "Asana access token is invalid or expired");
      }
      const errorText = await workspacesResponse.text();
      logger.error("Asana workspaces API error:", errorText);
      throw new HttpsError("internal",
          `Asana API error: ${workspacesResponse.status}`);
    }

    const workspacesData = await workspacesResponse.json();
    const workspaces = workspacesData.data || [];

    return {
      success: true,
      workspaces: workspaces,
    };
  } catch (error) {
    logger.error("Asana workspaces fetch error:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", `Failed to fetch workspaces: ${error.message}`);
  }
});

/**
 * Fetch tasks from Asana API for a specific project and date using Search API
 * SECURE: Handles API calls server-side
 * Uses the Search API to filter by date efficiently (no need to fetch all tasks)
 */
exports.fetchAsanaTasks = onCall(CALLABLE_OPTIONS, async (request) => {
  try {
    requireAuth(request);

    const {access_token: accessToken, date, project_id: projectId, workspace_id: workspaceId} = request.data;

    if (!accessToken || !date) {
      throw new HttpsError("invalid-argument",
          "access_token and date are required");
    }

    if (!projectId) {
      throw new HttpsError("invalid-argument",
          "project_id is required");
    }

    // Get workspace ID if not provided
    let workspaceGid = workspaceId;
    if (!workspaceGid) {
      const workspacesUrl = "https://app.asana.com/api/1.0/workspaces";
      const workspacesResponse = await fetch(workspacesUrl, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
        },
      });

      if (!workspacesResponse.ok) {
        throw new HttpsError("internal",
            `Failed to fetch workspaces: ${workspacesResponse.status}`);
      }

      const workspacesData = await workspacesResponse.json();
      workspaceGid = workspacesData.data?.[0]?.gid;

      if (!workspaceGid) {
        throw new HttpsError("internal", "No workspace found");
      }
    }

    // Try Search API first - if it fails, fall back to fetching all and filtering
    // Search API format may vary - trying different approaches
    let allTasks = [];
    let useSearchAPI = false;
    
    try {
      // Try Search API with data wrapper format
      const searchUrl = `https://app.asana.com/api/1.0/workspaces/${workspaceGid}/tasks/search`;
      const searchBody = {
        "data": {
          "resource_subtype": "default_task",
          "opt_fields": ["name", "due_on"],
          "projects.any": projectId,
          "due_on": date,
        }
      };

      const searchResponse = await fetch(searchUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(searchBody),
      });

      if (searchResponse.ok) {
        const searchData = await searchResponse.json();
        allTasks = searchData.data || [];
        useSearchAPI = true;
        logger.info(`Used Search API: Found ${allTasks.length} tasks for date ${date}`);
      } else {
        logger.warn(`Search API returned ${searchResponse.status}, falling back to project tasks API`);
      }
    } catch (searchError) {
      logger.warn("Search API failed, using fallback:", searchError.message);
    }
    
    // Fallback: Fetch all tasks from project and filter by date (if Search API didn't work)
    if (!useSearchAPI) {
      logger.info("Using fallback: Fetching all tasks from project and filtering by date");
      let nextPageUrl = `https://app.asana.com/api/1.0/projects/${projectId}/tasks?opt_fields=name,due_on&limit=100`;
      let pageCount = 0;
      const maxPages = 50;

      while (nextPageUrl && pageCount < maxPages) {
        const projectTasksResponse = await fetch(nextPageUrl, {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
          },
        });

        if (!projectTasksResponse.ok) {
          if (projectTasksResponse.status === 401) {
            throw new HttpsError("unauthenticated",
                "Asana access token is invalid or expired");
          }
          const errorText = await projectTasksResponse.text();
          logger.error("Asana tasks API error:", errorText);
          throw new HttpsError("internal",
              `Asana API error: ${projectTasksResponse.status}`);
        }

        const projectTasksData = await projectTasksResponse.json();
        const pageTasks = projectTasksData.data || [];
        allTasks = allTasks.concat(pageTasks);

        const nextPage = projectTasksData.next_page;
        if (nextPage) {
          if (typeof nextPage === "string") {
            nextPageUrl = nextPage;
          } else if (nextPage.uri) {
            nextPageUrl = nextPage.uri;
          } else {
            nextPageUrl = null;
          }
          if (nextPageUrl) {
            pageCount++;
          }
        } else {
          nextPageUrl = null;
        }
      }

      // Filter by date
      if (date) {
        const originalCount = allTasks.length;
        allTasks = allTasks.filter((task) => {
          if (!task.due_on) return false;
          return task.due_on === date;
        });
        logger.info(`Filtered ${originalCount} tasks to ${allTasks.length} tasks for date ${date}`);
      }
    }

    const tasks = allTasks;
    logger.info(`Fetched ${tasks.length} tasks for date ${date} in project ${projectId}${useSearchAPI ? ' using Search API' : ' using project tasks API with date filtering'}`);

    return {
      success: true,
      tasks: tasks,
      count: tasks.length,
    };
  } catch (error) {
    logger.error("Asana tasks fetch error:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", `Failed to fetch tasks: ${error.message}`);
  }
});

/**
 * Optimize route assignments using proprietary algorithm
 * SECURE: Business logic hidden on server to protect from competitors
 * This implements the priority-based greedy assignment algorithm
 */
exports.optimizeRouteAssignments = onCall(CALLABLE_OPTIONS, async (request) => {
  try {
    requireAuth(request);

    const {
      carryoverAssignments,
      regularAssignments,
      numCarryoverRoutes,
      numRegularRoutes,
      numCarryoverDrivers,
      numRegularDrivers,
    } = request.data;

    if (!carryoverAssignments || !regularAssignments) {
      throw new HttpsError("invalid-argument",
          "carryoverAssignments and regularAssignments are required");
    }

    /**
     * Priority-based greedy assignment algorithm
     * Sorts by priority score (descending) and assigns greedily
     * @param {Array} assignments - Array of assignment objects with priorityScore
     * @param {number} numRoutes - Number of routes to assign
     * @param {number} numDrivers - Number of drivers available
     * @return {Array} Array of indices into assignments array (optimal assignments)
     */
    function findOptimalAssignmentByPriority(assignments, numRoutes, numDrivers) {
      // Sort by priority score (descending - highest priority first)
      const sortedAssignments = assignments
          .map((assignment, index) => ({assignment, index}))
          .sort((a, b) => b.assignment.priorityScore - a.assignment.priorityScore);

      const assignedRoutes = new Set();
      const assignedDrivers = new Set();
      const optimalIndices = [];

      // Greedy assignment: pick the best available option at each step
      for (const {assignment, index} of sortedAssignments) {
        // Skip if this route or driver is already assigned
        if (assignedRoutes.has(assignment.routeIndex) ||
            assignedDrivers.has(assignment.driverIndex)) {
          continue;
        }

        // Assign this driver to this route
        assignedRoutes.add(assignment.routeIndex);
        assignedDrivers.add(assignment.driverIndex);
        optimalIndices.push(index);

        // Stop if we've assigned all routes or all drivers
        if (optimalIndices.length === Math.min(numRoutes, numDrivers)) {
          break;
        }
      }

      logger.info(`Optimization result: ${optimalIndices.length} assignments from ${assignments.length} options`);
      return optimalIndices;
    }

    // Optimize carryover assignments separately
    let carryoverOptimal = [];
    if (carryoverAssignments.length > 0 && numCarryoverDrivers > 0) {
      carryoverOptimal = findOptimalAssignmentByPriority(
          carryoverAssignments,
          numCarryoverRoutes,
          numCarryoverDrivers,
      );
      logger.info(`Carryover optimization: ${carryoverOptimal.length} assignments`);
    }

    // Optimize regular assignments separately
    let regularOptimal = [];
    if (regularAssignments.length > 0 && numRegularDrivers > 0) {
      regularOptimal = findOptimalAssignmentByPriority(
          regularAssignments,
          numRegularRoutes,
          numRegularDrivers,
      );
      logger.info(`Regular optimization: ${regularOptimal.length} assignments`);
    }

    return {
      success: true,
      carryoverOptimal: carryoverOptimal,
      regularOptimal: regularOptimal,
      totalAssignments: carryoverOptimal.length + regularOptimal.length,
    };
  } catch (error) {
    logger.error("Route assignment optimization error:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal",
        `Optimization failed: ${error.message}`);
  }
});
