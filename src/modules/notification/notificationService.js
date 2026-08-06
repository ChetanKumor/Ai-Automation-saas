'use strict';

const db = require('../../db/db');
const logger = require('../../infra/logging/logger');
const whatsappService = require('../channels/whatsapp/sender');
const configService = require('../config/configService');
const { normalizePhone } = require('../../utils/phone');

// Same IST convention as reminderCron.js:147 — 'en-IN' + Asia/Kolkata, dateStyle
// 'full' and timeStyle 'short'. The only difference is that this message splits
// the two halves onto their own labelled lines (a receptionist scans them; a
// reminder reads as a sentence). Deliberately NOT a second convention: swap the
// two calls for one toLocaleString and you get reminderCron's exact string.
const IST = 'Asia/Kolkata';
const LOCALE = 'en-IN';

// ── The probe guard ──────────────────────────────────────────────────────────
// A property on the TENANT COPY handed to the brain that suppresses owner alerts
// outright — no send, on any path, whatever the config or the column says.
//
// It exists because the recipient moved from `tenants.owner_notify_phone` (a
// column, which a caller could neutralise by copying the tenant object and
// nulling it) to `config.notifications.owner_numbers` (read from the database by
// tenant id, which a tenant copy CANNOT neutralise). scriptedTurnCheck relied on
// the old property to stop a synthetic booking paging a real clinic owner; that
// defence had to move with the recipient or validation — which every clinic runs
// immediately before go-live — would WhatsApp the owner an appointment for
// "Zyon Validation Probe".
//
// The constant is exported and imported by the probe rather than spelled out
// there, so a rename cannot silently unhook the guard. `tests/lifecycle/
// lifecycle.integration.test.js` fails if the flag stops being honoured: it
// spies the sender across a real scripted-turn validation run.
const SUPPRESS_OWNER_ALERTS = 'suppress_owner_alerts';

// Display form for a phone already stored in canonical E.164 (INV-6). Every
// write path normalises (identityService.js:24, customerService.js:5), so this
// is a no-op in practice; it exists so an alert built from a legacy or
// hand-inserted row is still rendered in one consistent shape. A value that
// cannot be normalised is shown VERBATIM rather than rewritten into a plausible
// different number (F-003b) — and never dropped, because a phone the
// receptionist can read and retype beats no alert at all.
function displayPhone(raw) {
  if (!raw) return null;
  try {
    return normalizePhone(raw);
  } catch (err) {
    logger.warn({ scope: 'notification', err: err.message }, 'patient phone is not E.164 — rendering verbatim');
    return String(raw);
  }
}

// Who gets the booking alert.
//
// B1 single source of truth: `config.notifications.owner_numbers[0]`.
// `tenants.owner_notify_phone` is a DEPRECATED FALLBACK, read only when the
// array is empty and logged as such when it fires. The column is untouched
// elsewhere and stays live for owner-command authentication
// (whatsapp/routes.js:97), the human-handoff forward (:163,168) and the
// notify_owner workflow action (core/coreActions.js) — none of which are
// notification recipients, and none of which B1 goes near.
//
// FILED, NOT BUILT: owner_numbers is an array and only [0] is notified. Fan-out
// to every entry when a clinic asks for it.
function ownerRecipient(tenant, config) {
  const numbers = config?.notifications?.owner_numbers;
  if (Array.isArray(numbers) && numbers.length) {
    return { phone: numbers[0], source: 'config' };
  }
  if (tenant.owner_notify_phone) {
    return { phone: tenant.owner_notify_phone, source: 'legacy_column' };
  }
  return { phone: null, source: 'none' };
}

