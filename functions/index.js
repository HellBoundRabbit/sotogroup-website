/**
 * SOTO Routes – Cloud Functions
 *
 * checkOverdueExpenses (scheduled): runs every hour, counts expense batches
 * over 24 working hours (pending/validated). When an office's count first
 * reaches 1, sends one email via Resend to that office's notification email.
 * Does not send again when count goes to 2 or 3; only when count goes back
 * to 0 and then to 1 again.
 */

const functions = require("firebase-functions");
const { onSchedule } = require("firebase-functions/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

/** Server Maps key: `GOOGLE_MAPS_API_KEY` in `functions/.env` or Cloud Functions runtime env. NOT the browser key. */
function getMapsApiKey() {
  return (process.env.GOOGLE_MAPS_API_KEY || "").trim();
}

/** RFC3339 UTC for Routes API `departureTime` / `arrivalTime`. */
function normalizeDepartureRfc3339(departureInput) {
  let d;
  if (typeof departureInput === "number" && Number.isFinite(departureInput)) {
    d = departureInput > 2e12 ? new Date(departureInput) : new Date(departureInput * 1000);
  } else if (typeof departureInput === "string" && departureInput.trim()) {
    const p = Date.parse(departureInput);
    d = Number.isFinite(p) ? new Date(p) : new Date();
  } else if (departureInput && typeof departureInput === "object" && departureInput.seconds) {
    d = new Date(departureInput.seconds * 1000);
  } else {
    d = new Date();
  }
  if (isNaN(d.getTime())) d = new Date();
  return d.toISOString();
}

/**
 * Field mask for transit computeRoutes. Parent `routes.legs.steps` returns step fields
 * (transitDetails, polylines, etc.) per Routes API field-mask rules.
 */
/** Transit schedules live under `routes.legs.steps.transitDetails` (+ nested stopDetails times); relying only on `routes.legs.steps` can omit them. */
const ROUTES_AUTH_TRANSIT_FIELD_MASK = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.staticDuration",
  "routes.routeLabels",
  "routes.polyline",
  "routes.legs.distanceMeters",
  "routes.legs.duration",
  "routes.legs.startLocation",
  "routes.legs.endLocation",
  "routes.legs.polyline",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.polyline",
  "routes.legs.steps.startLocation",
  "routes.legs.steps.endLocation",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.transitDetails",
].join(",");

admin.initializeApp();
const db = admin.firestore();

/** Working hours: 8am–5pm Mon–Fri. Returns whole hours between start and end. */
function calculateWorkingHours(startDate, endDate) {
  const start = startDate instanceof Date ? startDate : (startDate && typeof startDate.toDate === "function" ? startDate.toDate() : new Date(startDate));
  const end = endDate instanceof Date ? endDate : (endDate && typeof endDate.toDate === "function" ? endDate.toDate() : new Date(endDate));
  let current = new Date(start.getTime());
  let hours = 0;
  while (current < end) {
    const day = current.getDay();
    const h = current.getHours();
    if (day >= 1 && day <= 5 && h >= 8 && h < 17) hours += 1;
    current.setHours(current.getHours() + 1);
  }
  return hours;
}

/** Count batches for one office that are over 24 working hours (pending or validated). */
async function getOverdueCount(officeId) {
  const snap = await db.collection("expenseBatches")
      .where("officeId", "==", officeId)
      .get();
  const now = new Date();
  let count = 0;
  snap.docs.forEach((doc) => {
    const d = doc.data();
    if (d.status !== "pending" && d.status !== "validated") return;
    const submittedAt = d.submittedAt && d.submittedAt.toDate ? d.submittedAt.toDate() : (d.submittedAt ? new Date(d.submittedAt) : null);
    if (!submittedAt) return;
    if (calculateWorkingHours(submittedAt, now) >= 24) count += 1;
  });
  return count;
}

