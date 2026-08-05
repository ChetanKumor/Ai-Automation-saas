'use strict';

// B2 — moving an appointment. Option C: the move writes a NEW row with status
// 'booked' and flips the OLD row to 'rescheduled'.
//
// Everything here runs against a REAL throwaway scratch database with REAL
// INSERTs, because the claims worth making are claims about uniq_doctor_slot —
// a partial unique index on `status = 'booked'` — and an index is not proven by
// inspecting it. The freed-slot proof is another patient actually booking the
// vacated time.
//
// Disjoint DB-name prefix (zyon_rs_) so no other suite's sweep drops it mid-run.
// Skips when DATABASE_URL is unset. Nothing here reaches the network.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { clinicDefaults } = require('../../src/modules/config/defaults');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_rs_';
const IST = 'Asia/Kolkata';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_rs\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// A clinic-local date N days out, plus the ISO instant for an IST wall-clock time
// on it. Every fixture below opens the clinic seven days a week and gives the
// doctor all seven days, so no test here can inherit TEST-FLAKE-03's class of
// calendar dependence.
const dateIn = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: IST });
const at = (date, hhmm) => `${date}T${hhmm}:00+05:30`;

describe('reschedule (integration)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, appointments, notifications, configService, sender, reminderCron;
  let seq = 0;
  let sends = [];
  let spy;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    process.env.DATABASE_URL = scratchCs;
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');
    appointments = require('../../src/modules/appointment/appointmentService');
    notifications = require('../../src/modules/notification/notificationService');
    configService = require('../../src/modules/config/configService');
    sender = require('../../src/modules/channels/whatsapp/sender');
    reminderCron = require('../../src/scheduler/reminderCron');
  });

  after(async () => {
    process.env.DATABASE_URL = ADMIN;
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  beforeEach(() => {
    sends = [];
    spy = mock.method(sender, 'sendMessage', async (_t, to, text) => { sends.push({ to, text }); return 'wamid.spy'; });
  });
  afterEach(() => { if (spy) spy.mock.restore(); });

  // A clinic open every day 09:00–18:00 on a 30-minute grid, with one doctor
  // working all seven days. `booking` and `hours` are overridable per test — the
  // refusal cases are exactly the cases that need a narrower clinic.
  const OPEN = { open: '09:00', close: '18:00' };
  async function makeTenant({ booking = {}, holidays = [], reminderHours = 240 } = {}) {
    const n = ++seq;
    const { rows: [t] } = await db.query(
      `INSERT INTO tenants (business_name, slug, phone_number_id, wa_token, active,
                            reminders_enabled, reminder_hours_before)
       VALUES ($1,$2,$3,'tok',true,true,$4) RETURNING *`,
      ['Move Dental', `rs-${n}-${crypto.randomBytes(3).toString('hex')}`, 'rs-pnid-' + n, reminderHours]);

    await db.query(
      "INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1,'schedule',$2)",
      [t.id, JSON.stringify({
        doctor: 'Dr. Rao', days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        start: '09:00', end: '18:00', slot_minutes: 30,
      })]);

    // `hours` is REPLACED wholesale, never key-merged: each day is a
    // discriminated union ({closed:true} XOR {open,close}).
    const doc = structuredClone(clinicDefaults);
    doc.booking = { ...doc.booking, slot_minutes: 30, advance_days: 365, buffer_minutes: 0, allow_same_day: true, ...booking };
    doc.hours = { ...Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(d => [d, OPEN])), holidays };
    doc.notifications = { owner_numbers: ['+919000000001'], on_booking: true, on_escalation: true };
    await db.query('INSERT INTO tenant_configs (tenant_id, version, config) VALUES ($1,1,$2)',
      [t.id, JSON.stringify(doc)]);
    configService.invalidateConfigCache(t.id);
    return t;
  }

  async function makeCustomer(tenantId, phone, name) {
    const { rows: [c] } = await db.query(
      'INSERT INTO customers (tenant_id, phone, name) VALUES ($1,$2,$3) RETURNING *',
      [tenantId, phone, name]);
    return c;
  }

  const apptRows = async (tenantId) => (await db.query(
    `SELECT id, customer_id, doctor_name, appointment_time, status,
            reminder_status, reminder_sent, reminder_sent_at, reminder_attempts, last_attempt_at
     FROM appointments WHERE tenant_id = $1 ORDER BY created_at`, [tenantId])).rows;

  const notifRows = async (tenantId) => (await db.query(
    'SELECT type, content, sent_status FROM notifications WHERE tenant_id = $1', [tenantId])).rows;

  // ── 1. The uniqueness proof ─────────────────────────────────────────────────

  it('after a move the OLD slot is bookable again — by a DIFFERENT patient, with a real INSERT', async () => {
    const t = await makeTenant();
    const priya = await makeCustomer(t.id, '+919812345678', 'Priya');
    const ravi = await makeCustomer(t.id, '+919812345679', 'Ravi');

    const day = dateIn(3);
    const OLD = at(day, '10:00');
    const NEW = at(day, '14:00');

    const booked = await appointments.bookAppointment(t.id, priya.id, 'Dr. Rao', OLD, 'Priya');
    assert.equal(booked.success, true);

    // Before the move, that slot is taken — proving the index is doing its job
    // and that the freed-slot assertion below is not vacuous.
    const blocked = await appointments.bookAppointment(t.id, ravi.id, 'Dr. Rao', OLD, 'Ravi');
    assert.equal(blocked.success, false);
    assert.equal(blocked.reason, 'slot_taken');

    const moved = await appointments.rescheduleAppointment(t.id, priya.id, OLD, NEW);
    assert.equal(moved.success, true, moved.error);
    assert.equal(moved.rescheduled, true);
    assert.equal(moved.status, 'booked', 'the row the patient now holds is booked');

    // THE PROOF: a real INSERT by someone else into the vacated slot.
    const reused = await appointments.bookAppointment(t.id, ravi.id, 'Dr. Rao', OLD, 'Ravi');
    assert.equal(reused.success, true, `the freed slot must be bookable: ${reused.error}`);

    const rows = await apptRows(t.id);
    assert.equal(rows.length, 3, 'superseded + moved + the new patient in the freed slot');
    const superseded = rows.find(r => r.status === 'rescheduled');
    assert.ok(superseded, 'the old row survives, marked as moved rather than deleted');
    assert.equal(superseded.customer_id, priya.id);
    assert.equal(new Date(superseded.appointment_time).getTime(), new Date(OLD).getTime(),
      'and it still records the ORIGINAL time — the dispute is settled with a row');
    assert.equal(rows.filter(r => r.status === 'booked').length, 2);
  });

  it('the NEW slot is protected the moment the move commits — double-booking stays impossible', async () => {
    const t = await makeTenant();
    const priya = await makeCustomer(t.id, '+919812345678', 'Priya');
    const ravi = await makeCustomer(t.id, '+919812345679', 'Ravi');

    const day = dateIn(4);
    await appointments.bookAppointment(t.id, priya.id, 'Dr. Rao', at(day, '10:00'), 'Priya');
    const moved = await appointments.rescheduleAppointment(t.id, priya.id, at(day, '10:00'), at(day, '15:30'));
    assert.equal(moved.success, true, moved.error);

    const clash = await appointments.bookAppointment(t.id, ravi.id, 'Dr. Rao', at(day, '15:30'), 'Ravi');
    assert.equal(clash.success, false);
    assert.equal(clash.reason, 'slot_taken');

    // And a second patient cannot MOVE into it either — the reschedule path hits
    // the same index, through the same recovery.
    await appointments.bookAppointment(t.id, ravi.id, 'Dr. Rao', at(day, '16:00'), 'Ravi');
    const moveClash = await appointments.rescheduleAppointment(t.id, ravi.id, at(day, '16:00'), at(day, '15:30'));
    assert.equal(moveClash.success, false);
    assert.equal(moveClash.reason, 'slot_taken');

    // Ravi still has his original 16:00 — a refused move changes nothing.
    const ravis = (await apptRows(t.id)).filter(r => r.customer_id === ravi.id && r.status === 'booked');
    assert.equal(ravis.length, 1);
    assert.equal(new Date(ravis[0].appointment_time).getTime(), new Date(at(day, '16:00')).getTime());
  });

  // ── 2. No back door: the move clears every gate a booking clears ────────────

  it('refuses an OFF-GRID new time, leaving the original intact', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(day, '10:00'), 'Priya');

    const r = await appointments.rescheduleAppointment(t.id, c.id, at(day, '10:00'), at(day, '14:07'));
    assert.equal(r.success, false);
    assert.equal(r.reason, 'off_grid');
    await assertUnmoved(t.id, c.id, at(day, '10:00'));
  });

  it('refuses a PAST new time, leaving the original intact', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(day, '10:00'), 'Priya');

    const r = await appointments.rescheduleAppointment(t.id, c.id, at(day, '10:00'), at(dateIn(-2), '10:00'));
    assert.equal(r.success, false);
    assert.equal(r.reason, 'past');
    await assertUnmoved(t.id, c.id, at(day, '10:00'));
  });

  it('refuses a new time BEYOND advance_days, leaving the original intact', async () => {
    const t = await makeTenant({ booking: { advance_days: 5 } });
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(day, '10:00'), 'Priya');

    const r = await appointments.rescheduleAppointment(t.id, c.id, at(day, '10:00'), at(dateIn(30), '10:00'));
    assert.equal(r.success, false);
    assert.equal(r.reason, 'beyond_advance_window');
    assert.equal(r.advance_days, 5, 'the refusal carries the rule that produced it');
    await assertUnmoved(t.id, c.id, at(day, '10:00'));
  });

  it('refuses a new time on a HOLIDAY, leaving the original intact', async () => {
    const shut = dateIn(6);
    const t = await makeTenant({ holidays: [{ date: shut, name: 'Ganesh Chaturthi' }] });
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(day, '10:00'), 'Priya');

    const r = await appointments.rescheduleAppointment(t.id, c.id, at(day, '10:00'), at(shut, '10:00'));
    assert.equal(r.success, false);
    assert.equal(r.reason, 'holiday');
    assert.equal(r.holiday_name, 'Ganesh Chaturthi');
    await assertUnmoved(t.id, c.id, at(day, '10:00'));
  });

  it('moving to the slot it already occupies is refused as same_slot, not a misleading slot_taken', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(day, '10:00'), 'Priya');

    const r = await appointments.rescheduleAppointment(t.id, c.id, at(day, '10:00'), at(day, '10:00'));
    assert.equal(r.success, false);
    assert.equal(r.reason, 'same_slot', 'the "someone else" who took it would have been them');
    await assertUnmoved(t.id, c.id, at(day, '10:00'));
  });

  // Every refusal above must leave EXACTLY one row, still booked, still at the
  // original time. A reschedule that half-happens is worse than one that fails.
  async function assertUnmoved(tenantId, customerId, originalIso) {
    const rows = (await apptRows(tenantId)).filter(r => r.customer_id === customerId);
    assert.equal(rows.length, 1, 'a refused move writes no row at all');
    assert.equal(rows[0].status, 'booked');
    assert.equal(new Date(rows[0].appointment_time).getTime(), new Date(originalIso).getTime());
  }

  // ── 3. The lookup IS the error ──────────────────────────────────────────────

  it('appointment_not_found lists the caller’s real upcoming appointments', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const d1 = dateIn(3), d2 = dateIn(5);
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(d1, '10:00'), 'Priya');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(d2, '11:30'), 'Priya');

    const r = await appointments.rescheduleAppointment(t.id, c.id, at(dateIn(9), '10:00'), at(dateIn(10), '10:00'));
    assert.equal(r.success, false);
    assert.equal(r.reason, 'appointment_not_found');
    assert.equal(r.appointments.length, 2, 'both of theirs, so the model can ask which');
    assert.deepEqual(r.appointments.map(a => a.doctor), ['Dr. Rao', 'Dr. Rao']);

    // Soonest first, and rendered in the same IST convention the alert uses.
    const expected = new Date(at(d1, '10:00'))
      .toLocaleString('en-IN', { timeZone: IST, dateStyle: 'full', timeStyle: 'short' });
    assert.equal(r.appointments[0].time, expected);
    assert.match(r.error, /never guess/, 'the refusal tells the model not to invent one');
    assert.ok(r.error.includes(expected), 'and states them, so the error IS the lookup');
  });

  it('never returns another customer’s appointment, and says so plainly when there are none', async () => {
    const t = await makeTenant();
    const priya = await makeCustomer(t.id, '+919812345678', 'Priya');
    const ravi = await makeCustomer(t.id, '+919812345679', 'Ravi');
    const day = dateIn(3);
    await appointments.bookAppointment(t.id, priya.id, 'Dr. Rao', at(day, '10:00'), 'Priya');

    // Ravi asks to move Priya's slot. It is not his to move.
    const r = await appointments.rescheduleAppointment(t.id, ravi.id, at(day, '10:00'), at(day, '14:00'));
    assert.equal(r.success, false);
    assert.equal(r.reason, 'appointment_not_found');
    assert.deepEqual(r.appointments, [], 'no cross-customer leakage');
    assert.match(r.error, /no upcoming appointments/);
    await assertUnmoved(t.id, priya.id, at(day, '10:00'));
  });

  it('no appointment id is returned to the model on either the success or the refusal path', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(day, '10:00'), 'Priya');

    const ok = await appointments.rescheduleAppointment(t.id, c.id, at(day, '10:00'), at(day, '14:00'));
    assert.equal(ok.success, true, ok.error);
    assert.ok(!('appointment_id' in ok), 'an identifier the model can read back to a caller eventually will be');
    assert.ok(!JSON.stringify(ok).includes('-4'), 'no UUID anywhere in the tool response');

    const miss = await appointments.rescheduleAppointment(t.id, c.id, at(dateIn(9), '10:00'), at(dateIn(10), '10:00'));
    assert.ok(!JSON.stringify(miss).includes('-4'), 'nor in the refusal that lists their appointments');
  });

  // ── 4. Reminder state ───────────────────────────────────────────────────────

  it('the moved row starts at reminder defaults; the superseded row keeps its history untouched', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(day, '10:00'), 'Priya');

    // A reminder already went out for the OLD time. Under option C nothing has to
    // reset it: the new row is a new row.
    await db.query(
      `UPDATE appointments SET reminder_status='sent', reminder_sent=true,
              reminder_sent_at=NOW(), reminder_attempts=2, last_attempt_at=NOW()
       WHERE tenant_id=$1`, [t.id]);

    const moved = await appointments.rescheduleAppointment(t.id, c.id, at(day, '10:00'), at(day, '14:00'));
    assert.equal(moved.success, true, moved.error);

    const rows = await apptRows(t.id);
    const old = rows.find(r => r.status === 'rescheduled');
    const fresh = rows.find(r => r.status === 'booked');

    assert.equal(old.reminder_status, 'sent', 'the old row truthfully records that a reminder WAS sent');
    assert.equal(old.reminder_attempts, 2);
    assert.ok(old.reminder_sent_at, 'and when');

    assert.equal(fresh.reminder_status, 'pending', 'the new row is at column defaults — nothing to reset');
    assert.equal(fresh.reminder_sent, false);
    assert.equal(fresh.reminder_sent_at, null);
    assert.equal(fresh.reminder_attempts, 0);
    assert.equal(fresh.last_attempt_at, null);
  });

  it('reminderCron claims the NEW row and never the superseded one', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(day, '10:00'), 'Priya');
    const moved = await appointments.rescheduleAppointment(t.id, c.id, at(day, '10:00'), at(day, '14:00'));
    assert.equal(moved.success, true, moved.error);

    // Both rows sit at reminder_status 'pending', so the ONLY thing that can
    // exclude the superseded one from the claim query is `a.status = 'booked'`.
    await db.query("UPDATE appointments SET reminder_status='pending' WHERE tenant_id=$1", [t.id]);

    await reminderCron.tick();

    const rows = await apptRows(t.id);
    const old = rows.find(r => r.status === 'rescheduled');
    const fresh = rows.find(r => r.status === 'booked');

    assert.equal(old.reminder_attempts, 0, 'the superseded row was never claimed');
    assert.equal(old.reminder_status, 'pending');
    assert.equal(fresh.reminder_attempts, 1, 'the row the patient actually holds was');
    assert.notEqual(fresh.reminder_status, 'pending', 'and it left the pending queue');
  });

  // ── 5. THE RACE ─────────────────────────────────────────────────────────────

  it('loses cleanly to a concurrent booker: original intact, no half-move, no alert', async () => {
    const t = await makeTenant();
    const priya = await makeCustomer(t.id, '+919812345678', 'Priya');
    const ravi = await makeCustomer(t.id, '+919812345679', 'Ravi');

    const day = dateIn(4);
    const OLD = at(day, '10:00');
    const CONTESTED = at(day, '15:00');
    await appointments.bookAppointment(t.id, priya.id, 'Dr. Rao', OLD, 'Priya');

    // Ravi's booking is INSERTed but NOT committed. Priya's move into the same
    // slot will therefore BLOCK on uniq_doctor_slot rather than fail fast — the
    // interleaving is forced by the index, not by sleeping and hoping.
    const rival = await db.getClient();
    let moved;
    try {
      await rival.query('BEGIN');
      await rival.query(
        `INSERT INTO appointments (tenant_id, customer_id, doctor_name, appointment_time, status)
         VALUES ($1,$2,'Dr. Rao',$3,'booked')`, [t.id, ravi.id, CONTESTED]);

      const inFlight = appointments.rescheduleAppointment(t.id, priya.id, OLD, CONTESTED);

      // Wait until the move is genuinely parked on the index lock. If it has not
      // got there yet the outcome is identical (it fails fast on commit instead),
      // so the assertion never depends on winning this poll — only its sharpness
      // does. Bounded well inside the 5s pool statement_timeout.
      const deadline = Date.now() + 1500;
      let blocked = false;
      while (Date.now() < deadline && !blocked) {
        const { rows } = await db.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`);
        blocked = rows.length > 0;
        if (!blocked) await new Promise(r => setTimeout(r, 25));
      }

      await rival.query('COMMIT');
      moved = await inFlight;
    } finally {
      rival.release();
    }

    assert.equal(moved.success, false);
    assert.equal(moved.reason, 'slot_taken', 'the loser gets the same recovery a losing booking gets');

    const rows = await apptRows(t.id);
    const priyas = rows.filter(r => r.customer_id === priya.id);
    assert.equal(priyas.length, 1, 'the rolled-back INSERT left nothing behind');
    assert.equal(priyas[0].status, 'booked', 'and her row was never flipped to rescheduled');
    assert.equal(new Date(priyas[0].appointment_time).getTime(), new Date(OLD).getTime(),
      'she still holds her ORIGINAL appointment');
    assert.equal(rows.filter(r => r.status === 'rescheduled').length, 0);

    // The alert only ever fires on success, so a lost race pages nobody and
    // leaves no notification claiming a move that did not happen.
    assert.deepEqual(await notifRows(t.id), []);
    assert.deepEqual(sends, []);
  });

  it('a concurrent move of the SAME appointment: exactly one wins, the loser writes nothing', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(5);
    const OLD = at(day, '10:00');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', OLD, 'Priya');

    // Two moves of the same appointment to two DIFFERENT free slots, so neither
    // loses on uniq_doctor_slot. The `status = 'booked'` guard on the supersede
    // UPDATE is the only thing that can separate them.
    const [a, b] = await Promise.all([
      appointments.rescheduleAppointment(t.id, c.id, OLD, at(day, '14:00')),
      appointments.rescheduleAppointment(t.id, c.id, OLD, at(day, '16:00')),
    ]);

    const winners = [a, b].filter(r => r.success);
    assert.equal(winners.length, 1, 'exactly one move commits');
    const loser = [a, b].find(r => !r.success);
    assert.ok(['appointment_changed', 'appointment_not_found'].includes(loser.reason), loser.reason);

    const rows = await apptRows(t.id);
    assert.equal(rows.filter(r => r.status === 'booked').length, 1, 'the patient holds exactly one appointment');
    assert.equal(rows.filter(r => r.status === 'rescheduled').length, 1);
    assert.equal(rows.length, 2, 'the loser rolled back entirely');
  });

  // ── 6. The alert, end to end ────────────────────────────────────────────────

  it('a real move produces the "Appointment moved" alert, with the freed slot on it', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    const OLD = at(day, '10:00');
    const NEW = at(day, '14:30');

    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', OLD, 'Priya');
    const moved = await appointments.rescheduleAppointment(t.id, c.id, OLD, NEW);
    assert.equal(moved.success, true, moved.error);

    await notifications.notifyOwnerOfBooking(t, moved, c);

    const rows = await notifRows(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'appointment_booked', 'one function, one type — the probe’s cleanup depends on it');
    assert.equal(rows[0].sent_status, 'sent');

    const fused = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: IST, dateStyle: 'full', timeStyle: 'short' });
    assert.equal(rows[0].content, [
      'Appointment moved — Dr. Rao',
      'Patient: Priya',
      'Phone: +919812345678',
      `Was: ${fused(OLD)}`,
      `Now: ${fused(NEW)}`,
      'Status: booked',
    ].join('\n'));
    assert.equal(sends[0].text, rows[0].content);
    assert.equal(sends[0].to, '+919000000001');
  });
});
