const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── V-008: slot-grid validation on booking ──────────────────────────────────
// uniq_doctor_slot only blocks EXACT-timestamp double booking; an off-grid time
// (10:07 against a 30-min grid) inserts cleanly and overlaps a neighbour. These
// tests pin bookAppointment's grid rejection, the config-driven grid source
// (with clinicDefaults fallback), the IST timezone frame, and grid parity with
// checkAvailability — all with the DB and config service stubbed out.

// ── db stub (captured by appointmentService at module load) ──────────────────
// A single query router keyed off the SQL text. `insertBehavior` flips the
// appointments INSERT between success and a 23505 unique violation.
let insertBehavior = 'ok';
let lastInsertParams = null;
let bookedRows = [];
let schedules = [{ doctor: 'Dr. Rao', days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], start: '09:00', end: '18:00', slot_minutes: 30 }];

const dbPath = require.resolve('../../src/db/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (sql, params) => {
      if (/FROM tenant_entities/.test(sql)) return { rows: schedules.map((s) => ({ data: s })) };
      if (/UPDATE customers/.test(sql)) return { rows: [] };
      if (/SELECT appointment_time\s+FROM appointments/.test(sql)) return { rows: bookedRows };
      if (/INSERT INTO appointments/.test(sql)) {
        lastInsertParams = params;
        if (insertBehavior === 'conflict') { const e = new Error('duplicate'); e.code = '23505'; throw e; }
        return { rows: [{ id: 'appt-1', doctor_name: params[2], appointment_time: params[3], status: 'booked' }] };
      }
      return { rows: [] };
    },
  },
};

// ── config service stub — controls the resolved slot_minutes ─────────────────
let nextConfig = { booking: { slot_minutes: 30 } };
const configPath = require.resolve('../../src/modules/config/configService');
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true,
  exports: { getTenantConfig: async () => nextConfig },
};

// ── logger stub — capture config_fallback WARNs ──────────────────────────────
let warnCalls = [];
const loggerPath = require.resolve('../../src/infra/logging/logger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { info: () => {}, debug: () => {}, warn: (...a) => warnCalls.push(a), error: () => {} },
};

const appointmentService = require('../../src/modules/appointment/appointmentService');

const TENANT = 'T-grid';
// A fixed far-future date, so the "cannot book in the past" guard never fires.
const DATE = '2035-01-08'; // a Monday; schedule works every day anyway
const at = (hhmm) => `${DATE}T${hhmm}:00+05:30`;

async function book(hhmm, doctor = 'Dr. Rao') {
  return appointmentService.bookAppointment(TENANT, 'C1', doctor, at(hhmm), 'Meena');
}