/** Send one email via Resend. Uses same from address as driver login emails. */
async function sendOverdueEmail(apiKey, toEmail, officeId, overdueCount) {
  if (!apiKey) {
    functions.logger.warn("Resend API key not set; skipping email.");
    return;
  }
  const fromEmail = process.env.OVERDUE_FROM_EMAIL || "SOTOGroup <noreply@sotogroup.uk>";
  const subject = "SOTO Routes: Expense(s) over 24 working hours";
    const html = `
    <p>This office has <strong>${overdueCount}</strong> expense batch(es) that have been over 24 working hours (pending or validated).</p>
    <p>Please log in to the Expenses page to review and process them.</p>
    <p>— SOTO Routes</p>
  `;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
      subject,
        html,
      }),
    });
    if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error: ${res.status} ${err}`);
  }
  functions.logger.info("Overdue email sent", { to: toEmail, officeId });
}

/**
 * Scheduled every hour. For each office with expense batches:
 * - Compute overdue count (24 working hours).
 * - If count >= 1 and we have not yet sent an email for this "cycle", send one and mark sent.
 * - If count === 0, reset the sent flag so the next time count hits 1 we send again.
 */
exports.checkOverdueExpenses = onSchedule(
  { schedule: "every 1 hours", timeZone: "Europe/London", secrets: [RESEND_API_KEY] },
  async () => {
    const apiKey = RESEND_API_KEY.value();
    const stateCol = db.collection("overdueExpenseNotification");
    const officesSnap = await db.collection("offices").get();
    const now = admin.firestore.FieldValue.serverTimestamp();

    for (const officeDoc of officesSnap.docs) {
      const officeId = officeDoc.id;
      const officeData = officeDoc.data();
      if (!officeData.overdueNotificationEnabled || !officeData.overdueNotificationEmail) {
        continue;
      }
      const toEmail = officeData.overdueNotificationEmail.trim();
      if (!toEmail) continue;

      const count = await getOverdueCount(officeId);
      const stateRef = stateCol.doc(officeId);
      const stateSnap = await stateRef.get();
      const state = stateSnap.exists ? stateSnap.data() : { emailSentAt: null };

      if (count >= 1) {
        if (!state.emailSentAt) {
          try {
            await sendOverdueEmail(apiKey, toEmail, officeId, count);
            await stateRef.set({
              emailSentAt: now,
              lastOverdueCount: count,
              lastCheckedAt: now,
            }, { merge: true });
          } catch (err) {
            functions.logger.error("Failed to send overdue email", { officeId, error: err.message });
          }
        } else {
          await stateRef.set({
            lastOverdueCount: count,
            lastCheckedAt: now,
          }, { merge: true });
        }
      } else if (state.emailSentAt) {
        await stateRef.set({
          emailSentAt: null,
          lastOverdueCount: 0,
          lastCheckedAt: now,
        }, { merge: true });
      }
    }

    return null;
});

/**
 * Deletes reviewed authorization requests after their 24h grace period.
 * Requests are tagged client-side with `deleteAtMs` when office decides.
 */
exports.cleanupExpiredAuthorizationRequests = onSchedule(
  { schedule: "every 30 minutes", timeZone: "Europe/London" },
  async () => {
    const nowMs = Date.now();
    const snap = await db.collection("authorizationRequests")
        .where("deleteAtMs", "<=", nowMs)
        .limit(500)
        .get();

    if (snap.empty) return null;

    const batch = db.batch();
    let deleteCount = 0;
    snap.docs.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const status = data.status || "pending";
      if (status === "approved" || status === "rejected" || status === "contact_office") {
        batch.delete(docSnap.ref);
        deleteCount += 1;
      }
    });

    if (deleteCount > 0) {
      await batch.commit();
      functions.logger.info("Deleted expired authorization requests", { count: deleteCount });
    }

    return null;
  }
);

/** Login URL used in driver login emails – short branded link. */
const DRIVER_LOGIN_URL = "https://sotogroup.uk/login";

/** Send driver login credentials email via Resend (callable). */
exports.sendDriverLoginEmail = onCall(
  { secrets: [RESEND_API_KEY] },
  async (req) => {
    const { toEmail, temporaryPassword, firstName, lastName } = req.data || {};
    if (!toEmail || !temporaryPassword) {
      throw new HttpsError("invalid-argument", "Missing toEmail or temporaryPassword.");
    }
    const apiKey = RESEND_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "Resend API key not configured.");
    }
    const fromEmail = process.env.RESEND_FROM_EMAIL || "SOTOGroup <noreply@sotogroup.uk>";
    const name = [firstName, lastName].filter(Boolean).join(" ") || "Driver";
    const subject = "SOTOGroup – Your login details";
    const html = `
    <p>Hi ${name},</p>
    <p>Here are your login details for SOTOGroup:</p>
    <ul>
      <li><strong>Email:</strong> ${toEmail}</li>
      <li><strong>Temporary password:</strong> ${temporaryPassword}</li>
    </ul>
    <p><a href="${DRIVER_LOGIN_URL}">Log in at sotogroup.uk/login</a></p>
    <p>Please change your password after your first login.</p>
    <p>— SOTOGroup</p>
    `;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new HttpsError("internal", `Failed to send email. ${err}`);
    }
    return { ok: true };
  }
);

// —— Google Maps (callable; uses GOOGLE_MAPS_API_KEY secret — NOT the browser/referrer-restricted key) ——

/**
 * Distance Matrix: driving distance between two addresses/postcodes.
 * Set secret: `firebase functions:secrets:set GOOGLE_MAPS_API_KEY` (paste a key with Distance Matrix +
 * Directions + **Routes API** enabled. Application restrictions: None; API restrictions: restrict to those APIs only.)
 */
exports.calculateDistance = onCall(
  { region: "us-central1", cors: true },
  async (request) => {
    const apiKey = getMapsApiKey();
    if (!apiKey) {
      throw new HttpsError(
        "failed-precondition",
        "GOOGLE_MAPS_API_KEY is not set. Add functions/.env with GOOGLE_MAPS_API_KEY=<key> and redeploy, or set runtime env in Google Cloud.",
      );
    }
    const { origin, destination } = request.data || {};
    if (!origin || !destination) {
      throw new HttpsError("invalid-argument", "origin and destination are required.");
    }
    const params = new URLSearchParams({
      origins: String(origin),
      destinations: String(destination),
      units: "imperial",
      key: apiKey,
    });
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "OK") {
      functions.logger.warn("distancematrix", { status: data.status, err: data.error_message });
      return {
        success: false,
        error: `Google Maps API error: ${data.status}${data.error_message ? ` — ${data.error_message}` : ""}`,
      };
    }
    const el = data.rows && data.rows[0] && data.rows[0].elements && data.rows[0].elements[0];
    if (!el || el.status !== "OK") {
      const st = el && el.status ? el.status : "NO_ELEMENT";
      return { success: false, error: `Google Maps API error: ${st}` };
    }
    const meters = el.distance && el.distance.value;
    if (typeof meters !== "number") {
      return { success: false, error: "Google Maps API error: NO_DISTANCE" };
    }
    const miles = meters * 0.000621371;
    return { success: true, distance: miles };
  },
);

const DEFAULT_LONG_BUS_TAXI_MINUTES = 45;
const DEFAULT_MIXED_MODE_EDGE_MINUTES = 45;

const TRAIN_VEHICLE_TYPES = new Set([
  "HEAVY_RAIL",
  "RAIL",
  "SUBWAY",
  "COMMUTER_TRAIN",
  "TRAM",
  "LIGHT_RAIL",
  "MONORAIL",
  "HIGH_SPEED_TRAIN",
  "FUNICULAR",
]);

function isBusVehicleType(vt) {
  const t = (vt || "").toUpperCase();
  return t === "BUS" || t.includes("BUS");
}

function isTrainVehicleType(vt) {
  return TRAIN_VEHICLE_TYPES.has((vt || "").toUpperCase());
}

function latLngParam(loc) {
  if (!loc) return null;
  const lat = loc.lat != null ? loc.lat : loc.latitude;
  const lng = loc.lng != null ? loc.lng : loc.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return `${lat},${lng}`;
}

function sumStepDurationSec(steps, fromIdx, toIdx) {
  let s = 0;
  for (let i = fromIdx; i <= toIdx; i++) {
    const v = steps[i] && steps[i].duration && steps[i].duration.value;
    if (typeof v === "number") s += v;
  }
  return s;
}

function findFirstLastTrainStepIndices(steps) {
  let first = -1;
  let last = -1;
  const arr = steps || [];
  for (let i = 0; i < arr.length; i++) {
    const step = arr[i];
    if (step.travel_mode !== "TRANSIT" || !step.transit_details) continue;
    const vt = step.transit_details.line && step.transit_details.line.vehicle && step.transit_details.line.vehicle.type;
    if (!isTrainVehicleType(vt)) continue;
    if (first < 0) first = i;
    last = i;
  }
  return { first, last };
}

/**
 * Driving minutes between two addresses or lat,lng pairs (UK, traffic-aware).
 */
async function fetchDrivingMinutes(apiKey, origin, destination, departureTime) {
  const params = new URLSearchParams({
    origin: String(origin),
    destination: String(destination),
    mode: "driving",
    departure_time: String(departureTime),
    traffic_model: "best_guess",
    region: "uk",
    key: apiKey,
  });
  const url = `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK" || !data.routes || !data.routes[0] || !data.routes[0].legs || !data.routes[0].legs[0]) {
    return null;
  }
  const dleg = data.routes[0].legs[0];
  const sec = (dleg.duration_in_traffic && dleg.duration_in_traffic.value) || dleg.duration.value;
  return Math.max(1, Math.ceil(sec / 60));
}

