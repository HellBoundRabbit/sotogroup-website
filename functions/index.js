/**
 * SOTO Routes — Cloud Functions (server-side only)
 *
 * This file is deployed to **Google Cloud** (Firebase Functions v2 → Cloud Run). It does **not**
 * execute in the browser. The site calls these via `httpsCallable(firebase.functions, 'exportName')`
 * matching each `exports.<exportName>` below.
 *
 * =====================================================================================
 * CLOUD FUNCTIONS IN THIS REPOSITORY — keep in sync when you add or rename `exports.*`
 * =====================================================================================
 *
 * Scheduled:
 *   checkOverdueExpenses — Hourly; overdue batch email (secret RESEND_API_KEY).
 *   cleanupExpiredAuthorizationRequests — Every 30m; delete expired authorizationRequests.
 *
 * Callable (onCall, typically us-central1):
 *   sendDriverLoginEmail — Driver login email via Resend (secret RESEND_API_KEY).
 *   calculateDistance — Distance Matrix, miles between addresses (secret GOOGLE_MAPS_API_KEY).
 *   calculateTravelOptions — Directions driving vs transit, taxi/PT rules (secret GOOGLE_MAPS_API_KEY).
 *   computeAuthorizationTransitRoutes — Routes API v2 transit alternatives (secret GOOGLE_MAPS_API_KEY).
 *   createDriver — Firebase Auth + users + drivers; returns temporaryPassword.
 *   listDrivers — List drivers for officeId.
 *   deleteDriver — Remove driver data, Firestore, Auth.
 *   parseJobText — Gemini 2.0 Flash (secret GOOGLE_AI_API_KEY; GCP Gemini API, often SA-bound key).
 *   xeroGetAuthorizationUrl — OAuth start; env XERO_CLIENT_ID; CORS in XERO_CALLABLE_OPTIONS.
 *   xeroExchangeCode — OAuth callback tokens → xeroOfficeTokens; env XERO_CLIENT_ID + XERO_CLIENT_SECRET.
 *   xeroDisconnect — Remove office Xero connection.
 *   xeroCreateDraftBillsForBatches — Draft bills + receipt attachments; granular accounting scopes.
 *
 * Other names (bootstrapSession, Asana fetch, optimizeRoutes, …) may still exist in Firebase from
 * elsewhere — not exported here. Never `firebase deploy --only functions` without names (can drop them).
 *
 * =====================================================================================
 * PARTIAL DEPLOY — this repo’s functions only (append `,functions:newExport` when you add one)
 * =====================================================================================
 *
 * firebase deploy --only "functions:checkOverdueExpenses,functions:cleanupExpiredAuthorizationRequests,functions:sendDriverLoginEmail,functions:calculateDistance,functions:calculateTravelOptions,functions:computeAuthorizationTransitRoutes,functions:createDriver,functions:listDrivers,functions:deleteDriver,functions:xeroGetAuthorizationUrl,functions:xeroExchangeCode,functions:xeroDisconnect,functions:xeroCreateDraftBillsForBatches,functions:parseJobText"
 *
 * Secrets / env: `firebase functions:secrets:set` or Cloud Run; never commit live keys; `functions/.env` local only.
 *
 * =====================================================================================
 * Behaviour detail (Xero & overdue)
 * =====================================================================================
 *
 * checkOverdueExpenses: first time office hits ≥1 overdue batch, one Resend email; cycle resets when count 0.
 * Xero: OAuth scopes granular accounting.* (post Mar 2026 apps); tokens in xeroOfficeTokens/{officeId};
 * xeroCreateDraftBillsForBatches — validated batches when `xeroExpenseIntegrationEnabled`; Travel–National
 * nominal; InvoiceNumber on bills; up to 10 receipt attachments; returns `{ results, okCount, total }`.
 */

const functions = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const schema = require("./expense-batch-schema.cjs");

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

/** Same name as Secret Manager / `firebase functions:secrets:set GOOGLE_MAPS_API_KEY`. Bound on Maps callables so deploy injects `process.env`. */
const GOOGLE_MAPS_API_KEY_SECRET = defineSecret("GOOGLE_MAPS_API_KEY");
const GOOGLE_AI_API_KEY_SECRET = defineSecret("GOOGLE_AI_API_KEY");

const { handleParseJobText } = require("./parse-job-gemini");

/** Server Maps key: emulator reads `functions/.env`; production needs Secret + `secrets: []` on each callable, or legacy plain env on Cloud Run. NOT the browser key. */
function getMapsApiKey() {
  return (process.env.GOOGLE_MAPS_API_KEY || "").trim();
}

