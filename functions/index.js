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
 * Set secret: `firebase functions:secrets:set GOOGLE_MAPS_API_KEY` (paste a key with Distance Matrix + Directions APIs enabled;
 * Application restrictions: None; API restrictions: restrict to those APIs only.)
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

/**
 * Parse transit leg into step list for the optimisation UI.
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
      const mode = vtype === "BUS" ? "BUS" : "TRAIN";
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
 * Longer drive → mode "transit" (public transport duration + steps) when a transit route exists.
 * Optional: set TAXI_MAX_DRIVE_MIN in functions/.env (default 18).
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
      return {
        success: true,
        duration: transitMins,
        mode: "transit",
        allSteps: transitLegToSteps(transitLeg),
        drivingDurationMinutes: drivingMins,
        transitDurationMinutes: transitMins,
        taxiMaxDriveMinutes: taxiMaxDriveMin,
      };
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