/**
 * Convert a slice of Google Directions steps to optimisation UI steps.
 * BUS legs longer than longBusThresholdMin are replaced with a drive (taxi) leg using Directions driving time for that segment.
 */
async function convertGoogleLegSliceToSteps(apiKey, steps, startIdx, endIdx, departureTime, longBusThresholdMin) {
  const thresholdSec = longBusThresholdMin * 60;
  const out = [];
  let totalSec = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    const step = steps[i];
    if (!step) continue;
    if (step.travel_mode === "WALKING" && step.duration && typeof step.duration.value === "number") {
      const durSec = step.duration.value;
      totalSec += durSec;
      out.push({
        type: "walk",
        duration: Math.max(1, Math.round(durSec / 60)),
      });
    } else if (step.travel_mode === "TRANSIT" && step.transit_details && step.duration && typeof step.duration.value === "number") {
      const td = step.transit_details;
      const vehicleType = td.line && td.line.vehicle && td.line.vehicle.type;
      const isBus = isBusVehicleType(vehicleType);
      const durSec = step.duration.value;
      if (isBus && durSec > thresholdSec) {
        const o = latLngParam(step.start_location);
        const d = latLngParam(step.end_location);
        if (o && d) {
          const driveMins = await fetchDrivingMinutes(apiKey, o, d, departureTime);
          if (driveMins != null) {
            totalSec += driveMins * 60;
            out.push({ type: "drive", mode: "CAR", duration: driveMins });
            continue;
          }
        }
      }
      totalSec += durSec;
      const mode = isBus ? "BUS" : "TRAIN";
      const depStop = td.departure_stop && td.departure_stop.name;
      out.push({
        type: "transit",
        mode,
        duration: Math.max(1, Math.round(durSec / 60)),
        departure: depStop || undefined,
      });
    }
  }
  return { steps: out, totalSec };
}