function getGoogleAiApiKey() {
  return (process.env.GOOGLE_AI_API_KEY || "").trim();
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

/**
 * Initial driver password: 6 digits (meets Firebase Auth minimum length 6).
 * Drivers replace it on first login via the portal (required flow).
 */
function generateTemporaryDriverPin() {
  return String(crypto.randomInt(100000, 1000000));
}

/** @param {import("firebase-functions/v2/https").CallableRequest} req */
async function assertOfficeOrAdmin(req) {
  if (!req.auth || !req.auth.uid) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const token = req.auth.token || {};
  const role = token.role;
  const officeId = token.officeId || null;
  if (role === "admin") {
    return { role: "admin", officeId, uid: req.auth.uid };
  }
  if (role === "office") {
    if (!officeId || typeof officeId !== "string") {
      throw new HttpsError("failed-precondition", "Office account is missing officeId.");
    }
    return { role: "office", officeId, uid: req.auth.uid };
  }
  throw new HttpsError("permission-denied", "Office or admin access required.");
}

/**
 * Office user: JWT officeId. Admin: must pass `officeId` in callable data.
 * @param {import("firebase-functions/v2/https").CallableRequest} req
 * @param {{ role: string, officeId: string|null, uid: string }} ctx
 */
function resolveOfficeIdForXero(req, ctx) {
  if (ctx.role === "office") {
    return ctx.officeId || null;
  }
  if (ctx.role === "admin") {
    const raw = (req.data || {}).officeId;
    if (raw && typeof raw === "string") return raw.trim();
    return ctx.officeId || null;
  }
  return null;
}

/**
 * @param {FirebaseFirestore.Query} q
 */
async function deleteByQueryBatches(q) {
  const col = q;
  while (true) {
    const snap = await col.limit(450).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

async function removeDriverFromCalendarDocs(officeId, driverId) {
  const snap = await db.collection("calendar").where("officeId", "==", officeId).get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const drivers = data.drivers && typeof data.drivers === "object" ? { ...data.drivers } : {};
    if (!drivers[driverId]) continue;
    delete drivers[driverId];
    let driversOff = Array.isArray(data.driversOff) ? [...data.driversOff] : [];
    driversOff = driversOff.filter((id) => id !== driverId);
    await doc.ref.set(
      { drivers, driversOff, updatedAt: now },
      { merge: true },
    );
  }
}

async function deleteDriverDaySessions(driverUid) {
  const col = db.collection("driverDaySessions");
  const prefix = `${driverUid}_`;
  while (true) {
    const snap = await col
      .orderBy(admin.firestore.FieldPath.documentId())
      .startAt(prefix)
      .endAt(prefix + "\uf8ff")
      .limit(450)
      .get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => {
      if (String(d.id).startsWith(prefix)) batch.delete(d.ref);
    });
    await batch.commit();
  }
}

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
  { region: "us-central1", cors: true, secrets: [GOOGLE_MAPS_API_KEY_SECRET] },
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
  { region: "us-central1", cors: true, secrets: [GOOGLE_MAPS_API_KEY_SECRET] },
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
    { region: "us-central1", cors: true, secrets: [GOOGLE_MAPS_API_KEY_SECRET] },
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

/* —— Driver accounts (Drivers page → createDriver / listDrivers / deleteDriver) —— */

exports.createDriver = onCall(async (req) => {
  const ctx = await assertOfficeOrAdmin(req);
  const raw = req.data || {};
  const fn = String(raw.firstName || "").trim();
  const ln = String(raw.lastName || "").trim();
  const em = String(raw.email || "").trim().toLowerCase();
  const pc = String(raw.homePostcode || "").trim();

  if (!fn || !ln || !em) {
    throw new HttpsError("invalid-argument", "firstName, lastName, and email are required.");
  }

  let targetOfficeId = ctx.officeId || null;
  if (!targetOfficeId && ctx.role === "admin") {
    targetOfficeId = raw.officeId ? String(raw.officeId).trim() : null;
  }
  if (!targetOfficeId) {
    throw new HttpsError("invalid-argument", "officeId is required.");
  }

  const temporaryPassword = generateTemporaryDriverPin();
  let uid;

  try {
    const record = await admin.auth().createUser({
      email: em,
      password: temporaryPassword,
      displayName: `${fn} ${ln}`.trim(),
    });
    uid = record.uid;
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "A user with this email already exists.");
    }
    functions.logger.error("createDriver auth failed", { message: e.message, code: e.code });
    throw new HttpsError("internal", e.message || "Could not create login.");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const userRef = db.collection("users").doc(uid);
  const driverRef = db.collection("drivers").doc(uid);

  try {
    const batch = db.batch();
    batch.set(userRef, {
      email: em,
      firstName: fn,
      lastName: ln,
      name: `${fn} ${ln}`.trim(),
      role: "driver",
      officeId: targetOfficeId,
      homePostcode: pc,
      createdAt: now,
      hasChangedPassword: 0,
      updatedAt: now,
    });
    batch.set(
      driverRef,
      {
        uid,
        firstName: fn,
        lastName: ln,
        email: em,
        homePostcode: pc,
        officeId: targetOfficeId,
        createdAt: now,
      },
      { merge: true },
    );
    await batch.commit();
  } catch (e) {
    try {
      await admin.auth().deleteUser(uid);
    } catch (_) { /* noop */ }
    functions.logger.error("createDriver Firestore failed", { message: e.message });
    throw new HttpsError("internal", e.message || "Could not save driver profile.");
  }

  return { temporaryPassword };
});

