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

async function bookAppointment(tenantId, customerId, doctorName, appointmentTime, patientName) {
  const timeIST = appointmentTime.includes('+') ? appointmentTime : appointmentTime + '+05:30';
  const apptDate = new Date(timeIST);
  if (isNaN(apptDate)) return { success: false, reason: 'invalid_time', error: 'Invalid appointment time format.' };

  const now = new Date();
  if (apptDate < now) return { success: false, reason: 'past', error: 'Cannot book in the past.' };

  const dateStr = apptDate.toLocaleDateString('en-CA', { timeZone: IST });
  const slotTime = apptDate.toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit' });
  const dayName = DAY_NAMES[dayOfWeekIST(dateStr)];

  // ── F-006: the clinic's own rules, before any doctor is even considered ────
  // Same resolution and same evaluator checkAvailability used to decide what to
  // offer, so the two sides cannot disagree.
  const rules = await resolveBookingRules(tenantId);
  const day = evaluateDay(dateStr, rules, todayIST());
  if (day.reject) return { success: false, ...day.reject };

  if (slotTime < day.window.open || slotTime >= day.window.close) {
    return {
      success: false, reason: 'outside_hours', open: day.window.open, close: day.window.close,
      error: `The clinic is open ${day.window.open}–${day.window.close} on ${dayName}. ${slotTime} is outside opening hours.`,
    };
  }

  if (apptDate.getTime() < now.getTime() + rules.bufferMinutes * 60000) {
    return {
      success: false, reason: 'too_soon', buffer_minutes: rules.bufferMinutes,
      error: `Appointments need at least ${rules.bufferMinutes} minute(s) notice. ${slotTime} is too soon — offer a later slot.`,
    };
  }

  const schedules = await getSchedules(tenantId);
  const nameLC = doctorName.toLowerCase();
  const sched = schedules.find(s => s.doctor === doctorName)
    || schedules.find(s => nameLC.includes(s.doctor.toLowerCase().replace('dr. ', '')))
    || schedules.find(s => s.doctor.toLowerCase().includes(nameLC.replace('dr. ', '')));
  if (!sched) {
    const available = schedules.map(s => s.doctor).join(', ');
    return { success: false, reason: 'doctor_not_found', error: `Doctor "${doctorName}" not found. Available: ${available}` };
  }
  doctorName = sched.doctor;
  if (!sched.days.includes(dayName)) {
    return { success: false, reason: 'doctor_day_off', error: `${doctorName} does not work on ${dayName}.` };
  }

  if (slotTime < sched.start || slotTime >= sched.end) {
    return { success: false, reason: 'outside_doctor_hours', error: `${doctorName} works ${sched.start}–${sched.end}. ${slotTime} is outside hours.` };
  }

  // Grid alignment (V-008): uniq_doctor_slot only blocks EXACT-timestamp
  // collisions, so an off-grid time (10:07 against a 30-min grid) inserts
  // cleanly and overlaps a neighbouring booking. Reject off-grid times with a
  // tool-friendly error and let the LLM re-offer real slots — never snap the
  // caller's requested time silently. Grid derivation is shared with
  // checkAvailability, so this only bounces model drift / races.
  const slotMinutes = rules.slotMinutes;
  if (!isOnGrid(slotTime, sched.start, slotMinutes)) {
    return {
      success: false,
      reason: 'off_grid',
      error: `${slotTime} is not on the schedule grid (${slotMinutes}-minute slots starting ${sched.start}). Offer the caller the nearest available slots from check_availability.`,
    };
  }

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
      [tenantId, customerId, doctorName, timeIST]
    );

    const confirmTime = new Date(appt.appointment_time)
      .toLocaleString('en-IN', { timeZone: IST, dateStyle: 'full', timeStyle: 'short' });

    return {
      success: true,
      appointment_id: appt.id,
      doctor: appt.doctor_name,
      time: confirmTime,
      patient_name: patientName
    };
  } catch (err) {
    if (err.code === '23505') {
      return { success: false, reason: 'slot_taken', error: 'That slot was just booked by someone else. Please pick another.' };
    }
    throw err;
  }
}

module.exports = {
  checkAvailability, bookAppointment, getSchedules,
  // exported for tests / grid-parity coverage (V-008). The F-006 rules are
  // covered through checkAvailability/bookAppointment themselves — testing the
  // public surface is what proves both sides actually agree.
  generateSlots, resolveSlotMinutes, isOnGrid,
};