async function buildAdjustedTransitFromLeg(apiKey, leg, departureTime, longBusThresholdMin) {
  const steps = leg.steps || [];
  if (steps.length === 0) {
    const fallback = Math.max(1, Math.ceil(leg.duration.value / 60));
    return { steps: [], durationMinutes: fallback, totalSec: leg.duration.value };
  }
  const { steps: outSteps, totalSec } = await convertGoogleLegSliceToSteps(
      apiKey,
      steps,
      0,
      steps.length - 1,
      departureTime,
      longBusThresholdMin,
  );
  return {
    steps: outSteps,
    durationMinutes: Math.max(1, Math.ceil(totalSec / 60)),
    totalSec,
  };
}

/**
 * If access to the first train or from the last train exceeds edgeThresholdMin, offer drive+taxi legs on those ends.
 * Only returned when total time improves vs adjusted full-transit minutes.
 */
async function tryBuildMixedModeRoute(
    apiKey,
    originStr,
    destStr,
    leg,
    departureTime,
    edgeThresholdMin,
    longBusThresholdMin,
    adjustedFullTransitMinutes,
) {
  const steps = leg.steps || [];
  if (steps.length === 0) return null;

  const { first, last } = findFirstLastTrainStepIndices(steps);
  if (first < 0) return null;

  const n = steps.length;
  const edgeSec = edgeThresholdMin * 60;

  const prefixSec = first > 0 ? sumStepDurationSec(steps, 0, first - 1) : 0;
  const suffixSec = last < n - 1 ? sumStepDurationSec(steps, last + 1, n - 1) : 0;

  const needPrefix = first > 0 && prefixSec > edgeSec;
  const needSuffix = last < n - 1 && suffixSec > edgeSec;

  if (!needPrefix && !needSuffix) return null;

  const firstTrainStep = steps[first];
  const lastTrainStep = steps[last];
  const depLoc =
    latLngParam(firstTrainStep.transit_details && firstTrainStep.transit_details.departure_stop &&
        firstTrainStep.transit_details.departure_stop.location) ||
    latLngParam(firstTrainStep.start_location);
  const arrLoc =
    latLngParam(lastTrainStep.transit_details && lastTrainStep.transit_details.arrival_stop &&
        lastTrainStep.transit_details.arrival_stop.location) ||
    latLngParam(lastTrainStep.end_location);

  if (!depLoc) return null;
  if (needSuffix && !arrLoc) return null;

  let combinedSteps = [];
  let totalSec = 0;
  let drivingToStation = false;
  let drivingFromStation = false;

  if (needPrefix) {
    const dm = await fetchDrivingMinutes(apiKey, originStr, depLoc, departureTime);
    if (dm == null) return null;
    totalSec += dm * 60;
    combinedSteps.push({ type: "drive", mode: "CAR", duration: dm });
    drivingToStation = true;
  }

  const sliceStart = needPrefix ? first : 0;
  const sliceEnd = needSuffix ? last : n - 1;
  const mid = await convertGoogleLegSliceToSteps(apiKey, steps, sliceStart, sliceEnd, departureTime, longBusThresholdMin);
  combinedSteps = combinedSteps.concat(mid.steps);
  totalSec += mid.totalSec;

  if (needSuffix) {
    const dm2 = await fetchDrivingMinutes(apiKey, arrLoc, destStr, departureTime);
    if (dm2 == null) return null;
    totalSec += dm2 * 60;
    combinedSteps.push({ type: "drive", mode: "CAR", duration: dm2 });
    drivingFromStation = true;
  }

  const durationMinutes = Math.max(1, Math.ceil(totalSec / 60));
  if (durationMinutes >= adjustedFullTransitMinutes) return null;

  return {
    mode: "mixed",
    duration: durationMinutes,
    allSteps: combinedSteps,
    drivingToStation,
    drivingFromStation,
  };
}

