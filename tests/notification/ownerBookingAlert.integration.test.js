'use strict';

// B1 — the owner booking alert: what it says, and who it goes to.
//
// Two defects are pinned here. The payload carried three fields (name, doctor,
// a fused date-time blob) and neither the patient's phone nor the booking
// status; and the recipient was read from `tenants.owner_notify_phone`, a column
// NO production path has ever written — provisioning and the portal both write
// `config.notifications.owner_numbers`, so on a real tenant every alert took the
// 'no_phone' branch and no owner was ever notified.
//
// Runs against a REAL throwaway scratch database (same genesis pattern as the
// lifecycle/validation suites). Disjoint DB-name prefix (zyon_nb_) so no other
// suite's sweep drops it mid-run. Skips when DATABASE_URL is unset.
//
// The WhatsApp sender is spied on every test — nothing here touches Meta.

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
const PREFIX = 'zyon_nb_';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_nb\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// A real booking, shaped exactly as appointmentService.bookAppointment returns
// it: `appointment_time` raw off the INSERT's RETURNING, `status` the column.
const BOOKING = {
  success: true,
  appointment_id: '00000000-0000-0000-0000-0000000000aa',
  doctor: 'Dr. Rao',
  time: 'Wednesday, 5 August 2026 at 3:30 pm',
  appointment_time: new Date('2026-08-05T15:30:00+05:30'),
  status: 'booked',
  patient_name: 'Priya Sharma',
};

const CUSTOMER = { id: '00000000-0000-0000-0000-0000000000bb', name: 'Priya S', phone: '+919812345678' };

