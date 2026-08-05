const db = require('../../db/db');
const configService = require('../config/configService');
const { clinicDefaults } = require('../config/defaults');
const logger = require('../../infra/logging/logger');

const IST = 'Asia/Kolkata';

// Weekday lookups, both indexed by getUTCDay() (0 = Sunday). DAY_KEYS addresses
// config.hours (lowercase keys); DAY_NAMES addresses the doctor schedule's
// `days` array and is what we say back to the caller.
const DAY_KEYS  = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// The tenant's booking rules (F-006) — the SINGLE resolution shared by
// checkAvailability (which slots to offer) and bookAppointment (which times to
// accept). Sourced from config.booking.* + config.hours.*; a configless tenant
// or a stale doc missing a field falls back to clinicDefaults with ONE
// config_fallback WARN naming every field that fell back (the V-002 pattern).
// The two callers MUST resolve rules the same way — a slot we never offered
// must never book (V-008), and a slot we offer must never be refused (F-006).
async function resolveBookingRules(tenantId) {
  const config = await configService.getTenantConfig(tenantId);
  const d = clinicDefaults.booking;

  const missing = [];
  const fellBack = {};
  const take = (value, ok, field, fallback) => {
    if (ok(value)) return value;
    missing.push(field);
    fellBack[field] = fallback;
    return fallback;
  };
  const posInt = (v) => Number.isInteger(v) && v > 0;
  const nonNegInt = (v) => Number.isInteger(v) && v >= 0;

  const rules = {
    slotMinutes:    take(config?.booking?.slot_minutes,   posInt,                       'slot_minutes',   d.slot_minutes),
    advanceDays:    take(config?.booking?.advance_days,   posInt,                       'advance_days',   d.advance_days),
    bufferMinutes:  take(config?.booking?.buffer_minutes, nonNegInt,                    'buffer_minutes', d.buffer_minutes),
    allowSameDay:   take(config?.booking?.allow_same_day, (v) => typeof v === 'boolean', 'allow_same_day', d.allow_same_day),
    hours:          config?.hours && typeof config.hours === 'object' ? config.hours : null,
  };
  if (!rules.hours) { rules.hours = clinicDefaults.hours; missing.push('hours'); }

  if (missing.length) {
    logger.warn(
      { scope: 'config_fallback', tenant_id: tenantId, missing, ...fellBack,
        reason: config === null ? 'no_config' : 'field_missing' },
      'booking rules missing from tenant config — using clinicDefaults'
    );
  }
  return rules;
}

// Back-compat shim: the grid alone. Prefer resolveBookingRules — resolving both
// separately in one operation would emit the fallback WARN twice.
async function resolveSlotMinutes(tenantId) {
  return (await resolveBookingRules(tenantId)).slotMinutes;
}

// The day's opening window from config.hours, or null when the clinic is shut.
// Per-day defensive fallback: getTenantConfig never throws on a stale document,
// so an unusable day entry (neither union branch) resolves to the clinicDefaults
// day rather than silently reading as "open all hours".
function dayWindow(hours, dayKey) {
  const entry = hours && hours[dayKey];
  const usable = (v) => v && typeof v === 'object' && (
    v.closed === true ||
    (typeof v.open === 'string' && typeof v.close === 'string' && v.open < v.close)
  );
  const day = usable(entry) ? entry : clinicDefaults.hours[dayKey];
  return day.closed === true ? null : { open: day.open, close: day.close };
}

function findHoliday(hours, dateStr) {
  const list = Array.isArray(hours?.holidays) ? hours.holidays : [];
  return list.find((h) => h && h.date === dateStr) || null;
}