/**
 * Parse transit leg into step list for the optimisation UI (sync, no long-bus substitution).
 */
function transitLegToSteps(leg) {
  const allSteps = [];
  for (const step of leg.steps || []) {
    if (step.travel_mode === "WALKING") {
      allSteps.push({
        type: "walk",
        duration: Math.max(1, Math.round(step.duration.value / 60)),
      });
    } else if (step.travel_mode === "TRANSIT" && step.transit_details) {
      const td = step.transit_details;
      const line = td.line || {};
      const vehicle = line.vehicle || {};
      const vtype = (vehicle.type || "").toUpperCase();
      const mode = isBusVehicleType(vtype) ? "BUS" : "TRAIN";
      const depStop = td.departure_stop && td.departure_stop.name;
      allSteps.push({
        type: "transit",
        mode,
        duration: Math.max(1, Math.round(step.duration.value / 60)),
        departure: depStop || undefined,
      });
    }
  }
  return allSteps;
}

/**
 * Driving vs PT rule (same as optimisation.html “How it works”):
 * ≤TAXI_MAX_DRIVE_MIN minutes by car → mode "taxi" (use driving duration).
 * Longer drive → mode "transit" when a transit route exists, with:
 *   - LONG_BUS_TAXI_MINUTES (default 45): each BUS leg longer than this is modelled as taxi (driving time for that segment).
 *   - MIXED_MODE_EDGE_MINUTES (default 45): if a rail leg exists and time before first train or after last train exceeds
 *     this, add optional mixedModeRoute (drive to/from station) when it beats the adjusted full-transit time.
 * Optional env: TAXI_MAX_DRIVE_MIN, LONG_BUS_TAXI_MINUTES, MIXED_MODE_EDGE_MINUTES in functions/.env.
 */
const DEFAULT_TAXI_MAX_DRIVE_MINUTES = 18;

/**
 * Directions API: driving time vs transit; threshold picks taxi vs PT (not “whichever is faster”).
 */