describe('owner booking alert (integration)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, notifications, configService, sender, spy;
  let seq = 0;
  let sends = [];

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
    notifications = require('../../src/modules/notification/notificationService');
    configService = require('../../src/modules/config/configService');
    sender = require('../../src/modules/channels/whatsapp/sender');
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

  // No test in this file may reach the network.
  beforeEach(() => {
    sends = [];
    spy = mock.method(sender, 'sendMessage', async (_tenant, to, text) => {
      sends.push({ to, text });
      return 'wamid.spy';
    });
  });
  afterEach(() => { if (spy) spy.mock.restore(); });

  // A tenant born the way provisioning makes them, with `notifications` set to
  // whatever the case under test needs. `column` seeds the deprecated legacy
  // column; provisioning never writes it, so it is null unless asked for.
  async function makeTenant({ ownerNumbers = ['+919000000001'], onBooking = true, column = null, noConfig = false } = {}) {
    const n = ++seq;
    const { rows: [t] } = await db.query(
      `INSERT INTO tenants (business_name, slug, phone_number_id, owner_notify_phone)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      ['Sunrise Dental', `nb-${n}-${crypto.randomBytes(3).toString('hex')}`, 'nb-pnid-' + n, column]);

    if (!noConfig) {
      const doc = structuredClone(clinicDefaults);
      doc.notifications = { owner_numbers: ownerNumbers, on_booking: onBooking, on_escalation: true };
      await db.query('INSERT INTO tenant_configs (tenant_id, version, config) VALUES ($1,1,$2)',
        [t.id, JSON.stringify(doc)]);
    }
    configService.invalidateConfigCache(t.id); // the read is 60s-cached
    return t;
  }

  const alertRow = async (tenantId) => (await db.query(
    "SELECT content, sent_status FROM notifications WHERE tenant_id=$1 AND type='appointment_booked'",
    [tenantId])).rows;

  // ── A. The payload ──────────────────────────────────────────────────────────

  it('the alert carries all five fields — patient name, phone, date, time (IST), status', async () => {
    const tenant = await makeTenant();
    await notifications.notifyOwnerOfBooking(tenant, BOOKING, CUSTOMER);

    const [row] = await alertRow(tenant.id);
    assert.equal(row.sent_status, 'sent');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].text, row.content, 'the row records exactly what was sent');

    // Every field, in the order the receptionist reads them.
    assert.match(row.content, /^New appointment with Dr\. Rao\n/);
    assert.match(row.content, /\nPatient: Priya Sharma\n/);
    assert.match(row.content, /\nPhone: \+919812345678\n/);
    assert.match(row.content, /\nDate: Wednesday, 5 August 2026\n/);
    assert.match(row.content, /\nTime: 3:30 pm IST\n/);
    assert.match(row.content, /\nStatus: booked$/);

    // Date and time are SEPARATE fields, not reminderCron's fused sentence.
    assert.ok(!row.content.includes('2026 at 3:30'), 'date and time are not fused');
  });

  it('the IST rendering is reminderCron\'s convention, split — recombining gives its exact string', () => {
    const IST = 'Asia/Kolkata';
    const d = BOOKING.appointment_time;
    const fused = d.toLocaleString('en-IN', { timeZone: IST, dateStyle: 'full', timeStyle: 'short' });
    const out = notifications.formatOwnerBookingAlert(BOOKING, CUSTOMER);
    const date = out.match(/\nDate: (.+)\n/)[1];
    const time = out.match(/\nTime: (.+) IST\n/)[1];
    assert.equal(`${date} at ${time}`, fused, 'same locale, same zone, same styles as reminderCron.js:147');
  });

  it('status renders from the appointments column, not a literal (B2 adds \'rescheduled\')', () => {
    const out = notifications.formatOwnerBookingAlert({ ...BOOKING, status: 'rescheduled' }, CUSTOMER);
    assert.match(out, /\nStatus: rescheduled$/);
  });

  it('the phone renders in normalizePhone\'s canonical form (INV-6)', () => {
    const out = notifications.formatOwnerBookingAlert(BOOKING, { ...CUSTOMER, phone: '+91 98123-45678' });
    assert.match(out, /\nPhone: \+919812345678\n/, 'punctuation stripped, E.164 kept');

    // A number that cannot be normalised is shown verbatim, never rewritten into
    // a plausible different one (F-003b) — and never dropped.
    const bad = notifications.formatOwnerBookingAlert(BOOKING, { ...CUSTOMER, phone: '9876543210' });
    assert.match(bad, /\nPhone: 9876543210\n/);
  });

  // ── B. The recipient ────────────────────────────────────────────────────────

  it('the recipient is config.notifications.owner_numbers[0], not the legacy column', async () => {
    const tenant = await makeTenant({ ownerNumbers: ['+919000000077'], column: '+919000000001' });
    await notifications.notifyOwnerOfBooking(tenant, BOOKING, CUSTOMER);

    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, '+919000000077', 'config wins over the column when both are set');
    assert.equal((await alertRow(tenant.id))[0].sent_status, 'sent');
  });

  it('an empty owner_numbers falls back to the DEPRECATED tenants.owner_notify_phone', async () => {
    const tenant = await makeTenant({ ownerNumbers: [], column: '+919000000001' });
    await notifications.notifyOwnerOfBooking(tenant, BOOKING, CUSTOMER);

    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, '+919000000001', 'the legacy column still delivers');
    assert.equal((await alertRow(tenant.id))[0].sent_status, 'sent');
  });

  it('a tenant with no config row at all still alerts through the legacy column', async () => {
    const tenant = await makeTenant({ noConfig: true, column: '+919000000001' });
    await notifications.notifyOwnerOfBooking(tenant, BOOKING, CUSTOMER);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, '+919000000001');
  });

  // ── C. Every skip is visible in data ────────────────────────────────────────

  it('on_booking:false sends nothing and records skipped_disabled', async () => {
    const tenant = await makeTenant({ ownerNumbers: ['+919000000001'], onBooking: false });
    await notifications.notifyOwnerOfBooking(tenant, BOOKING, CUSTOMER);

    assert.deepEqual(sends, [], 'no send when the clinic switched booking alerts off');
    const [row] = await alertRow(tenant.id);
    assert.equal(row.sent_status, 'skipped_disabled', 'the skip is visible in data, not silent');
    assert.match(row.content, /Patient: Priya Sharma/, 'and the row still records what WOULD have been sent');
  });

  it('no recipient by EITHER path still records no_phone, unchanged', async () => {
    const tenant = await makeTenant({ ownerNumbers: [], column: null });
    await notifications.notifyOwnerOfBooking(tenant, BOOKING, CUSTOMER);

    assert.deepEqual(sends, []);
    assert.equal((await alertRow(tenant.id))[0].sent_status, 'no_phone');
  });

  it('a 131047 re-engagement error still records failed_window — the external blocker stays visible', async () => {
    const tenant = await makeTenant();
    spy.mock.restore();
    spy = mock.method(sender, 'sendMessage', async () => {
      const err = new Error('re-engagement');
      err.response = { data: { error: { code: 131047, message: 'Re-engagement message' } } };
      throw err;
    });

    await notifications.notifyOwnerOfBooking(tenant, BOOKING, CUSTOMER);
    assert.equal((await alertRow(tenant.id))[0].sent_status, 'failed_window');
  });

  it('any other send failure still records failed, unchanged', async () => {
    const tenant = await makeTenant();
    spy.mock.restore();
    spy = mock.method(sender, 'sendMessage', async () => { throw new Error('socket hang up'); });

    await notifications.notifyOwnerOfBooking(tenant, BOOKING, CUSTOMER);
    assert.equal((await alertRow(tenant.id))[0].sent_status, 'failed');
  });

  // ── D. The suppression flag ─────────────────────────────────────────────────
  // The behavioural proof lives in tests/lifecycle/lifecycle.integration.test.js,
  // which spies the sender across a whole scripted-turn validation run. This is
  // the unit-level companion: it pins WHERE the check sits, which is the property
  // that makes the guard total — before the config is read, so no recipient
  // resolution can happen at all.

  it('the suppression flag blocks the send before the config is even read', async () => {
    const tenant = await makeTenant({ ownerNumbers: ['+919000000001'] });
    let configReads = 0;
    const readSpy = mock.method(configService, 'getTenantConfig', async () => {
      configReads += 1;
      return null;
    });

    try {
      await notifications.notifyOwnerOfBooking(
        { ...tenant, [notifications.SUPPRESS_OWNER_ALERTS]: true }, BOOKING, CUSTOMER);
    } finally {
      readSpy.mock.restore();
    }

    assert.deepEqual(sends, [], 'a suppressed tenant copy can reach no recipient by any path');
    assert.equal(configReads, 0, 'and never even resolves one');
    assert.equal((await alertRow(tenant.id))[0].sent_status, 'suppressed',
      'the suppressed attempt is still visible in data, and the row is what the probe cleans up by id');
  });
});