exports.listDrivers = onCall(async (req) => {
  const ctx = await assertOfficeOrAdmin(req);
  let officeId = (req.data || {}).officeId || null;
  if (!officeId) officeId = ctx.officeId;
  if (!officeId || typeof officeId !== "string") {
    throw new HttpsError("invalid-argument", "officeId is required.");
  }
  if (ctx.role === "office" && officeId !== ctx.officeId) {
    throw new HttpsError("permission-denied", "Cannot list another office's drivers.");
  }

  const snap = await db.collection("drivers").where("officeId", "==", officeId).get();
  const drivers = snap.docs.map((d) => ({ id: d.id, uid: d.id, ...d.data() }));
  return { drivers };
});

exports.deleteDriver = onCall(async (req) => {
  const ctx = await assertOfficeOrAdmin(req);
  const driverId = String((req.data || {}).driverId || "").trim();
  if (!driverId) {
    throw new HttpsError("invalid-argument", "driverId is required.");
  }

  const driverRef = db.collection("drivers").doc(driverId);
  const driverSnap = await driverRef.get();
  if (!driverSnap.exists) {
    throw new HttpsError("not-found", "Driver not found.");
  }

  const drv = driverSnap.data() || {};
  const officeId = drv.officeId || null;

  if (ctx.role === "office") {
    if (!officeId || officeId !== ctx.officeId) {
      throw new HttpsError("permission-denied", "Cannot delete a driver outside your office.");
    }
  }

  try {
    await deleteByQueryBatches(db.collection("expenseBatches").where("driverId", "==", driverId));
    await deleteByQueryBatches(db.collection("waitTimes").where("driverId", "==", driverId));
    await deleteByQueryBatches(db.collection("authorizationRequests").where("driverId", "==", driverId));
    await deleteByQueryBatches(db.collection("availabilityNotifications").where("driverId", "==", driverId));
    if (officeId) {
      await removeDriverFromCalendarDocs(officeId, driverId);
    }
    await deleteDriverDaySessions(driverId);
    await db.collection("users").doc(driverId).delete().catch(() => {});
    await driverRef.delete().catch(() => {});
    await admin.auth().deleteUser(driverId).catch((e) => {
      functions.logger.warn("deleteDriver: auth delete", { driverId, code: e.code });
    });
  } catch (e) {
    functions.logger.error("deleteDriver failed", { driverId, message: e.message });
    throw new HttpsError("internal", e.message || "Deletion failed.");
  }

  return { success: true };
});

// —— Xero (office expense transfer: create draft bills only; tokens server-side) ——

const XERO_AUTH_BASE = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
// Apps created on/after 2026-03-02 cannot use broad `accounting.transactions`; use granular scopes.
// Draft bills (ACCPAY) → accounting.invoices; chart of accounts (GET /Accounts) → accounting.settings;
// receipt uploads → accounting.attachments (PUT on Invoices/{id}/Attachments/...).
const XERO_SCOPES = [
  "offline_access",
  "accounting.invoices",
  "accounting.contacts",
  "accounting.settings",
  "accounting.attachments",
  "openid",
  "profile",
  "email",
].join(" ");

const XERO_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Gen2 callables are anonymously invokable at the Cloud Run edge like your other `onCall` functions;
 * **do not** set `invoker: "public"` here — it led to HTTP 403 on OPTIONS (no CORS headers), which Chrome reports as a CORS failure.
 * Office/admin access is still enforced via `assertOfficeOrAdmin` and the Firebase ID token on each request.
 */
const XERO_CALLABLE_OPTIONS = {
  region: "us-central1",
  cors: [
    "https://sotogroup.uk",
    "https://www.sotogroup.uk",
    "https://soto-routes.web.app",
    "https://soto-routes.firebaseapp.com",
    "http://localhost:5000",
    "http://localhost:8000",
    "http://localhost:8080",
    "http://127.0.0.1:5000",
    "http://127.0.0.1:8000",
    "http://127.0.0.1:8080",
  ],
};

function getXeroClientId() {
  return (process.env.XERO_CLIENT_ID || "").trim();
}

