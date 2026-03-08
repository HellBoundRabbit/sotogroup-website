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
        } else {
        if (state.emailSentAt) {
          await stateRef.set({
            emailSentAt: null,
            lastOverdueCount: 0,
            lastCheckedAt: now,
          }, { merge: true });
        }
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