describe('bookAppointment — slot-grid validation (V-008)', () => {
  beforeEach(() => {
    insertBehavior = 'ok';
    lastInsertParams = null;
    bookedRows = [];
    warnCalls = [];
    nextConfig = { booking: { slot_minutes: 30 } };
    schedules = [{ doctor: 'Dr. Rao', days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], start: '09:00', end: '18:00', slot_minutes: 30 }];
  });

  it('rejects off-grid times against a 30-minute grid (10:07, 10:29, one-minute-off boundaries)', async () => {
    for (const t of ['10:07', '10:29', '10:01', '09:31']) {
      const r = await book(t);
      assert.equal(r.success, false, `${t} must be rejected`);
      assert.match(r.error, /not on the schedule grid/i, `${t} error is the grid error`);
      assert.equal(lastInsertParams, null, `${t} must not reach the INSERT`);
    }
  });

  it('accepts an on-grid time and inserts it (30-minute grid, 10:30)', async () => {
    const r = await book('10:30');
    assert.equal(r.success, true);
    assert.equal(r.doctor, 'Dr. Rao');
    assert.ok(lastInsertParams, 'on-grid booking reaches the INSERT');
  });

  it('a 15-minute-grid tenant accepts 10:15', async () => {
    nextConfig = { booking: { slot_minutes: 15 } };
    const r = await book('10:15');
    assert.equal(r.success, true, '10:15 is on a 15-minute grid');
    // …and 10:07 is still off even a 15-minute grid.
    const r2 = await book('10:07');
    assert.equal(r2.success, false);
    assert.match(r2.error, /not on the schedule grid/i);
  });

  it('an on-grid collision still surfaces the 23505 slot-taken error, not the grid error', async () => {
    insertBehavior = 'conflict';
    const r = await book('10:30'); // on-grid → passes grid check → hits INSERT → 23505
    assert.equal(r.success, false);
    assert.match(r.error, /just booked by someone else/i, 'concurrency backstop still owns on-grid collisions');
    assert.doesNotMatch(r.error, /schedule grid/i);
  });

  it('configless tenant falls back to clinicDefaults (30) with a config_fallback WARN', async () => {
    nextConfig = null; // no config row
    const r = await book('10:07');
    assert.equal(r.success, false);
    assert.match(r.error, /not on the schedule grid/i);
    const warn = warnCalls.find((c) => c[0] && c[0].scope === 'config_fallback');
    assert.ok(warn, 'a config_fallback WARN is emitted');
    assert.equal(warn[0].slot_minutes, 30);
    assert.equal(warn[0].reason, 'no_config');
  });

  it('timezone frame: alignment is judged in IST, not UTC (the frame decision)', async () => {
    // 60-minute grid anchored at 10:00 IST. 11:00 IST is on-grid; the SAME
    // instant is 05:30 UTC (off any hour grid). 10:30 IST is off-grid; its
    // instant is 05:00 UTC (on the hour). If the check ran in the UTC frame the
    // two results would flip — so these two assertions pin the IST frame.
    schedules = [{ doctor: 'Dr. Rao', days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], start: '10:00', end: '18:00', slot_minutes: 60 }];
    nextConfig = { booking: { slot_minutes: 60 } };

    const onGrid = await book('11:00');
    assert.equal(onGrid.success, true, '11:00 IST is on the 60-min grid (UTC 05:30 would say otherwise)');

    const offGrid = await book('10:30');
    assert.equal(offGrid.success, false, '10:30 IST is off the 60-min grid (UTC 05:00 would say otherwise)');
    assert.match(offGrid.error, /not on the schedule grid/i);
  });
});

describe('checkAvailability ↔ bookAppointment grid parity (V-008)', () => {
  beforeEach(() => {
    insertBehavior = 'ok';
    bookedRows = [];
    warnCalls = [];
  });

  // The whole point of V-008: every slot checkAvailability offers is a slot
  // bookAppointment accepts, and every time it rejects is a time not offered.
  for (const slotMinutes of [15, 30, 45]) {
    it(`offered slots all pass isOnGrid; between-slot times all fail (grid ${slotMinutes})`, async () => {
      const start = '09:00', end = '18:00';
      nextConfig = { booking: { slot_minutes: slotMinutes } };
      schedules = [{ doctor: 'Dr. Rao', days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], start, end, slot_minutes: slotMinutes }];

      const { available } = await appointmentService.checkAvailability(TENANT, DATE);
      const offered = available[0].free_slots;
      assert.ok(offered.length > 0, 'some slots offered');

      // Parity direction 1: every offered slot is bookable (on-grid).
      for (const s of offered) {
        assert.ok(appointmentService.isOnGrid(s, start, slotMinutes), `offered ${s} must be on-grid`);
      }
      // Parity direction 2: a time one minute past each offered slot is off-grid.
      for (const s of offered) {
        const [h, m] = s.split(':').map(Number);
        const off = `${String(h).padStart(2, '0')}:${String(m + 1).padStart(2, '0')}`;
        assert.equal(appointmentService.isOnGrid(off, start, slotMinutes), false, `${off} must be off-grid`);
      }
    });
  }
});