exports.calculateTravelOptions = onCall(
  { region: "us-central1", cors: true },
  async (request) => {
    const apiKey = getMapsApiKey();
    const taxiMaxDriveMin = (() => {
      const raw = process.env.TAXI_MAX_DRIVE_MIN;
      if (raw === undefined || raw === "") return DEFAULT_TAXI_MAX_DRIVE_MINUTES;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_TAXI_MAX_DRIVE_MINUTES;
    })();
    const longBusTaxiMin = (() => {
      const raw = process.env.LONG_BUS_TAXI_MINUTES;
      if (raw === undefined || raw === "") return DEFAULT_LONG_BUS_TAXI_MINUTES;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_LONG_BUS_TAXI_MINUTES;
    })();
    const mixedModeEdgeMin = (() => {
      const raw = process.env.MIXED_MODE_EDGE_MINUTES;
      if (raw === undefined || raw === "") return DEFAULT_MIXED_MODE_EDGE_MINUTES;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIXED_MODE_EDGE_MINUTES;
    })();
    if (!apiKey) {
      throw new HttpsError(
        "failed-precondition",
        "GOOGLE_MAPS_API_KEY is not set. Add functions/.env with GOOGLE_MAPS_API_KEY=<key> and redeploy, or set runtime env in Google Cloud.",
      );
    }
    const { origin, destination, departureTime } = request.data || {};
    if (!origin || !destination) {
      throw new HttpsError("invalid-argument", "origin and destination are required.");
    }
    const dep = typeof departureTime === "number" ? departureTime : Math.floor(Date.now() / 1000);
    const originStr = String(origin);
    const destStr = String(destination);

    const drivingParams = new URLSearchParams({
      origin: originStr,
      destination: destStr,
      mode: "driving",
      departure_time: String(dep),
      traffic_model: "best_guess",
      region: "uk",
      key: apiKey,
    });
    const transitParams = new URLSearchParams({
      origin: originStr,
      destination: destStr,
      mode: "transit",
      departure_time: String(dep),
      region: "uk",
      key: apiKey,
    });

    const base = "https://maps.googleapis.com/maps/api/directions/json";
    const [drivingRes, transitRes] = await Promise.all([
      fetch(`${base}?${drivingParams.toString()}`),
      fetch(`${base}?${transitParams.toString()}`),
    ]);
    const drivingData = await drivingRes.json();
    const transitData = await transitRes.json();

    let drivingMins = null;
    if (drivingData.status === "OK" && drivingData.routes && drivingData.routes[0] && drivingData.routes[0].legs && drivingData.routes[0].legs[0]) {
      const dleg = drivingData.routes[0].legs[0];
      const sec = (dleg.duration_in_traffic && dleg.duration_in_traffic.value) || dleg.duration.value;
      drivingMins = Math.max(1, Math.ceil(sec / 60));
    } else if (drivingData.status !== "ZERO_RESULTS") {
      functions.logger.warn("directions_driving", { status: drivingData.status, err: drivingData.error_message });
    }

    let transitMins = null;
    let transitLeg = null;
    if (transitData.status === "OK" && transitData.routes && transitData.routes[0] && transitData.routes[0].legs && transitData.routes[0].legs[0]) {
      transitLeg = transitData.routes[0].legs[0];
      transitMins = Math.max(1, Math.ceil(transitLeg.duration.value / 60));
    } else if (transitData.status !== "ZERO_RESULTS" && transitData.status !== "NOT_FOUND") {
      functions.logger.warn("directions_transit", { status: transitData.status, err: transitData.error_message });
    }

    // ≤18min (configurable) drive → taxi; else prefer public transport when available
    if (drivingMins != null && drivingMins <= taxiMaxDriveMin) {
      return {
        success: true,
        duration: drivingMins,
        mode: "taxi",
        allSteps: [],
        drivingDurationMinutes: drivingMins,
        transitDurationMinutes: transitMins,
        taxiMaxDriveMinutes: taxiMaxDriveMin,
      };
    }

    if (transitMins != null && transitLeg) {
      const adjusted = await buildAdjustedTransitFromLeg(apiKey, transitLeg, dep, longBusTaxiMin);
      const mixedModeRoute = await tryBuildMixedModeRoute(
          apiKey,
          originStr,
          destStr,
          transitLeg,
          dep,
          mixedModeEdgeMin,
          longBusTaxiMin,
          adjusted.durationMinutes,
      );
      const payload = {
        success: true,
        duration: adjusted.durationMinutes,
        mode: "transit",
        allSteps: adjusted.steps,
        drivingDurationMinutes: drivingMins,
        transitDurationMinutes: transitMins,
        taxiMaxDriveMinutes: taxiMaxDriveMin,
        longBusTaxiMinutesThreshold: longBusTaxiMin,
        mixedModeEdgeMinutesThreshold: mixedModeEdgeMin,
      };
      if (mixedModeRoute) payload.mixedModeRoute = mixedModeRoute;
      return payload;
    }

    if (drivingMins != null) {
      return {
        success: true,
        duration: drivingMins,
        mode: "taxi",
        allSteps: [],
        drivingDurationMinutes: drivingMins,
        taxiMaxDriveMinutes: taxiMaxDriveMin,
      };
    }

    if (transitMins != null) {
      return {
        success: true,
        duration: transitMins,
        mode: "transit",
        allSteps: transitLegToSteps(transitLeg),
        transitDurationMinutes: transitMins,
      };
    }

    const errStatus = transitData.status !== "OK" ? transitData : drivingData;
    return {
      success: false,
      duration: 999,
      mode: "transit",
      error: `Google Maps API error: ${errStatus.status}${errStatus.error_message ? ` — ${errStatus.error_message}` : ""}`,
    };
  },
);

