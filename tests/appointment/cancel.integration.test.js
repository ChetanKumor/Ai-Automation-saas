'use strict';

// B2-R1 — cancelling an appointment. Two-phase, server-side gated.
//
// The claims worth making here are claims about uniq_doctor_slot — a partial
// unique index on `status = 'booked'` — and about a gate that must hold whatever
// the model intends. Neither is proven by inspecting source, so everything below
// runs against a REAL throwaway scratch database with REAL INSERTs. The freed-slot
// proof is another patient actually booking the vacated time, and the
// no-write proof is another patient still being BLOCKED from it.
//
// Disjoint DB-name prefix (zyon_cx_) so no other suite's sweep drops it mid-run.
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
const PREFIX = 'zyon_cx_';
const IST = 'Asia/Kolkata';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_cx\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// Every fixture opens the clinic seven days a week and gives the doctor all seven
// days, so nothing here can inherit TEST-FLAKE-03's class of calendar dependence.
const dateIn = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: IST });
const at = (date, hhmm) => `${date}T${hhmm}:00+05:30`;

describe('cancel (integration)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
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

  const OPEN = { open: '09:00', close: '18:00' };
  async function makeTenant({ booking = {}, reminderHours = 240 } = {}) {
    const n = ++seq;
    const { rows: [t] } = await db.query(
      `INSERT INTO tenants (business_name, slug, phone_number_id, wa_token, active,
                            reminders_enabled, reminder_hours_before)
       VALUES ($1,$2,$3,'tok',true,true,$4) RETURNING *`,
      ['Cancel Dental', `cx-${n}-${crypto.randomBytes(3).toString('hex')}`, 'cx-pnid-' + n, reminderHours]);

    await db.query(
      "INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1,'schedule',$2)",
      [t.id, JSON.stringify({
        doctor: 'Dr. Rao', days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        start: '09:00', end: '18:00', slot_minutes: 30,
      })]);

    const doc = structuredClone(clinicDefaults);
    doc.booking = { ...doc.booking, slot_minutes: 30, advance_days: 365, buffer_minutes: 0, allow_same_day: true, ...booking };
    doc.hours = { ...Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(d => [d, OPEN])), holidays: [] };
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

  // Every dimension the claim query filters on, per row. Used to prove the
  // cancelled row was excluded BY ITS STATUS and not by some other disqualifier
  // — without this the "never claimed" assertion could pass vacuously.
  const claimEligibility = async (tenantId) => (await db.query(
    `SELECT a.status, a.reminder_status,
            t.reminders_enabled,
            (a.appointment_time > NOW()) AS future,
            (a.appointment_time <= NOW() + (t.reminder_hours_before || ' hours')::interval) AS in_window
     FROM appointments a JOIN tenants t ON t.id = a.tenant_id
     WHERE a.tenant_id = $1 ORDER BY a.appointment_time`, [tenantId])).rows;

  const apptRows = async (tenantId) => (await db.query(
    `SELECT id, customer_id, doctor_name, appointment_time, status,
            reminder_status, reminder_sent, reminder_sent_at, reminder_attempts, last_attempt_at
     FROM appointments WHERE tenant_id = $1 ORDER BY created_at`, [tenantId])).rows;

  const notifRows = async (tenantId) => (await db.query(
    'SELECT type, content, sent_status FROM notifications WHERE tenant_id = $1', [tenantId])).rows;

  // ── 1. THE GATE ─────────────────────────────────────────────────────────────
  // The whole reason this session exists. Booking's confirm-first is an
  // information dependency with a bounce; a cancel has no bounce, so the wall is
  // built server-side. These assert it is a wall and not a suggestion.

  it('the UNCONFIRMED call writes nothing: the row is untouched and the slot is still blocked', async () => {
    const t = await makeTenant();
    const priya = await makeCustomer(t.id, '+919812345678', 'Priya');
    const ravi = await makeCustomer(t.id, '+919812345679', 'Ravi');
    const day = dateIn(3);
    const SLOT = at(day, '10:00');

    await appointments.bookAppointment(t.id, priya.id, 'Dr. Rao', SLOT, 'Priya');
    const before = await apptRows(t.id);

    const dry = await appointments.cancelAppointment(t.id, priya.id, SLOT, false);
    assert.equal(dry.success, false, 'phase 1 is not a completed cancellation');
    assert.equal(dry.reason, 'confirmation_required');
    assert.equal(dry.confirmation_required, true);

    // The confirmation payload: the model's material for reading it back.
    assert.equal(dry.doctor, 'Dr. Rao');
    assert.equal(dry.patient_name, 'Priya');
    assert.equal(dry.date, new Date(SLOT).toLocaleDateString('en-IN', { timeZone: IST, dateStyle: 'full' }));
    assert.equal(dry.time, new Date(SLOT).toLocaleTimeString('en-IN', { timeZone: IST, timeStyle: 'short' }));
    assert.match(dry.error, /Nothing has been cancelled yet/);
    assert.match(dry.error, /cannot be undone/);

    // THE PROOF, and it is the non-vacuous half: the slot is STILL TAKEN. A dry
    // run that quietly freed the slot would be the exact bug the gate prevents.
    const blocked = await appointments.bookAppointment(t.id, ravi.id, 'Dr. Rao', SLOT, 'Ravi');
    assert.equal(blocked.success, false);
    assert.equal(blocked.reason, 'slot_taken', 'the unconfirmed call must not free the slot');

    const after = await apptRows(t.id);
    assert.deepEqual(after, before, 'not one column of the row moved');
    assert.equal(sends.length, 0, 'and no owner was paged about a cancellation that has not happened');
  });

  it('an OMITTED confirmed behaves as false — the gate fails closed', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    const SLOT = at(day, '10:00');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', SLOT, 'Priya');

    // Omitted entirely — the shape a model that ignores a required parameter
    // produces. Then every other way of being not-quite-true. All must be false:
    // one wasted round trip is recoverable, a destroyed booking is not.
    for (const arg of [undefined, null, 'true', 'yes', 1, {}]) {
      const r = await appointments.cancelAppointment(t.id, c.id, SLOT, arg);
      assert.equal(r.reason, 'confirmation_required', `confirmed=${JSON.stringify(arg)} must not cancel`);
    }

    const rows = await apptRows(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'booked', 'six near-misses and the appointment still stands');
  });

  it('both phases resolve the SAME appointment for the same input', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    // Two appointments, so "which one" is a real question rather than a default.
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(day, '10:00'), 'Priya');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(day, '15:30'), 'Priya');

    const TARGET = at(day, '15:30');
    const dry = await appointments.cancelAppointment(t.id, c.id, TARGET, false);
    assert.equal(dry.reason, 'confirmation_required');

    const real = await appointments.cancelAppointment(t.id, c.id, TARGET, true);
    assert.equal(real.success, true, real.error);

    // The dry run described the row the write actually took. A confirmation that
    // resolves differently from the write it authorises is worse than none.
    assert.equal(new Date(dry.appointment_time).getTime(), new Date(TARGET).getTime());
    assert.equal(new Date(real.appointment_time).getTime(), new Date(dry.appointment_time).getTime());
    assert.equal(real.doctor, dry.doctor);

    const rows = await apptRows(t.id);
    const cancelled = rows.filter(r => r.status === 'cancelled');
    assert.equal(cancelled.length, 1, 'exactly one, and it is the one that was read back');
    assert.equal(new Date(cancelled[0].appointment_time).getTime(), new Date(TARGET).getTime());
    assert.equal(rows.filter(r => r.status === 'booked').length, 1, 'the 10:00 is untouched');
  });

  // ── 2. THE FREED SLOT ───────────────────────────────────────────────────────

  it('after a cancel the slot is bookable again — by a DIFFERENT patient, with a real INSERT', async () => {
    const t = await makeTenant();
    const priya = await makeCustomer(t.id, '+919812345678', 'Priya');
    const ravi = await makeCustomer(t.id, '+919812345679', 'Ravi');
    const day = dateIn(3);
    const SLOT = at(day, '10:00');

    const booked = await appointments.bookAppointment(t.id, priya.id, 'Dr. Rao', SLOT, 'Priya');
    assert.equal(booked.success, true);

    // Blocked BEFORE — so the freed-slot assertion below is not vacuous.
    const blocked = await appointments.bookAppointment(t.id, ravi.id, 'Dr. Rao', SLOT, 'Ravi');
    assert.equal(blocked.success, false);
    assert.equal(blocked.reason, 'slot_taken');

    const done = await appointments.cancelAppointment(t.id, priya.id, SLOT, true);
    assert.equal(done.success, true, done.error);
    assert.equal(done.cancelled, true);
    assert.equal(done.status, 'cancelled', 'read off the UPDATE’s own RETURNING');

    // THE PROOF: a real INSERT by someone else into the vacated slot.
    const reused = await appointments.bookAppointment(t.id, ravi.id, 'Dr. Rao', SLOT, 'Ravi');
    assert.equal(reused.success, true, `the freed slot must be bookable: ${reused.error}`);

    const rows = await apptRows(t.id);
    assert.equal(rows.length, 2, 'the cancelled row SURVIVES — transitioned, never dropped');
    const gone = rows.find(r => r.status === 'cancelled');
    assert.ok(gone, 'a cancellation is a row, not an absence');
    assert.equal(gone.customer_id, priya.id);
    assert.equal(new Date(gone.appointment_time).getTime(), new Date(SLOT).getTime(),
      'and it still records the time, so the clinic can account for the slot');
    assert.equal(rows.filter(r => r.status === 'booked').length, 1);
  });

  // ── 3. The status='booked' guard ────────────────────────────────────────────

  it('a DOUBLE cancel fails cleanly and does not touch the row twice', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    const SLOT = at(day, '10:00');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', SLOT, 'Priya');

    const first = await appointments.cancelAppointment(t.id, c.id, SLOT, true);
    assert.equal(first.success, true, first.error);
    const afterFirst = await apptRows(t.id);

    // The second attempt cannot even resolve it: upcomingAppointments is scoped
    // to status='booked', so a cancelled appointment is no longer theirs to
    // cancel and the refusal IS the lookup.
    const second = await appointments.cancelAppointment(t.id, c.id, SLOT, true);
    assert.equal(second.success, false);
    assert.equal(second.reason, 'appointment_not_found');
    assert.deepEqual(second.appointments, [], 'they hold nothing upcoming any more');
    assert.match(second.error, /no upcoming appointments to cancel/);

    assert.deepEqual(await apptRows(t.id), afterFirst, 'the row was not written a second time');
  });

  it('cancelling an already-RESCHEDULED row fails — the patient no longer holds it', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    const OLD = at(day, '10:00');
    const NEW = at(day, '14:00');

    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', OLD, 'Priya');
    const moved = await appointments.rescheduleAppointment(t.id, c.id, OLD, NEW);
    assert.equal(moved.success, true, moved.error);

    // The superseded row still exists at the OLD time, but they do not hold it.
    const r = await appointments.cancelAppointment(t.id, c.id, OLD, true);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'appointment_not_found');
    assert.equal(r.appointments.length, 1, 'and the refusal points them at what they DO hold');
    assert.equal(r.appointments[0].time,
      new Date(NEW).toLocaleString('en-IN', { timeZone: IST, dateStyle: 'full', timeStyle: 'short' }));

    const rows = await apptRows(t.id);
    assert.equal(rows.filter(r2 => r2.status === 'cancelled').length, 0, 'nothing was cancelled');
    assert.equal(rows.find(r2 => r2.status === 'rescheduled').status, 'rescheduled',
      'the superseded row keeps its own status — a cancel cannot overwrite the move’s record');
  });

  it('a STALE confirmation loses to the guard: the appointment moved between the two calls', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    const OLD = at(day, '10:00');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', OLD, 'Priya');

    // Phase 1 resolves the appointment and hands it back...
    const dry = await appointments.cancelAppointment(t.id, c.id, OLD, false);
    assert.equal(dry.reason, 'confirmation_required');

    // ...and while the patient is being read the details, the row is superseded
    // out from under the confirmation. Flipped directly: this test is about what
    // the guard does with a stale reference, not about how it went stale.
    await db.query("UPDATE appointments SET status='rescheduled' WHERE tenant_id=$1", [t.id]);

    const r = await appointments.cancelAppointment(t.id, c.id, OLD, true);
    assert.equal(r.success, false);
    assert.ok(['appointment_not_found', 'appointment_changed'].includes(r.reason), r.reason);

    const rows = await apptRows(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'rescheduled', 'the guard refused to overwrite a status it did not expect');
    assert.equal(sends.length, 0, 'and no owner alert for a cancellation that did not happen');
  });

  // ── 4. The lookup IS the error ──────────────────────────────────────────────

  it('appointment_not_found lists the caller’s real upcoming appointments, in the cancel’s words', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const d1 = dateIn(3), d2 = dateIn(5);
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(d1, '10:00'), 'Priya');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', at(d2, '11:30'), 'Priya');

    const r = await appointments.cancelAppointment(t.id, c.id, at(dateIn(9), '10:00'), true);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'appointment_not_found');
    assert.equal(r.appointments.length, 2, 'both of theirs, so the model can ask which');

    const expected = new Date(at(d1, '10:00'))
      .toLocaleString('en-IN', { timeZone: IST, dateStyle: 'full', timeStyle: 'short' });
    assert.equal(r.appointments[0].time, expected, 'soonest first');
    assert.ok(r.error.includes(expected), 'the refusal performs the lookup');

    // The verb is the parameter B2 could not reuse verbatim. On this path it must
    // say cancelling, never moving — the wrong verb confirms the wrong action.
    assert.match(r.error, /before cancelling anything/);
    assert.doesNotMatch(r.error, /moving/);
    assert.match(r.error, /never guess/);
  });

  it('never returns another customer’s appointment, and says so plainly when there are none', async () => {
    const t = await makeTenant();
    const priya = await makeCustomer(t.id, '+919812345678', 'Priya');
    const ravi = await makeCustomer(t.id, '+919812345679', 'Ravi');
    const day = dateIn(3);
    const SLOT = at(day, '10:00');
    await appointments.bookAppointment(t.id, priya.id, 'Dr. Rao', SLOT, 'Priya');

    // Ravi asks to cancel Priya's slot. It is not his to cancel — on BOTH phases.
    for (const confirmed of [false, true]) {
      const r = await appointments.cancelAppointment(t.id, ravi.id, SLOT, confirmed);
      assert.equal(r.reason, 'appointment_not_found', `confirmed=${confirmed}`);
      assert.deepEqual(r.appointments, [], 'no cross-customer leakage');
      assert.match(r.error, /no upcoming appointments to cancel/);
    }

    const rows = await apptRows(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'booked', 'Priya still has her appointment');
    assert.equal(rows[0].customer_id, priya.id);
  });

  it('the reschedule path’s appointment_not_found wording is unchanged — the verb defaults to move', async () => {
    const t = await makeTenant();
    const priya = await makeCustomer(t.id, '+919812345678', 'Priya');
    const ravi = await makeCustomer(t.id, '+919812345679', 'Ravi');
    const day = dateIn(3);
    await appointments.bookAppointment(t.id, priya.id, 'Dr. Rao', at(day, '10:00'), 'Priya');

    // Branch A — they hold something, just not that.
    const miss = await appointments.rescheduleAppointment(t.id, priya.id, at(dateIn(9), '10:00'), at(dateIn(10), '10:00'));
    assert.match(miss.error, /before moving anything/, 'B2’s text is byte-identical');
    assert.doesNotMatch(miss.error, /cancelling/);

    // Branch B — they hold nothing at all.
    const none = await appointments.rescheduleAppointment(t.id, ravi.id, at(day, '10:00'), at(day, '14:00'));
    assert.equal(none.error, 'This caller has no upcoming appointments to move.');
  });

  it('a concurrent cancel of the SAME appointment: exactly one wins, the loser writes nothing', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    const SLOT = at(day, '10:00');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', SLOT, 'Priya');

    const [a, b] = await Promise.all([
      appointments.cancelAppointment(t.id, c.id, SLOT, true),
      appointments.cancelAppointment(t.id, c.id, SLOT, true),
    ]);

    const winners = [a, b].filter(r => r.success);
    const losers = [a, b].filter(r => !r.success);
    assert.equal(winners.length, 1, 'exactly one cancellation, never two');
    assert.equal(losers.length, 1);

    // Two honest losing shapes, depending on whether the loser's lookup ran
    // before or after the winner committed. Both say the same thing to the
    // receptionist: they no longer hold it. Neither is a silent success.
    assert.ok(['appointment_changed', 'appointment_not_found'].includes(losers[0].reason), losers[0].reason);

    const rows = await apptRows(t.id);
    assert.equal(rows.length, 1, 'no second row, and none dropped');
    assert.equal(rows[0].status, 'cancelled');
  });

  it('no appointment id reaches the model on EITHER phase', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    const SLOT = at(day, '10:00');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', SLOT, 'Priya');

    const dry = await appointments.cancelAppointment(t.id, c.id, SLOT, false);
    assert.ok(!('appointment_id' in dry), 'not on the confirmation payload');
    assert.ok(!('id' in dry));
    assert.ok(!JSON.stringify(dry).includes('-4'), 'no UUID anywhere in the dry run');

    const real = await appointments.cancelAppointment(t.id, c.id, SLOT, true);
    assert.equal(real.success, true, real.error);
    assert.ok(!('appointment_id' in real), 'an identifier the model can read back to a caller eventually will be');
    assert.ok(!JSON.stringify(real).includes('-4'), 'nor in the success');

    const miss = await appointments.cancelAppointment(t.id, c.id, at(dateIn(9), '10:00'), true);
    assert.ok(!JSON.stringify(miss).includes('-4'), 'nor in the refusal that lists their appointments');
  });

  it('the patient’s PHONE never enters the tool response, on either phase', async () => {
    const t = await makeTenant();
    const PHONE = '+919812345678';
    const c = await makeCustomer(t.id, PHONE, 'Priya');
    const day = dateIn(3);
    const SLOT = at(day, '10:00');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', SLOT, 'Priya');

    // The confirmation payload carries the NAME (already in the model's context
    // via the system prompt, and already on bookAppointment's return) but must
    // never carry the number — this object is serialised into Gemini's context.
    const dry = await appointments.cancelAppointment(t.id, c.id, SLOT, false);
    assert.equal(dry.patient_name, 'Priya');
    assert.ok(!JSON.stringify(dry).includes(PHONE), 'no phone on the confirmation payload');
    assert.ok(!JSON.stringify(dry).includes('9812345678'));

    const real = await appointments.cancelAppointment(t.id, c.id, SLOT, true);
    assert.ok(!JSON.stringify(real).includes('9812345678'), 'nor on the success');
  });

  // ── 5. Reminder state ───────────────────────────────────────────────────────

  it('reminderCron never claims a cancelled row', async () => {
    const t = await makeTenant();
    const priya = await makeCustomer(t.id, '+919812345678', 'Priya');
    const ravi = await makeCustomer(t.id, '+919812345679', 'Ravi');
    const day = dateIn(3);

    await appointments.bookAppointment(t.id, priya.id, 'Dr. Rao', at(day, '10:00'), 'Priya');
    await appointments.bookAppointment(t.id, ravi.id, 'Dr. Rao', at(day, '11:00'), 'Ravi');
    const done = await appointments.cancelAppointment(t.id, priya.id, at(day, '10:00'), true);
    assert.equal(done.success, true, done.error);

    // NON-VACUITY: the two rows are identical on every dimension the claim query
    // filters on EXCEPT `status`. Both pending, both future, both inside the
    // reminder window, same tenant with reminders enabled. So if only one is
    // claimed, `a.status = 'booked'` is the only thing that can have excluded the
    // other — which is the entire claim of this test.
    const pre = await claimEligibility(t.id);
    assert.equal(pre.length, 2);
    assert.deepEqual(pre.map(r => r.status), ['cancelled', 'booked'], '10:00 cancelled, 11:00 live');
    for (const r of pre) {
      assert.equal(r.reminder_status, 'pending',
        'cancel leaves reminder_status alone: the CHECK has no cancelled value and sent/failed would be lies');
      assert.equal(r.reminders_enabled, true);
      assert.equal(r.future, true);
      assert.equal(r.in_window, true);
    }

    await reminderCron.tick();

    const rows = await apptRows(t.id);
    const gone = rows.find(r => r.status === 'cancelled');
    const live = rows.find(r => r.status === 'booked');

    assert.equal(gone.reminder_attempts, 0, 'the cancelled row was never claimed');
    assert.equal(gone.reminder_status, 'pending', 'it simply sits there, inert');
    assert.equal(gone.reminder_sent, false);
    assert.equal(gone.reminder_sent_at, null, 'and the patient was never told about a slot they gave up');
    assert.equal(live.reminder_attempts, 1, 'the row that is still on the books was claimed');
    assert.notEqual(live.reminder_status, 'pending', 'and it left the pending queue');
  });

  it('a row already CLAIMED (sending) is still reminded — the race, asserted rather than assumed', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    const SLOT = at(day, '10:00');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', SLOT, 'Priya');

    // reminderCron claimed it a moment ago: status 'sending'. The cancel lands
    // now. processReminder works from the row already fetched into `due` and
    // never re-reads status, so the send is already committed to.
    await db.query("UPDATE appointments SET reminder_status='sending', reminder_attempts=1, last_attempt_at=NOW() WHERE tenant_id=$1", [t.id]);

    const done = await appointments.cancelAppointment(t.id, c.id, SLOT, true);
    assert.equal(done.success, true, done.error);

    // The honest state: cancelled, and mid-flight in the reminder pipeline.
    const rows = await apptRows(t.id);
    assert.equal(rows[0].status, 'cancelled');
    assert.equal(rows[0].reminder_status, 'sending', 'the cancel did not and could not unclaim it');

    // It CANNOT repeat: reapStuck returns a stalled row to 'pending', and the
    // re-claim filters status='booked'. Simulate the reap, then tick.
    await db.query("UPDATE appointments SET reminder_status='pending' WHERE tenant_id=$1", [t.id]);
    await reminderCron.tick();

    const after = await apptRows(t.id);
    assert.equal(after[0].reminder_attempts, 1, 'never re-claimed after the cancel');
    assert.equal(after[0].reminder_status, 'pending');
  });

  // ── 6. The owner alert ──────────────────────────────────────────────────────

  it('a real cancel produces the "Appointment cancelled" alert, with the FREED slot on it', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    const SLOT = at(day, '14:30');

    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', SLOT, 'Priya');
    const done = await appointments.cancelAppointment(t.id, c.id, SLOT, true);
    assert.equal(done.success, true, done.error);

    await notifications.notifyOwnerOfBooking(t, done, c);

    const rows = await notifRows(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'appointment_booked',
      'one function, one type — the probe’s id-diff cleanup depends on it');
    assert.equal(rows[0].sent_status, 'sent');

    const fused = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: IST, dateStyle: 'full', timeStyle: 'short' });
    assert.equal(rows[0].content, [
      'Appointment cancelled — Dr. Rao',
      'Patient: Priya',
      'Phone: +919812345678',
      `Freed: ${fused(SLOT)}`,
      'Status: cancelled',
    ].join('\n'));

    // The receptionist's actionable fact is WHICH SLOT OPENED — it must be
    // legible in the message, not merely implied by the fact of a cancellation.
    assert.ok(rows[0].content.includes(fused(SLOT)), 'the freed time is visible');
    assert.equal(sends[0].text, rows[0].content);
    assert.equal(sends[0].to, '+919000000001');
  });

  it('the UNCONFIRMED call pages nobody', async () => {
    const t = await makeTenant();
    const c = await makeCustomer(t.id, '+919812345678', 'Priya');
    const day = dateIn(3);
    const SLOT = at(day, '10:00');
    await appointments.bookAppointment(t.id, c.id, 'Dr. Rao', SLOT, 'Priya');

    const dry = await appointments.cancelAppointment(t.id, c.id, SLOT, false);
    // executeTool gates the alert on `result.success`, so the fail-closed
    // success:false on phase 1 is what makes this structural rather than a
    // second condition somebody could forget to write.
    assert.equal(dry.success, false);

    const rows = await notifRows(t.id);
    assert.equal(rows.length, 0, 'no notification row at all');
    assert.equal(sends.length, 0);
  });
});