// One instant, three renderings, all on the shared IST convention above. The
// booking alert SPLITS date and time onto their own labelled lines; a move does
// NOT, because a move is read by comparing two instants and two four-line blocks
// would make the receptionist diff eight fields to see what changed. `istFull`
// is the two halves recombined in one call — reminderCron.js:147's exact string.
const istDate = (d) => d.toLocaleDateString(LOCALE, { timeZone: IST, dateStyle: 'full' });
const istTime = (d) => d.toLocaleTimeString(LOCALE, { timeZone: IST, timeStyle: 'short' });
const istFull = (d) => d.toLocaleString(LOCALE, { timeZone: IST, dateStyle: 'full', timeStyle: 'short' });

const instant = (raw) => {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
};

// The message. Read on a phone by a receptionist mid-shift, so: six labelled
// lines, one fact each, in the order they are acted on — who, how to reach them,
// when, and what state the booking is in. The doctor rides the title line, which
// keeps the required fields contiguous and scannable.
//
// THREE SHAPES, ONE FUNCTION (B2, then B2-R1). A booking says "New appointment";
// a MOVE says "Appointment moved" and replaces Date/Time with Was/Now; a CANCEL
// says "Appointment cancelled" and carries a single `Freed:` line. That
// distinction is not cosmetic: a reschedule renders a new row whose status is
// 'booked', so without it a move would arrive looking exactly like a fresh
// booking — the receptionist would not know a slot had just freed, and could
// reasonably conclude the patient had booked twice. `Was:` is the field that
// carries the freed slot, which is why it leads.
//
// `status` renders from the appointments column, never a literal, on ALL THREE
// shapes. On a move it reads 'booked' — correctly, because the row it describes
// is the new one. The superseded row is what carries 'rescheduled', and nobody
// is alerted about that row. On a cancel it reads 'cancelled' straight off the
// UPDATE's own RETURNING, which is why that shape needed no new status handling.
function formatOwnerBookingAlert(bookingResult, customer = null) {
  const name = bookingResult.patient_name || customer?.name || 'Patient';
  const phone = displayPhone(customer?.phone) || 'not on file';
  const doctor = bookingResult.doctor || 'the clinic';
  const status = bookingResult.status || 'booked';

  const now = instant(bookingResult.appointment_time);

  // B2-R1. A cancellation is DECLARED by its own flag, on B2's rule — never
  // inferred from `status`, because a malformed or missing field must not
  // silently downgrade a cancellation into a booking confirmation. It leads the
  // dispatch because it is the destructive one.
  //
  // `Freed:` is the whole point of this shape. The receptionist's actionable
  // fact is not that a cancellation happened — it is WHICH SLOT JUST OPENED, so
  // they can re-fill it. Same recombined IST instant the move's Was:/Now: uses.
  if (bookingResult.cancelled) {
    return [
      `Appointment cancelled — ${doctor}`,
      `Patient: ${name}`,
      `Phone: ${phone}`,
      `Freed: ${now ? istFull(now) : (bookingResult.time || 'unknown')}`,
      `Status: ${status}`,
    ].join('\n');
  }

  // A move is DECLARED, never inferred from the presence of a previous
  // timestamp: a malformed `previous_appointment_time` must not silently
  // downgrade a move into a "New appointment" alert, which is the exact
  // confusion this branch exists to prevent.
  if (bookingResult.rescheduled) {
    const was = instant(bookingResult.previous_appointment_time);
    return [
      `Appointment moved — ${doctor}`,
      `Patient: ${name}`,
      `Phone: ${phone}`,
      `Was: ${was ? istFull(was) : (bookingResult.previous_time || 'unknown')}`,
      `Now: ${now ? istFull(now) : (bookingResult.time || 'unknown')}`,
      `Status: ${status}`,
    ].join('\n');
  }

  // `time` (the pre-rendered 'en-IN' full+short string) is the fallback when the
  // raw timestamp is absent — the same instant, unsplit, rather than a blank.
  const dateLine = now ? istDate(now) : (bookingResult.time || 'unknown');
  const timeLine = now ? istTime(now) : (bookingResult.time || 'unknown');

  return [
    `New appointment with ${doctor}`,
    `Patient: ${name}`,
    `Phone: ${phone}`,
    `Date: ${dateLine}`,
    `Time: ${timeLine} IST`,
    `Status: ${status}`,
  ].join('\n');
}