/**
 * Routes API (v2): same family of multi-transit options as Google Maps (computeAlternativeRoutes).
 * Requires the server key to have **Routes API** enabled in Google Cloud Console (not only Directions).
 * Returns raw `routes[]` JSON for client-side adaptation to the JS Directions shape.
 */
exports.computeAuthorizationTransitRoutes = onCall(
    { region: "us-central1", cors: true },
    async (request) => {
      const apiKey = getMapsApiKey();
      if (!apiKey) {
        throw new HttpsError(
            "failed-precondition",
            "GOOGLE_MAPS_API_KEY is not set. Add functions/.env with GOOGLE_MAPS_API_KEY=<key> and redeploy.",
        );
      }

      const { origin, destination, departureTime, regionCode } = request.data || {};
      if (!origin || !destination ||
        typeof origin.lat !== "number" || typeof origin.lng !== "number" ||
        typeof destination.lat !== "number" || typeof destination.lng !== "number") {
        throw new HttpsError(
            "invalid-argument",
            "origin and destination must be { lat, lng } numbers.",
        );
      }

      const depIso = normalizeDepartureRfc3339(departureTime);
      const region = typeof regionCode === "string" && regionCode.length === 2
        ? regionCode.toUpperCase()
        : "GB";

      const body = {
        origin: {
          location: {
            latLng: { latitude: origin.lat, longitude: origin.lng },
          },
        },
        destination: {
          location: {
            latLng: { latitude: destination.lat, longitude: destination.lng },
          },
        },
        travelMode: "TRANSIT",
        departureTime: depIso,
        computeAlternativeRoutes: true,
        languageCode: "en-GB",
        regionCode: region,
      };

      const url = "https://routes.googleapis.com/directions/v2:computeRoutes";
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": ROUTES_AUTH_TRANSIT_FIELD_MASK,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        functions.logger.error("computeAuthorizationTransitRoutes fetch failed", { message: err.message });
        return { success: false, error: err.message || "Network error calling Routes API." };
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        functions.logger.warn("computeAuthorizationTransitRoutes bad JSON", { status: res.status, text: text.slice(0, 400) });
        return { success: false, error: `Routes API returned non-JSON (${res.status}).` };
      }

      if (!res.ok) {
        const msg = (data.error && data.error.message) || data.message || `HTTP ${res.status}`;
        functions.logger.warn("computeAuthorizationTransitRoutes routes error", {
          status: res.status,
          msg,
        });
        return { success: false, error: msg };
      }

      const routes = data.routes || [];
      if (!Array.isArray(routes) || routes.length === 0) {
        return {
          success: false,
          error: "No transit routes returned. Try a different time or locations.",
        };
      }

      return { success: true, routes };
    },
);
