const db = require('../../db/db');

const IST = 'Asia/Kolkata';

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

  const results = [];
  for (const sched of schedules) {
    if (!sched.days.includes(dayName)) continue;

    const allSlots = generateSlots(sched.start, sched.end, sched.slot_minutes);

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

module.exports = { checkAvailability, bookAppointment, getSchedules };