// Alert the clinic owner that a booking just landed — or that one just moved, or
// that one was just cancelled. ONE function and ONE notification type for all
// three. `type` stays 'appointment_booked' on a move and on a cancel,
// deliberately: scriptedTurnCheck identifies the probe's own notifications by an
// ID DIFF scoped to exactly that type, and re-counts residue with the same
// predicate. A second type would be invisible to both, so the probe would leave a
// row behind AND report a clean zero — a leak its own leak-detector could not see.
//
// `customer` is the hydrated customers row the turn already holds (identityService
// returns `RETURNING *` / `SELECT *` on every path), threaded in so the patient's
// phone can appear here WITHOUT widening bookAppointment's return — that return is
// serialised into the model's tool-response, so a phone added there would enter
// Gemini's context and could be read back to the caller.
//
// Fire-and-forget from aiService (`.catch()`, never awaited), so the config read
// is off the turn's critical path. Every exit writes a sent_status: a skip that
// leaves no trace is indistinguishable from a bug.
async function notifyOwnerOfBooking(tenant, bookingResult, customer = null) {
  const content = formatOwnerBookingAlert(bookingResult, customer);

  const { rows: [notif] } = await db.query(
    `INSERT INTO notifications (tenant_id, type, content, sent_status)
     VALUES ($1, 'appointment_booked', $2, 'pending') RETURNING id`,
    [tenant.id, content]
  );

  const mark = (status) =>
    db.query('UPDATE notifications SET sent_status = $1 WHERE id = $2', [status, notif.id]);

  // FIRST, before the config is even read: a suppressed tenant copy can reach no
  // recipient by any path. The row is still written so the probe's id-diff
  // cleanup finds it exactly as before.
  if (tenant[SUPPRESS_OWNER_ALERTS]) {
    await mark('suppressed');
    logger.info({ tenantId: tenant.id }, 'owner alert suppressed — synthetic turn');
    return;
  }

  let config = null;
  try {
    config = await configService.getTenantConfig(tenant.id);
  } catch (err) {
    // Degrade to the deprecated column rather than lose the alert.
    logger.error({ tenantId: tenant.id, err: err.message }, 'config read failed — owner alert falls back to the legacy column');
  }

  // on_booking has been in the schema since Issue 8 and was read by nothing.
  // Honoured here. Absent config (legacy tenant, no config row) means "not
  // configured", which defaults.js:89 defines as true.
  if (config?.notifications?.on_booking === false) {
    await mark('skipped_disabled');
    logger.info({ tenantId: tenant.id }, 'owner alert disabled by config — notifications.on_booking is false');
    return;
  }

  const { phone, source } = ownerRecipient(tenant, config);
  if (!phone) {
    await mark('no_phone');
    logger.info({ tenantId: tenant.id, businessName: tenant.business_name }, 'no owner notification number — skipped WhatsApp');
    return;
  }
  if (source === 'legacy_column') {
    logger.warn({ tenantId: tenant.id },
      'notifications.owner_numbers is empty — falling back to the DEPRECATED tenants.owner_notify_phone column');
  }

  try {
    await whatsappService.sendMessage(tenant, phone, content);
    await mark('sent');
    logger.info({ tenantId: tenant.id, source }, 'owner notified');
  } catch (err) {
    const metaError = err.response?.data?.error;
    const isWindowError = metaError?.code === 131047 || metaError?.error_subcode === 131047;
    const status = isWindowError ? 'failed_window' : 'failed';
    await mark(status);
    logger.error({ tenantId: tenant.id, status, err: metaError?.message || err.message }, 'owner alert failed');
  }
}

module.exports = {
  notifyOwnerOfBooking,
  SUPPRESS_OWNER_ALERTS,
  // exported for a focused render test — pure, no DB, no network.
  formatOwnerBookingAlert,
};