// Calendar arithmetic in the pure-date frame (no timezone drift): parse the
// clinic-local YYYY-MM-DD as a UTC midnight, shift whole days, format back.
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Grid alignment in the tenant timezone frame. `slotTime` and `start` are both
// IST wall-clock 'HH:MM' — the frame the schedule is expressed in and the frame
// checkAvailability offers slots in (a stored timestamptz is reconverted to IST
// before this check). A time is on-grid iff it is an exact slotMinutes multiple
// from the schedule start. Range ([start, end)) is enforced by the caller's
// hours check; this is purely the grid-step test. Reject, never snap (V-008).
function isOnGrid(slotTime, start, slotMinutes) {
  return (hhmmToMinutes(slotTime) - hhmmToMinutes(start)) % slotMinutes === 0;
}

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: IST });
}

function generateSlots(start, end, minutes) {
  const slots = [];
  let [h, m] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  while (h < endH || (h === endH && m < endM)) {
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    m += minutes;
    if (m >= 60) { h += Math.floor(m / 60); m %= 60; }
  }
  return slots;
}

async function getSchedules(tenantId) {
  const { rows } = await db.query(
    "SELECT data FROM tenant_entities WHERE tenant_id = $1 AND type = 'schedule'",
    [tenantId]
  );
  return rows.map(r => r.data);
}