function getXeroClientSecret() {
  return (process.env.XERO_CLIENT_SECRET || "").trim();
}

/** Registered redirect URIs must match Xero app config exactly (no trailing slash). */
function assertAllowedXeroRedirectUri(redirectUri) {
  const u = String(redirectUri || "").trim();
  if (!u) return null;
  if (u === "https://sotogroup.uk/pages/xero-callback.html") return u;
  if (u === "https://www.sotogroup.uk/pages/xero-callback.html") return u;
  if (u === "https://soto-routes.web.app/pages/xero-callback.html") return u;
  if (u === "https://soto-routes.firebaseapp.com/pages/xero-callback.html") return u;
  if (/^http:\/\/localhost:\d+\/pages\/xero-callback\.html$/.test(u)) return u;
  return null;
}

/**
 * @param {string} officeId
 * @returns {Promise<{ refreshToken: string, accessToken: string, expiresAtMs: number, tenantId: string, tenantName?: string }>}
 */
async function loadAndRefreshXeroTokens(officeId, clientId, clientSecret) {
  const ref = db.collection("xeroOfficeTokens").doc(officeId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "Xero is not connected for this office.");
  }
  const d = snap.data() || {};
  const refreshToken = d.refreshToken;
  const tenantId = d.tenantId;
  if (!refreshToken || !tenantId) {
    throw new HttpsError("failed-precondition", "Xero connection is incomplete. Connect again.");
  }
  const now = Date.now();
  const expiresAtMs = typeof d.accessTokenExpiresAtMs === "number" ? d.accessTokenExpiresAtMs : 0;
  if (d.accessToken && expiresAtMs > now + 60_000) {
    return {
      refreshToken,
      accessToken: d.accessToken,
      expiresAtMs,
      tenantId,
      tenantName: d.tenantName || undefined,
    };
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    functions.logger.error("xero_refresh_failed", { status: res.status, text: text.slice(0, 500) });
    throw new HttpsError("internal", "Xero session expired. Disconnect and connect Xero again.");
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new HttpsError("internal", "Invalid token response from Xero.");
  }
  const newRefresh = json.refresh_token || refreshToken;
  const accessToken = json.access_token;
  const expiresIn = Number(json.expires_in) || 1800;
  const newExpiresAtMs = now + expiresIn * 1000;
  await ref.set({
    refreshToken: newRefresh,
    accessToken,
    accessTokenExpiresAtMs: newExpiresAtMs,
    tenantId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return {
    refreshToken: newRefresh,
    accessToken,
    expiresAtMs: newExpiresAtMs,
    tenantId,
    tenantName: d.tenantName || undefined,
  };
}

/** Account types Xero allows on purchase bill line items (UK charts often use OVERHEADS for nominal groups like 493). */
const XERO_BILL_LINE_ACCOUNT_TYPES = new Set(["EXPENSE", "OVERHEADS", "DIRECTCOSTS"]);

function isActiveBillLineAccount(a) {
  if (!a || String(a.Status || "").toUpperCase() !== "ACTIVE") return false;
  return XERO_BILL_LINE_ACCOUNT_TYPES.has(String(a.Type || "").toUpperCase());
}

/**
 * @param {string} accessToken
 * @param {string} tenantId
 * @param {FirebaseFirestore.DocumentData} [office] Optional; `xeroBillAccountCode` (e.g. "493") overrides name matching.
 */
async function resolveTravelNationalAccountCode(accessToken, tenantId, office) {
  const res = await fetch(`${XERO_API_BASE}/Accounts`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": tenantId,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    functions.logger.error("xero_accounts_failed", { status: res.status, text: text.slice(0, 400) });
    throw new HttpsError("internal", "Could not load Xero chart of accounts.");
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new HttpsError("internal", "Could not parse Xero chart of accounts.");
  }
  const accounts = json.Accounts || [];
  const lower = (s) => String(s || "").toLowerCase();

  const explicitRaw =
      office && office.xeroBillAccountCode != null && office.xeroBillAccountCode !== ""
        ? String(office.xeroBillAccountCode).trim()
        : "";
  if (explicitRaw) {
    const byCode = accounts.find(
        (a) => a && String(a.Code || "").trim() === explicitRaw && isActiveBillLineAccount(a),
    );
    if (byCode && byCode.Code) return String(byCode.Code);
    throw new HttpsError(
        "failed-precondition",
        `No active EXPENSE / OVERHEADS / DIRECTCOSTS account with code "${explicitRaw}" in Xero. ` +
        `Check the nominal code, or clear office field xeroBillAccountCode to use name matching instead.`,
    );
  }

  const found = accounts.find(
    (a) =>
      isActiveBillLineAccount(a) &&
      lower(a.Name).includes("travel") &&
      (lower(a.Name).includes("national") || lower(a.Name).includes("nation")),
  );
  if (found && found.Code) return String(found.Code);
  throw new HttpsError(
    "failed-precondition",
    'No active EXPENSE, OVERHEADS, or DIRECTCOSTS account found with a name like "Travel - National". ' +
    "If your nominal is under Overheads (e.g. 493), either rename it in Xero to include travel + national, " +
    "or ask support to set Firestore `offices/{officeId}.xeroBillAccountCode` to that nominal code.",
  );
}

function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Xero ACCPAY: the UI "Reference" and the draft bill browser title use `InvoiceNumber` (not `Reference`).
 * Registration only — no batch-id suffix (duplicate regs may require manual handling in Xero).
 */
function buildXeroBillInvoiceNumber(registration) {
  const reg = String(registration || "").trim().replace(/\s+/g, " ");
  return reg.slice(0, 255) || "SOTO";
}

/**
 * @param {string} batchId
 * @param {FirebaseFirestore.DocumentData} batch
 * @param {string} accountCode
 */
function buildValidatedBillLineItems(batchId, batch, accountCode) {
  const full = { id: batchId, ...batch };
  const keys = schema.getUsedLinesInOrder(full);
  const items = [];
  const linesObj = batch.lines && typeof batch.lines === "object" ? batch.lines : {};
  for (const lineKey of keys) {
    const line = linesObj[lineKey];
    if (!line) continue;
    const amt = typeof line.amount === "number" && !isNaN(line.amount) ? line.amount : 0;
    if (amt <= 0 && !schema.hasLineContent(line)) continue;
    if (amt <= 0) continue;
    const label = schema.getCategoryLabel(lineKey);
    items.push({
      Description: label,
      Quantity: 1,
      UnitAmount: Math.round(amt * 100) / 100,
      AccountCode: accountCode,
      TaxType: "NONE",
    });
  }
  return items;
}

const MAX_XERO_RECEIPT_ATTACHMENTS = 10;

/**
 * Collect up to `max` receipt photo URLs from batch lines (same line order as schema used for bills).
 * @param {string} batchId
 * @param {FirebaseFirestore.DocumentData} batch
 * @param {number} max
 * @returns {string[]}
 */
function collectReceiptPhotoUrls(batchId, batch, max) {
  const cap = typeof max === "number" && max > 0 ? max : MAX_XERO_RECEIPT_ATTACHMENTS;
  const full = { id: batchId, ...batch };
  const keys = schema.getUsedLinesInOrder(full);
  const linesObj = batch.lines && typeof batch.lines === "object" ? batch.lines : {};
  const out = [];
  for (const lineKey of keys) {
    const line = linesObj[lineKey];
    if (!line || !Array.isArray(line.photos)) continue;
    for (const p of line.photos) {
      if (typeof p === "string" && p.trim()) {
        out.push(p.trim());
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

function extensionFromContentType(contentType) {
  const c = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (c.includes("jpeg") || c === "image/jpg") return "jpg";
  if (c.includes("png")) return "png";
  if (c.includes("gif")) return "gif";
  if (c.includes("webp")) return "webp";
  if (c.includes("pdf")) return "pdf";
  return "jpg";
}

/** Xero disallows <>:"/\|?* and null in attachment filenames. */
function sanitizeXeroAttachmentFilename(name) {
  return String(name || "receipt")
      .replace(/[\u0000<>:"/\\|?*+]/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 200);
}

/**
 * Upload receipt images to a draft invoice/bill. Best-effort: logs and skips failures.
 * @returns {number} count successfully attached
 */
async function uploadReceiptAttachmentsToXeroInvoice({ accessToken, tenantId, invoiceId, photoUrls }) {
  const list = Array.isArray(photoUrls) ? photoUrls.slice(0, MAX_XERO_RECEIPT_ATTACHMENTS) : [];
  let uploaded = 0;
  for (let i = 0; i < list.length; i++) {
    const url = list[i];
    try {
      const getRes = await fetch(url, { redirect: "follow" });
      if (!getRes.ok) {
        functions.logger.warn("xero_receipt_fetch_failed", { invoiceId, index: i, status: getRes.status });
        continue;
      }
      const buf = Buffer.from(await getRes.arrayBuffer());
      if (!buf.length) continue;
      if (buf.length > 10 * 1024 * 1024) {
        functions.logger.warn("xero_receipt_too_large", { invoiceId, index: i, bytes: buf.length });
        continue;
      }
      const ctRaw = getRes.headers.get("content-type") || "";
      const ext = extensionFromContentType(ctRaw);
      const fname = sanitizeXeroAttachmentFilename(`receipt-${String(i + 1).padStart(2, "0")}.${ext}`);
      const putPath = `${XERO_API_BASE}/Invoices/${invoiceId}/Attachments/${encodeURIComponent(fname)}`;
      const contentType =
        ctRaw && !ctRaw.toLowerCase().includes("application/octet-stream") && ctRaw.toLowerCase().startsWith("image/")
          ? ctRaw.split(";")[0].trim()
          : "application/octet-stream";
      const putRes = await fetch(putPath, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Xero-tenant-id": tenantId,
          "Content-Type": contentType,
          Accept: "application/json",
        },
        body: buf,
      });
      if (!putRes.ok) {
        const errText = await putRes.text();
        functions.logger.warn("xero_receipt_upload_failed", {
          invoiceId,
          fname,
          status: putRes.status,
          text: errText.slice(0, 400),
        });
        continue;
      }
      uploaded += 1;
    } catch (e) {
      functions.logger.warn("xero_receipt_attachment_error", { invoiceId, index: i, message: e.message });
    }
  }
  return uploaded;
}

exports.xeroGetAuthorizationUrl = onCall(
    XERO_CALLABLE_OPTIONS,
    async (req) => {
      const ctx = await assertOfficeOrAdmin(req);
      const officeId = resolveOfficeIdForXero(req, ctx);
      if (!officeId) {
        throw new HttpsError("invalid-argument", "officeId is required (admins must pass officeId when connecting Xero).");
      }
      if (ctx.role === "office" && ctx.officeId !== officeId) {
        throw new HttpsError("permission-denied", "Office mismatch.");
      }
      const redirectUri = assertAllowedXeroRedirectUri((req.data || {}).redirectUri);
      if (!redirectUri) {
        throw new HttpsError(
            "invalid-argument",
            "Invalid redirect URI. Use https://sotogroup.uk/pages/xero-callback.html (or localhost callback) registered in your Xero app.",
        );
      }
      const clientId = getXeroClientId();
      if (!clientId) {
        throw new HttpsError(
            "failed-precondition",
            "Xero is not configured: set XERO_CLIENT_ID (and XERO_CLIENT_SECRET for token exchange) on Cloud Functions environment variables.",
        );
      }
      const state = crypto.randomBytes(24).toString("hex");
      const stateRef = db.collection("xeroOAuthStates").doc(state);
      await stateRef.set({
        officeId,
        uid: ctx.uid,
        redirectUri,
        createdAtMs: Date.now(),
      });
      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: XERO_SCOPES,
        state,
      });
      const url = `${XERO_AUTH_BASE}?${params.toString()}`;
      return { url, state };
    },
);

exports.xeroExchangeCode = onCall(
    XERO_CALLABLE_OPTIONS,
    async (req) => {
      const ctx = await assertOfficeOrAdmin(req);
      const { code, state } = req.data || {};
      if (!code || !state) {
        throw new HttpsError("invalid-argument", "Missing code or state.");
      }
      const stateRef = db.collection("xeroOAuthStates").doc(String(state));
      const stateSnap = await stateRef.get();
      if (!stateSnap.exists) {
        throw new HttpsError("invalid-argument", "OAuth state expired or invalid. Try connecting again.");
      }
      const st = stateSnap.data() || {};
      if (st.uid !== ctx.uid) {
        throw new HttpsError("permission-denied", "OAuth state does not match the signed-in user.");
      }
      if (ctx.role === "office" && st.officeId !== ctx.officeId) {
        throw new HttpsError("permission-denied", "OAuth state does not match your office.");
      }
      if (Date.now() - (st.createdAtMs || 0) > XERO_OAUTH_STATE_TTL_MS) {
        await stateRef.delete().catch(() => {});
        throw new HttpsError("deadline-exceeded", "OAuth state expired. Try connecting again.");
      }
      const redirectUri = st.redirectUri;
      const clientId = getXeroClientId();
      const clientSecret = getXeroClientSecret();
      if (!clientId || !clientSecret) {
        throw new HttpsError("failed-precondition", "Xero client ID or secret is not configured on the server.");
      }
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        redirect_uri: String(redirectUri),
      });
      const res = await fetch(XERO_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const text = await res.text();
      if (!res.ok) {
        functions.logger.error("xero_exchange_failed", { status: res.status, text: text.slice(0, 500) });
        throw new HttpsError("internal", "Could not complete Xero sign-in. Check redirect URI matches Xero app.");
      }
      let tokenJson;
      try {
        tokenJson = JSON.parse(text);
      } catch (e) {
        throw new HttpsError("internal", "Invalid token response from Xero.");
      }
      const refreshToken = tokenJson.refresh_token;
      const accessToken = tokenJson.access_token;
      const expiresIn = Number(tokenJson.expires_in) || 1800;
      if (!refreshToken || !accessToken) {
        throw new HttpsError("internal", "Xero did not return tokens.");
      }
      const connRes = await fetch("https://api.xero.com/connections", {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      const connText = await connRes.text();
      if (!connRes.ok) {
        functions.logger.error("xero_connections_failed", { status: connRes.status, text: connText.slice(0, 400) });
        throw new HttpsError("internal", "Could not read Xero organisations.");
      }
      const connections = JSON.parse(connText);
      const first = Array.isArray(connections) && connections[0] ? connections[0] : null;
      if (!first || !first.tenantId) {
        throw new HttpsError("failed-precondition", "No Xero organisation linked to this login.");
      }
      const tenantId = first.tenantId;
      const tenantName = first.tenantName || "";
      const targetOfficeId = st.officeId;
      if (!targetOfficeId || typeof targetOfficeId !== "string") {
        throw new HttpsError("internal", "OAuth state is missing office id.");
      }
      if (ctx.role === "admin") {
        const requested = resolveOfficeIdForXero(req, ctx);
        if (requested && requested !== targetOfficeId) {
          throw new HttpsError("permission-denied", "officeId does not match the Xero connect request.");
        }
      }
      const nowMs = Date.now();
      const tokenDoc = db.collection("xeroOfficeTokens").doc(targetOfficeId);
      await tokenDoc.set({
        refreshToken,
        accessToken,
        accessTokenExpiresAtMs: nowMs + expiresIn * 1000,
        tenantId,
        tenantName,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await db.doc(`offices/${targetOfficeId}`).set({
        xeroTenantName: tenantName,
        xeroConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await stateRef.delete().catch(() => {});
      return { ok: true, tenantName };
    },
);

exports.xeroDisconnect = onCall(
    XERO_CALLABLE_OPTIONS,
    async (req) => {
      const ctx = await assertOfficeOrAdmin(req);
      const officeId = resolveOfficeIdForXero(req, ctx);
      if (!officeId) {
        throw new HttpsError("invalid-argument", "officeId is required.");
      }
      if (ctx.role === "office" && ctx.officeId !== officeId) {
        throw new HttpsError("permission-denied", "Office mismatch.");
      }
      await db.collection("xeroOfficeTokens").doc(officeId).delete().catch(() => {});
      await db.doc(`offices/${officeId}`).set({
        xeroTenantName: admin.firestore.FieldValue.delete(),
        xeroConnectedAt: admin.firestore.FieldValue.delete(),
      }, { merge: true });
      return { ok: true };
    },
);

exports.xeroCreateDraftBillsForBatches = onCall(
    XERO_CALLABLE_OPTIONS,
    async (req) => {
      const ctx = await assertOfficeOrAdmin(req);
      const officeId = resolveOfficeIdForXero(req, ctx);
      if (!officeId) {
        throw new HttpsError("invalid-argument", "officeId is required.");
      }
      if (ctx.role === "office" && ctx.officeId !== officeId) {
        throw new HttpsError("permission-denied", "Cannot post expenses for another office.");
      }
      const batchIds = (req.data || {}).batchIds;
      if (!Array.isArray(batchIds) || batchIds.length === 0) {
        throw new HttpsError("invalid-argument", "batchIds must be a non-empty array.");
      }

      const officeSnap = await db.doc(`offices/${officeId}`).get();
      if (!officeSnap.exists) {
        throw new HttpsError("not-found", "Office not found.");
      }
      const office = officeSnap.data() || {};
      if (!office.xeroExpenseIntegrationEnabled) {
        throw new HttpsError(
            "failed-precondition",
            "Xero expense integration is off for this office.",
        );
      }

      const clientId = getXeroClientId();
      const clientSecret = getXeroClientSecret();
      if (!clientId || !clientSecret) {
        throw new HttpsError("failed-precondition", "Xero client ID or secret is not configured on the server.");
      }
      const tokens = await loadAndRefreshXeroTokens(officeId, clientId, clientSecret);
      const accountCode = await resolveTravelNationalAccountCode(tokens.accessToken, tokens.tenantId, office);

      const results = [];
      for (const rawId of batchIds) {
        const batchId = String(rawId || "").trim();
        if (!batchId) continue;
        const bref = db.collection("expenseBatches").doc(batchId);
        try {
          const bsnap = await bref.get();
          if (!bsnap.exists) {
            results.push({ batchId, ok: false, error: "Batch not found" });
            continue;
          }
          const batch = bsnap.data() || {};
          if (batch.officeId !== officeId) {
            results.push({ batchId, ok: false, error: "Office mismatch" });
            continue;
          }
          if (batch.status !== "validated") {
            results.push({ batchId, ok: false, error: "Batch must be in validated status" });
            continue;
          }
          if (batch.xeroBillSynced === true) {
            results.push({
              batchId,
              ok: true,
              skipped: true,
              invoiceId: batch.xeroInvoiceId || batch.xeroDraftBillId || null,
            });
            continue;
          }
          const existingId = batch.xeroInvoiceId || batch.xeroDraftBillId;
          if (existingId) {
            await bref.set(
                {
                  xeroBillSynced: true,
                  xeroInvoiceId: existingId,
                  xeroSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
                  xeroSyncedBy: ctx.uid,
                  xeroSyncError: admin.firestore.FieldValue.delete(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true },
            );
            results.push({ batchId, ok: true, skipped: true, invoiceId: existingId });
            continue;
          }

          const lineItems = buildValidatedBillLineItems(batchId, batch, accountCode);
          if (!lineItems.length) {
            results.push({ batchId, ok: false, error: "Batch has no billable line amounts" });
            continue;
          }

          const driver = (batch.driverName && String(batch.driverName).trim()) || "Driver";
          const reg = (batch.registration && String(batch.registration).trim()) || "";
          const today = new Date();
          const due = new Date(today);
          due.setDate(due.getDate() + 1);

          const invoicePayload = {
            Type: "ACCPAY",
            Contact: { Name: driver },
            Date: formatYmd(today),
            DueDate: formatYmd(due),
            Status: "DRAFT",
            LineAmountTypes: "NoTax",
            InvoiceNumber: buildXeroBillInvoiceNumber(reg),
            LineItems: lineItems,
          };

          const invRes = await fetch(`${XERO_API_BASE}/Invoices?SummarizeErrors=false`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`,
              "Xero-tenant-id": tokens.tenantId,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ Invoices: [invoicePayload] }),
          });
          const invText = await invRes.text();
          if (!invRes.ok) {
            functions.logger.error("xero_invoice_create_failed", {
              batchId,
              status: invRes.status,
              text: invText.slice(0, 800),
            });
            results.push({ batchId, ok: false, error: "xero_api_error", detail: invText.slice(0, 200) });
            continue;
          }
          let invJson;
          try {
            invJson = JSON.parse(invText);
          } catch (e) {
            results.push({ batchId, ok: false, error: "invalid_xero_response" });
            continue;
          }
          const created = (invJson.Invoices && invJson.Invoices[0]) || null;
          const xeroInvoiceId = created && created.InvoiceID ? created.InvoiceID : null;
          if (!xeroInvoiceId) {
            results.push({ batchId, ok: false, error: "no_invoice_id" });
            continue;
          }

          const photoUrls = collectReceiptPhotoUrls(batchId, batch, MAX_XERO_RECEIPT_ATTACHMENTS);
          let xeroAttachmentsUploaded = 0;
          if (photoUrls.length) {
            xeroAttachmentsUploaded = await uploadReceiptAttachmentsToXeroInvoice({
              accessToken: tokens.accessToken,
              tenantId: tokens.tenantId,
              invoiceId: xeroInvoiceId,
              photoUrls,
            });
          }

          await bref.set(
              {
                xeroBillSynced: true,
                xeroInvoiceId: xeroInvoiceId,
                xeroDraftBillId: admin.firestore.FieldValue.delete(),
                xeroDraftBillNumber: created.InvoiceNumber || null,
                xeroSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
                xeroSyncedBy: ctx.uid,
                xeroSyncError: admin.firestore.FieldValue.delete(),
                xeroAttachmentsUploaded,
                xeroAttachmentsAttempted: photoUrls.length,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true },
          );
          results.push({ batchId, ok: true, invoiceId: xeroInvoiceId, attachmentsUploaded: xeroAttachmentsUploaded });
        } catch (err) {
          functions.logger.error("xeroCreateDraftBillsForBatches batch error", batchId, err);
          const msg = err && err.message ? err.message : String(err);
          try {
            await bref.set(
                {
                  xeroSyncError: msg.slice(0, 1200),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true },
            );
          } catch (e) {
            /* ignore */
          }
          results.push({ batchId, ok: false, error: msg });
        }
      }

      const okCount = results.filter((r) => r.ok).length;
      return { results, okCount, total: results.length };
    },
);

/**
 * Parse messy transport job text (Asana title/notes/custom fields or manual paste) via Gemini 2.
 * Secret: `firebase functions:secrets:set GOOGLE_AI_API_KEY` (GCP key with Gemini API enabled;
 * if the console requires it, bind the key to your Cloud Functions service account first).
 * Response: `{ success, parsed_data }` with reg_number, collection_address, postcode_delivery, price,
 * return_reg, return_postcode, confidence_scores, overall_confidence.
 */
exports.parseJobText = onCall(
  { region: "us-central1", cors: true, secrets: [GOOGLE_AI_API_KEY_SECRET] },
  async (request) => {
    const apiKey = getGoogleAiApiKey();
    return handleParseJobText(apiKey, request.data || {});
  },
);