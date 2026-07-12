const db = require('../../db/db');
const configService = require('../config/configService');
const { clinicDefaults } = require('../config/defaults');
const logger = require('../../infra/logging/logger');

const IST = 'Asia/Kolkata';

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// The booking slot grid (minutes) for a tenant — the SINGLE source shared by
// checkAvailability (which slots to offer) and bookAppointment (which times to
// accept). Sourced from config.booking.slot_minutes; a configless tenant or a
// stale doc missing the field falls back to clinicDefaults with a
// config_fallback WARN (the V-002 pattern). The two callers MUST resolve the
// grid the same way — a slot we never offered must never book (V-008).
async function resolveSlotMinutes(tenantId) {
  const config = await configService.getTenantConfig(tenantId);
  const slot = config?.booking?.slot_minutes;
  if (Number.isInteger(slot) && slot > 0) return slot;

  const fallback = clinicDefaults.booking.slot_minutes;
  logger.warn(
    { scope: 'config_fallback', tenant_id: tenantId, slot_minutes: fallback,
      reason: config === null ? 'no_config' : 'field_missing' },
    'booking.slot_minutes missing from tenant config — using clinicDefaults'
  );
  return fallback;
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

function nowHHMM() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit' });
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

async function checkAvailability(tenantId, dateStr) {
  const schedules = await getSchedules(tenantId);
  if (!schedules.length) return { error: 'No doctor schedules configured.' };

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const parts = dateStr.split('-');
  if (parts.length !== 3 || parts.some(p => isNaN(Number(p)))) {
    return { error: 'Invalid date format. Use YYYY-MM-DD.' };
  }

  const today = todayIST();
  if (dateStr < today) return { error: 'That date is in the past.' };

  const dayName = dayNames[dayOfWeekIST(dateStr)];
  const isToday = dateStr === today;
  const currentTime = isToday ? nowHHMM() : '00:00';

  // Grid size from config (V-008): the SAME source bookAppointment validates
  // against, so every slot offered here is a slot booking will accept.
  const slotMinutes = await resolveSlotMinutes(tenantId);

  const results = [];
  for (const sched of schedules) {
    if (!sched.days.includes(dayName)) continue;

    const allSlots = generateSlots(sched.start, sched.end, slotMinutes);

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

    const free = allSlots.filter(s => s >= currentTime && !bookedSet.has(s));
    results.push({ doctor: sched.doctor, date: dateStr, day: dayName, free_slots: free });
  }

  if (!results.length) {
    const workingDoctors = schedules.map(s => `${s.doctor} (${s.days.join(', ')})`).join('; ');
    return { error: `No doctors work on ${dayName}. Schedules: ${workingDoctors}` };
  }

  return { available: results };
}

async function bookAppointment(tenantId, customerId, doctorName, appointmentTime, patientName) {
  const timeIST = appointmentTime.includes('+') ? appointmentTime : appointmentTime + '+05:30';
  const apptDate = new Date(timeIST);
  if (isNaN(apptDate)) return { success: false, error: 'Invalid appointment time format.' };

  const nowUTC = new Date();
  if (apptDate < nowUTC) return { success: false, error: 'Cannot book in the past.' };

  const dateStr = apptDate.toLocaleDateString('en-CA', { timeZone: IST });
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = dayNames[dayOfWeekIST(dateStr)];

  const schedules = await getSchedules(tenantId);
  const nameLC = doctorName.toLowerCase();
  const sched = schedules.find(s => s.doctor === doctorName)
    || schedules.find(s => nameLC.includes(s.doctor.toLowerCase().replace('dr. ', '')))
    || schedules.find(s => s.doctor.toLowerCase().includes(nameLC.replace('dr. ', '')));
  if (!sched) {
    const available = schedules.map(s => s.doctor).join(', ');
    return { success: false, error: `Doctor "${doctorName}" not found. Available: ${available}` };
  }
  doctorName = sched.doctor;
  if (!sched.days.includes(dayName)) return { success: false, error: `${doctorName} does not work on ${dayName}.` };

  const slotTime = apptDate.toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit' });
  if (slotTime < sched.start || slotTime >= sched.end) {
    return { success: false, error: `${doctorName} works ${sched.start}–${sched.end}. ${slotTime} is outside hours.` };
  }

  // Grid alignment (V-008): uniq_doctor_slot only blocks EXACT-timestamp
  // collisions, so an off-grid time (10:07 against a 30-min grid) inserts
  // cleanly and overlaps a neighbouring booking. Reject off-grid times with a
  // tool-friendly error and let the LLM re-offer real slots — never snap the
  // caller's requested time silently. Grid derivation is shared with
  // checkAvailability, so this only bounces model drift / races.
  const slotMinutes = await resolveSlotMinutes(tenantId);
  if (!isOnGrid(slotTime, sched.start, slotMinutes)) {
    return {
      success: false,
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
      return { success: false, error: 'That slot was just booked by someone else. Please pick another.' };
    }
    throw err;
  }
}

module.exports = {
  checkAvailability, bookAppointment, getSchedules,
  // exported for tests / grid-parity coverage (V-008)
  generateSlots, resolveSlotMinutes, isOnGrid,
};