function dayOfWeekIST(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// ── F-006: booking rules, decided once and applied on BOTH sides ─────────────
// Rejections carry a machine-readable `reason` alongside the sentence, so the
// receptionist can explain the refusal and offer an alternative instead of
// reporting a generic failure. The rules are enforced structurally here — never
// by asking the model to behave.

// The calendar questions for one clinic-local date, in refusal-priority order:
// the most specific, most actionable reason wins. Returns { window } when the
// date is bookable (the day's opening hours), else { reject }.
function evaluateDay(dateStr, rules, today) {
  if (dateStr < today) {
    return { reject: { reason: 'past_date', error: 'That date is in the past.' } };
  }
  if (dateStr === today && !rules.allowSameDay) {
    const earliest = addDays(today, 1);
    return { reject: {
      reason: 'same_day_not_allowed', earliest_date: earliest,
      error: `Same-day appointments are not available. The earliest bookable date is ${earliest}.`,
    } };
  }
  const latest = addDays(today, rules.advanceDays);
  if (dateStr > latest) {
    return { reject: {
      reason: 'beyond_advance_window', advance_days: rules.advanceDays, latest_bookable_date: latest,
      error: `Bookings open only ${rules.advanceDays} day(s) ahead — the latest bookable date is ${latest}.`,
    } };
  }
  const holiday = findHoliday(rules.hours, dateStr);
  if (holiday) {
    return { reject: {
      reason: 'holiday', date: dateStr, holiday_name: holiday.name || null,
      error: `The clinic is closed on ${dateStr}${holiday.name ? ` (${holiday.name})` : ''}.`,
    } };
  }
  const dow = dayOfWeekIST(dateStr);
  const window = dayWindow(rules.hours, DAY_KEYS[dow]);
  if (!window) {
    return { reject: {
      reason: 'closed_day', day: DAY_NAMES[dow],
      error: `The clinic is closed on ${DAY_NAMES[dow]}.`,
    } };
  }
  return { window };
}

// The earliest bookable moment — now + buffer_minutes — expressed as a
// clinic-local { date, time } pair at MINUTE granularity, which is the
// granularity the slot grid works in.
//
// `now` is rounded UP to the next whole minute before the buffer is added. That
// makes this cutoff never later than the write path's exact-instant comparison,
// which is what keeps the two sides in parity: every slot we offer is a slot the
// write accepts. (Rounding DOWN was the pre-existing divergence — at 10:00:45
// the 10:00 slot was offered and then refused as past.)
function bookingCutoff(bufferMinutes) {
  const ceilMinute = Math.ceil(Date.now() / 60000) * 60000;
  const at = new Date(ceilMinute + bufferMinutes * 60000);
  return {
    date: at.toLocaleDateString('en-CA', { timeZone: IST }),
    time: at.toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit' }),
  };
}

// Is a clinic-local date+slot at or after the cutoff?
function atOrAfterCutoff(dateStr, slotTime, cutoff) {
  if (dateStr !== cutoff.date) return dateStr > cutoff.date;
  return slotTime >= cutoff.time;
}

async function checkAvailability(tenantId, dateStr) {
  const parts = String(dateStr || '').split('-');
  if (parts.length !== 3 || parts.some(p => isNaN(Number(p)))) {
    return { reason: 'invalid_date', error: 'Invalid date format. Use YYYY-MM-DD.' };
  }

  // Rules from config (V-008 + F-006): the SAME resolution bookAppointment
  // validates against, so every slot offered here is a slot booking accepts.
  const rules = await resolveBookingRules(tenantId);

  // Calendar rules first — a closed day, a holiday or an out-of-window date has
  // no slots to compute, and the caller deserves the real reason, not "none free".
  const day = evaluateDay(dateStr, rules, todayIST());
  if (day.reject) return day.reject;

  const schedules = await getSchedules(tenantId);
  if (!schedules.length) return { reason: 'no_schedules', error: 'No doctor schedules configured.' };

  const dayName = DAY_NAMES[dayOfWeekIST(dateStr)];
  const cutoff = bookingCutoff(rules.bufferMinutes);
  const slotMinutes = rules.slotMinutes;

  const results = [];
  for (const sched of schedules) {
    if (!sched.days.includes(dayName)) continue;

    // Offer the INTERSECTION of the doctor's schedule and the clinic's opening
    // hours. The grid stays anchored at sched.start — the anchor isOnGrid uses —
    // so clipping to clinic hours can never offer an off-grid time.
    const end = sched.end < day.window.close ? sched.end : day.window.close;
    const allSlots = generateSlots(sched.start, end, slotMinutes)
      .filter(s => s >= day.window.open);

    const { rows: booked } = await db.query(
      `SELECT appointment_time FROM appointments
       WHERE tenant_id = $1 AND doctor_name = $2
       AND appointment_time >= $3 AND appointment_time < $4
       AND status = 'booked'`,
      [tenantId, sched.doctor, dateStr + 'T00:00:00+05:30', dateStr + 'T23:59:59+05:30']
    );

    const bookedSet = new Set(booked.map(b =>
      new Date(b.appointment_time).toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit' })
    ));

    // now + buffer_minutes (F-006), shared with the write path.
    const free = allSlots.filter(s => atOrAfterCutoff(dateStr, s, cutoff) && !bookedSet.has(s));
    results.push({ doctor: sched.doctor, date: dateStr, day: dayName, free_slots: free });
  }

  if (!results.length) {
    const workingDoctors = schedules.map(s => `${s.doctor} (${s.days.join(', ')})`).join('; ');
    return { reason: 'no_doctors_on_day', error: `No doctors work on ${dayName}. Schedules: ${workingDoctors}` };
  }

  return { available: results };
}

// The pre-rendered confirmation string: 'en-IN' + IST, full date + short time in
// ONE call — reminderCron.js:147's exact convention.
function confirmString(raw) {
  return new Date(raw).toLocaleString('en-IN', { timeZone: IST, dateStyle: 'full', timeStyle: 'short' });
}

// ── The write-path validator (B2) ────────────────────────────────────────────
// Gates 1–10 of what used to live inline in bookAppointment, extracted VERBATIM
// so that booking and RESCHEDULING cannot diverge. There is exactly one
// validation path in this module:
//
//   bookAppointment       = validateSlot + INSERT
//   rescheduleAppointment = validateSlot + (INSERT new, supersede old), in one
//                           transaction
//
// A second copy of these rules is precisely how a reschedule would book a
// holiday, an off-grid time or a slot beyond the advance window by the back
// door. The extraction is BEHAVIOUR-PRESERVING: every reason code, every error
// sentence and every ordering below is unchanged, which is why the pre-existing
// booking tests pass untouched.
//
// Returns { reject } — the same { reason, error, ...fields } object the callers
// spread into their own { success: false, ... } — or { timeIST, doctorName },
// the two derived values an INSERT needs. `doctorName` is the CANONICAL name off
// the matched schedule, not the model's spelling of it.
//
// Two things deliberately stay with the callers: the patient-name backfill
// (bookAppointment only — it is not a validation), and the 23505 recovery, which
// can only be written where the INSERT is.
async function validateSlot(tenantId, doctorName, appointmentTime) {
  const timeIST = appointmentTime.includes('+') ? appointmentTime : appointmentTime + '+05:30';
  const apptDate = new Date(timeIST);
  if (isNaN(apptDate)) return { reject: { reason: 'invalid_time', error: 'Invalid appointment time format.' } };

  const now = new Date();
  if (apptDate < now) return { reject: { reason: 'past', error: 'Cannot book in the past.' } };

  const dateStr = apptDate.toLocaleDateString('en-CA', { timeZone: IST });
  const slotTime = apptDate.toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit' });
  const dayName = DAY_NAMES[dayOfWeekIST(dateStr)];

  // ── F-006: the clinic's own rules, before any doctor is even considered ────
  // Same resolution and same evaluator checkAvailability used to decide what to
  // offer, so the two sides cannot disagree.
  const rules = await resolveBookingRules(tenantId);
  const day = evaluateDay(dateStr, rules, todayIST());
  if (day.reject) return { reject: day.reject };

  if (slotTime < day.window.open || slotTime >= day.window.close) {
    return { reject: {
      reason: 'outside_hours', open: day.window.open, close: day.window.close,
      error: `The clinic is open ${day.window.open}–${day.window.close} on ${dayName}. ${slotTime} is outside opening hours.`,
    } };
  }

  if (apptDate.getTime() < now.getTime() + rules.bufferMinutes * 60000) {
    return { reject: {
      reason: 'too_soon', buffer_minutes: rules.bufferMinutes,
      error: `Appointments need at least ${rules.bufferMinutes} minute(s) notice. ${slotTime} is too soon — offer a later slot.`,
    } };
  }

  const schedules = await getSchedules(tenantId);
  const nameLC = doctorName.toLowerCase();
  const sched = schedules.find(s => s.doctor === doctorName)
    || schedules.find(s => nameLC.includes(s.doctor.toLowerCase().replace('dr. ', '')))
    || schedules.find(s => s.doctor.toLowerCase().includes(nameLC.replace('dr. ', '')));
  if (!sched) {
    const available = schedules.map(s => s.doctor).join(', ');
    return { reject: { reason: 'doctor_not_found', error: `Doctor "${doctorName}" not found. Available: ${available}` } };
  }
  const canonical = sched.doctor;
  if (!sched.days.includes(dayName)) {
    return { reject: { reason: 'doctor_day_off', error: `${canonical} does not work on ${dayName}.` } };
  }

  if (slotTime < sched.start || slotTime >= sched.end) {
    return { reject: { reason: 'outside_doctor_hours', error: `${canonical} works ${sched.start}–${sched.end}. ${slotTime} is outside hours.` } };
  }

  // Grid alignment (V-008): uniq_doctor_slot only blocks EXACT-timestamp
  // collisions, so an off-grid time (10:07 against a 30-min grid) inserts
  // cleanly and overlaps a neighbouring booking. Reject off-grid times with a
  // tool-friendly error and let the LLM re-offer real slots — never snap the
  // caller's requested time silently. Grid derivation is shared with
  // checkAvailability, so this only bounces model drift / races.
  const slotMinutes = rules.slotMinutes;
  if (!isOnGrid(slotTime, sched.start, slotMinutes)) {
    return { reject: {
      reason: 'off_grid',
      error: `${slotTime} is not on the schedule grid (${slotMinutes}-minute slots starting ${sched.start}). Offer the caller the nearest available slots from check_availability.`,
    } };
  }

  return { timeIST, doctorName: canonical };
}

async function bookAppointment(tenantId, customerId, doctorName, appointmentTime, patientName) {
  const slot = await validateSlot(tenantId, doctorName, appointmentTime);
  if (slot.reject) return { success: false, ...slot.reject };

  if (patientName) {
    await db.query(
      "UPDATE customers SET name = $1 WHERE id = $2 AND (name IS NULL OR name = '')",
      [patientName, customerId]
    );
  }

  try {
    const { rows: [appt] } = await db.query(
      `INSERT INTO appointments (tenant_id, customer_id, doctor_name, appointment_time, status)
       VALUES ($1, $2, $3, $4, 'booked')
       RETURNING id, doctor_name, appointment_time, status`,
      [tenantId, customerId, slot.doctorName, slot.timeIST]
    );

    // `appointment_time` and `status` come straight off the INSERT's own
    // RETURNING — both were already fetched and dropped, so surfacing them costs
    // no extra read. The owner alert needs the raw instant to render date and
    // time as separate fields, and needs `status` to be the COLUMN rather than a
    // literal so it stays honest as the column's domain widens.
    //
    // This object is serialised into the model's tool-response, so what it may
    // carry is a real constraint: a timestamp and a status say nothing the model
    // could not already say from `time`, which has always been here. The patient's
    // phone is deliberately NOT added — see notificationService's header.
    return {
      success: true,
      appointment_id: appt.id,
      doctor: appt.doctor_name,
      time: confirmString(appt.appointment_time),
      appointment_time: appt.appointment_time,
      status: appt.status,
      patient_name: patientName
    };
  } catch (err) {
    if (err.code === '23505') {
      return { success: false, reason: 'slot_taken', error: 'That slot was just booked by someone else. Please pick another.' };
    }
    throw err;
  }
}

// ── B2: moving an existing appointment ───────────────────────────────────────

// The caller's own upcoming bookings, soonest first. Tenant- AND customer-scoped,
// so this can only ever return rows belonging to the person on the phone.
async function upcomingAppointments(tenantId, customerId) {
  const { rows } = await db.query(
    `SELECT id, doctor_name, appointment_time FROM appointments
     WHERE tenant_id = $1 AND customer_id = $2 AND status = 'booked'
       AND appointment_time > NOW()
     ORDER BY appointment_time ASC`,
    [tenantId, customerId]
  );
  return rows;
}

// The refusal that IS the lookup. There is no separate list tool and no guess at
// "the nearest appointment": an ambiguous reference is answered with the caller's
// real bookings so the receptionist can ask which one they mean. Inventing the
// answer here is the same failure class as inventing a price.
function appointmentNotFound(upcoming) {
  const list = upcoming.map((a) => ({ doctor: a.doctor_name, time: confirmString(a.appointment_time) }));
  const error = list.length
    ? `No appointment of theirs matches that time. They currently have: ` +
      `${list.map((a) => `${a.doctor} on ${a.time}`).join('; ')}. ` +
      `Ask which one they mean and confirm it before moving anything — never guess.`
    : 'This caller has no upcoming appointments to move.';
  return { success: false, reason: 'appointment_not_found', appointments: list, error };
}

/**
 * Move an existing appointment to a new time.
 *
 * WHICH appointment is resolved SERVER-SIDE from (tenant_id, customer_id,
 * appointment_time) — the model never handles an appointment id, and none is
 * returned to it. Same discipline that kept the patient's phone out of
 * bookAppointment's return: an identifier the model can read back to a caller
 * eventually will be.
 *
 * `doctorName` is optional and means "also change doctor"; omitted, the
 * appointment keeps the one it has.
 *
 * The new time goes through validateSlot — the SAME gates a fresh booking
 * clears. There is no back door.
 */
async function rescheduleAppointment(tenantId, customerId, currentTime, newTime, doctorName) {
  const currentRaw = String(currentTime || '');
  const currentIST = currentRaw.includes('+') ? currentRaw : currentRaw + '+05:30';
  const currentDate = new Date(currentIST);

  const upcoming = await upcomingAppointments(tenantId, customerId);
  const existing = isNaN(currentDate.getTime())
    ? null
    : upcoming.find((a) => new Date(a.appointment_time).getTime() === currentDate.getTime());
  if (!existing) return appointmentNotFound(upcoming);

  const slot = await validateSlot(tenantId, doctorName || existing.doctor_name, newTime);
  if (slot.reject) return { success: false, ...slot.reject };

  // Moving to the slot it already occupies. Caught here rather than left to
  // uniq_doctor_slot, which would raise 23505 against the appointment's OWN row
  // and report `slot_taken` — technically true and actively misleading, since
  // the someone-else who took it is them.
  if (slot.doctorName === existing.doctor_name &&
      new Date(slot.timeIST).getTime() === new Date(existing.appointment_time).getTime()) {
    return {
      success: false, reason: 'same_slot',
      error: 'That is the time they already have — there is nothing to move. Confirm the appointment stands as booked.',
    };
  }

  // ── One transaction, one connection, INSERT FIRST ──────────────────────────
  // Two pooled db.query calls would be two independent transactions on two
  // connections, and the failure mode is not theoretical: release the old slot,
  // lose the race on the new one, and the patient is left holding NO appointment
  // at all. Inserting first means a 23505 on the new slot rolls back with their
  // ORIGINAL appointment untouched.
  //
  // "Threw" must mean "committed nothing", because aiService's point of no
  // return (aiService.js:240-243) flips only AFTER executeTool returns — a
  // guarantee that holds today only because booking is a single INSERT.
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: [appt] } = await client.query(
      `INSERT INTO appointments (tenant_id, customer_id, doctor_name, appointment_time, status)
       VALUES ($1, $2, $3, $4, 'booked')
       RETURNING id, doctor_name, appointment_time, status`,
      [tenantId, customerId, slot.doctorName, slot.timeIST]
    );

    // Supersede the old row. Guarded on `status = 'booked'` so a concurrent move
    // or cancellation of the SAME appointment loses cleanly instead of both
    // writers believing they moved it: rowCount 0 means someone got there first,
    // and the whole transaction goes back.
    const { rowCount } = await client.query(
      `UPDATE appointments SET status = 'rescheduled'
       WHERE id = $1 AND tenant_id = $2 AND status = 'booked'`,
      [existing.id, tenantId]
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return {
        success: false, reason: 'appointment_changed',
        error: 'That appointment was just changed by someone else. Check what the caller currently has before moving it again.',
      };
    }

    await client.query('COMMIT');

    // No appointment_id: see the header. `previous_appointment_time` is the raw
    // instant the owner alert needs to render "Was:"; `previous_time` is its
    // pre-rendered form and the fallback when the raw value cannot be parsed.
    // Both describe a time the caller themselves supplied, so neither tells the
    // model anything it did not already have.
    return {
      success: true,
      rescheduled: true,
      doctor: appt.doctor_name,
      time: confirmString(appt.appointment_time),
      appointment_time: appt.appointment_time,
      previous_time: confirmString(existing.appointment_time),
      previous_appointment_time: existing.appointment_time,
      status: appt.status,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Preserved VERBATIM from bookAppointment: this recovery is the only thing
    // standing between two concurrent writers and a double-book.
    if (err.code === '23505') {
      return { success: false, reason: 'slot_taken', error: 'That slot was just booked by someone else. Please pick another.' };
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  checkAvailability, bookAppointment, rescheduleAppointment, getSchedules,
  // exported for tests / grid-parity coverage (V-008). The F-006 rules are
  // covered through checkAvailability/bookAppointment themselves — testing the
  // public surface is what proves both sides actually agree.
  generateSlots, resolveSlotMinutes, isOnGrid,
  // B2: the single validation path, exported so a test can prove there is only
  // one and that both write entry points reach it.
  validateSlot, upcomingAppointments,
};
