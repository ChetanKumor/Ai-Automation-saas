const { describe, it, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');

// ── F-006: clinic booking rules enforced at booking time ────────────────────
// advance_days, buffer_minutes, allow_same_day and hours+holidays were editable
// and validated in config but enforced NOWHERE — a patient could be booked on a
// configured holiday, outside opening hours, or a year ahead. These tests pin
// all five rules on BOTH sides (what check_availability offers and what
// bookAppointment writes), the clinic-local (IST) boundary frame, the structured
// rejection reasons, and the over-blocking guards that keep a valid booking
// valid. DB and config service are stubbed out.
//
// Time is FROZEN (node:test Date mocking) so every boundary — "exactly now +
// buffer", "exactly advance_days out", "the holiday's first and last minute" —
// is an exact assertion rather than a race with the wall clock.

const IST = 'Asia/Kolkata';
const NOW_ISO = '2026-07-21T04:30:00Z'; // 10:00 IST, Tuesday 2026-07-21
const TODAY = '2026-07-21'; // Tue
const WED   = '2026-07-22';
const THU   = '2026-07-23';
const FRI   = '2026-07-24';
const SUN   = '2026-07-26';

function freeze(iso = NOW_ISO) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: new Date(iso).getTime() });
}

// ── db stub ─────────────────────────────────────────────────────────────────
let lastInsertParams = null;
let bookedRows = [];
// One doctor working every day 09:00–18:00, so the DOCTOR never blocks and what
// is left under test is purely the clinic's own rules.
let schedules = [{ doctor: 'Dr. Rao', days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], start: '09:00', end: '18:00' }];

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
        return { rows: [{ id: 'appt-1', doctor_name: params[2], appointment_time: params[3], status: 'booked' }] };
      }
      return { rows: [] };
    },
  },
};

// ── config service stub ─────────────────────────────────────────────────────
let nextConfig = null;
const configPath = require.resolve('../../src/modules/config/configService');
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true,
  exports: { getTenantConfig: async () => nextConfig },
};

// ── logger stub ─────────────────────────────────────────────────────────────
let warnCalls = [];
const loggerPath = require.resolve('../../src/infra/logging/logger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { info: () => {}, debug: () => {}, warn: (...a) => warnCalls.push(a), error: () => {} },
};

const appointmentService = require('../../src/modules/appointment/appointmentService');

const TENANT = 'T-rules';
const OPEN = { open: '09:00', close: '18:00' };
const ALL_DAY = { open: '00:00', close: '23:59' };

// A complete, valid config with every rule at a permissive default; each test
// overrides only the knob it is about.
const cfg = (booking = {}, hours = {}) => ({
  booking: { slot_minutes: 30, advance_days: 30, buffer_minutes: 0, allow_same_day: true, ...booking },
  hours: {
    mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN, sun: OPEN,
    holidays: [], ...hours,
  },
});

const book = (date, hhmm, doctor = 'Dr. Rao') =>
  appointmentService.bookAppointment(TENANT, 'C1', doctor, `${date}T${hhmm}:00+05:30`, 'Meena');
const bookISO = (iso) => appointmentService.bookAppointment(TENANT, 'C1', 'Dr. Rao', iso, 'Meena');
const avail = (date) => appointmentService.checkAvailability(TENANT, date);
const slotsFor = async (date) => {
  const res = await avail(date);
  assert.ok(res.available, `expected slots for ${date}, got: ${res.error}`);
  return res.available[0].free_slots;
};

beforeEach(() => {
  lastInsertParams = null;
  bookedRows = [];
  warnCalls = [];
  nextConfig = cfg();
  schedules = [{ doctor: 'Dr. Rao', days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], start: '09:00', end: '18:00' }];
  freeze();
});

after(() => mock.timers.reset());

// ── rule 1: opening hours ───────────────────────────────────────────────────
describe('F-006 hours — open/close window and closed days', () => {
  it('rejects a booking outside the day\'s open/close window, on both boundaries', async () => {
    nextConfig = cfg({}, { wed: { open: '10:00', close: '13:00' } });

    const early = await book(WED, '09:00');
    assert.equal(early.success, false, '09:00 is before the 10:00 open');
    assert.equal(early.reason, 'outside_hours');
    assert.equal(lastInsertParams, null, 'must not reach the INSERT');

    // Exactly AT close is outside — a slot starting at closing time is not a
    // slot the clinic can serve.
    const atClose = await book(WED, '13:00');
    assert.equal(atClose.success, false, '13:00 is the close time');
    assert.equal(atClose.reason, 'outside_hours');
  });

  it('accepts a booking exactly at open time, and one inside the window', async () => {
    nextConfig = cfg({}, { wed: { open: '10:00', close: '13:00' } });

    const atOpen = await book(WED, '10:00');
    assert.equal(atOpen.success, true, 'exactly at open is bookable');

    const inside = await book(WED, '12:30');
    assert.equal(inside.success, true, 'the last slot before close is bookable');
  });

  it('a day marked closed offers nothing and accepts nothing', async () => {
    nextConfig = cfg({}, { wed: { closed: true } });

    const r = await book(WED, '10:00');
    assert.equal(r.success, false);
    assert.equal(r.reason, 'closed_day');
    assert.match(r.error, /closed on Wed/i);
    assert.equal(lastInsertParams, null);

    const a = await avail(WED);
    assert.equal(a.reason, 'closed_day', 'availability refuses the same day for the same reason');
    assert.equal(a.available, undefined, 'no slots are offered at all');
  });

  it('over-block guard: an open day next to a closed one still books', async () => {
    nextConfig = cfg({}, { wed: { closed: true } });
    const r = await book(THU, '10:00');
    assert.equal(r.success, true, 'Thursday is unaffected by Wednesday being closed');
  });

  it('availability clips the doctor\'s schedule to the clinic\'s opening hours', async () => {
    // Doctor 09:00–18:00, clinic 10:00–13:00 → the intersection is offered.
    nextConfig = cfg({}, { wed: { open: '10:00', close: '13:00' } });
    const slots = await slotsFor(WED);

    assert.equal(slots[0], '10:00', 'first offered slot is the clinic open time');
    assert.equal(slots[slots.length - 1], '12:30', 'last offered slot starts before close');
    assert.ok(!slots.includes('09:00'), 'a pre-open doctor slot is not offered');
    assert.ok(!slots.includes('13:00'), 'the close time itself is not offered');
  });
});

// ── rule 2: holidays ────────────────────────────────────────────────────────
describe('F-006 holidays — dated closures in the clinic-local frame', () => {
  const withHoliday = () => cfg({}, { holidays: [{ date: THU, name: 'Bonalu' }] });

  it('rejects a booking on a configured holiday and names it', async () => {
    nextConfig = withHoliday();
    const r = await book(THU, '10:00');
    assert.equal(r.success, false);
    assert.equal(r.reason, 'holiday');
    assert.equal(r.holiday_name, 'Bonalu');
    assert.match(r.error, /closed on 2026-07-23 \(Bonalu\)/);
    assert.equal(lastInsertParams, null);
  });

  it('availability offers nothing on a holiday', async () => {
    nextConfig = withHoliday();
    const a = await avail(THU);
    assert.equal(a.reason, 'holiday');
    assert.equal(a.available, undefined);
  });

  it('covers the holiday\'s FIRST and LAST minute in IST — and stops at the IST midnight', async () => {
    nextConfig = withHoliday();

    // Each instant below is labelled in UTC, so its UTC date DISAGREES with its
    // IST date — which is exactly what makes the frame observable.

    // 2026-07-22 18:30 UTC is 2026-07-23 00:00 IST: the holiday's first minute,
    // while still the 22nd in UTC. A UTC-framed check would let it through.
    const first = await bookISO('2026-07-22T18:30:00+00:00');
    assert.equal(first.reason, 'holiday', 'the first IST minute of the holiday is closed');

    // 2026-07-23 18:29 UTC is 2026-07-23 23:59 IST: the holiday's last minute.
    const last = await bookISO('2026-07-23T18:29:00+00:00');
    assert.equal(last.reason, 'holiday', 'the last IST minute of the holiday is closed');

    // One minute later is 2026-07-24 00:00 IST — no longer the holiday, though
    // it is STILL the 23rd in UTC. Refused for opening hours, not as a holiday.
    const after = await bookISO('2026-07-23T18:30:00+00:00');
    assert.equal(after.reason, 'outside_hours', 'past IST midnight the holiday no longer applies');
  });

  it('over-block guard: the day after the holiday books normally', async () => {
    nextConfig = withHoliday();
    const r = await book(FRI, '10:00');
    assert.equal(r.success, true);
  });
});

// ── rule 3: advance_days ────────────────────────────────────────────────────
describe('F-006 advance_days — the booking window', () => {
  // today = 2026-07-21, advance_days = 7 → latest bookable is 2026-07-28.
  const LATEST = '2026-07-28';
  const PAST_WINDOW = '2026-07-29';

  it('accepts a booking exactly advance_days out', async () => {
    nextConfig = cfg({ advance_days: 7 }, { holidays: [] });
    const r = await book(LATEST, '10:00');
    assert.equal(r.success, true, 'the last day of the window is bookable');
  });

  it('rejects a booking one day beyond the window, naming the latest bookable date', async () => {
    nextConfig = cfg({ advance_days: 7 });
    const r = await book(PAST_WINDOW, '10:00');
    assert.equal(r.success, false);
    assert.equal(r.reason, 'beyond_advance_window');
    assert.equal(r.advance_days, 7);
    assert.equal(r.latest_bookable_date, LATEST);
    assert.equal(lastInsertParams, null);
  });

  it('availability refuses the same out-of-window date it would not book', async () => {
    nextConfig = cfg({ advance_days: 7 });
    const beyond = await avail(PAST_WINDOW);
    assert.equal(beyond.reason, 'beyond_advance_window');
    assert.equal(beyond.available, undefined);

    const inside = await slotsFor(LATEST);
    assert.ok(inside.length > 0, 'the last in-window day still offers slots');
  });
});

// ── rule 4: allow_same_day ──────────────────────────────────────────────────
describe('F-006 allow_same_day — whether today is bookable at all', () => {
  it('when false, today is not bookable and not offered', async () => {
    nextConfig = cfg({ allow_same_day: false });

    const r = await book(TODAY, '14:00');
    assert.equal(r.success, false);
    assert.equal(r.reason, 'same_day_not_allowed');
    assert.equal(r.earliest_date, WED);
    assert.equal(lastInsertParams, null);

    const a = await avail(TODAY);
    assert.equal(a.reason, 'same_day_not_allowed');
    assert.equal(a.available, undefined);
  });

  it('when false, tomorrow is still bookable (over-block guard)', async () => {
    nextConfig = cfg({ allow_same_day: false });
    const r = await book(WED, '14:00');
    assert.equal(r.success, true);
  });

  it('when true, today books — but stays subject to every other rule', async () => {
    nextConfig = cfg({ allow_same_day: true });
    const ok = await book(TODAY, '14:00');
    assert.equal(ok.success, true, 'same-day is allowed');

    // Same day, same flag — but now outside the clinic's hours.
    nextConfig = cfg({ allow_same_day: true }, { tue: { open: '09:00', close: '13:00' } });
    const late = await book(TODAY, '14:00');
    assert.equal(late.success, false, 'allow_same_day does not exempt today from hours');
    assert.equal(late.reason, 'outside_hours');

    // …and it does not exempt today from the past-time check either.
    nextConfig = cfg({ allow_same_day: true });
    const past = await book(TODAY, '09:30'); // now is 10:00 IST
    assert.equal(past.success, false, 'allow_same_day does not resurrect a past slot');
    assert.equal(past.reason, 'past');
  });
});

// ── rule 5: buffer_minutes ──────────────────────────────────────────────────
describe('F-006 buffer_minutes — minimum notice', () => {
  it('rejects a booking sooner than now + buffer, accepts one exactly at now + buffer', async () => {
    nextConfig = cfg({ buffer_minutes: 60 }); // now = 10:00 IST

    const tooSoon = await book(TODAY, '10:30');
    assert.equal(tooSoon.success, false, '10:30 is only 30 minutes out');
    assert.equal(tooSoon.reason, 'too_soon');
    assert.equal(tooSoon.buffer_minutes, 60);
    assert.equal(lastInsertParams, null);

    const exactly = await book(TODAY, '11:00');
    assert.equal(exactly.success, true, 'exactly now + 60 minutes is bookable');
  });

  it('over-block guard: with no buffer the same near slot books', async () => {
    nextConfig = cfg({ buffer_minutes: 0 });
    const r = await book(TODAY, '10:30');
    assert.equal(r.success, true);
  });

  it('availability withholds the slots the buffer makes unbookable', async () => {
    nextConfig = cfg({ buffer_minutes: 60 });
    const slots = await slotsFor(TODAY);
    assert.ok(!slots.includes('10:30'), '10:30 is inside the buffer — never offered');
    assert.equal(slots[0], '11:00', 'the first offered slot is now + buffer');
  });
});

// ── both sides agree ────────────────────────────────────────────────────────
describe('F-006 parity — check_availability never offers what booking refuses', () => {
  it('every offered slot books successfully, under all five rules at once', async () => {
    nextConfig = cfg(
      { advance_days: 7, buffer_minutes: 60, allow_same_day: true, slot_minutes: 30 },
      { tue: { open: '10:00', close: '16:00' }, wed: { closed: true }, holidays: [{ date: THU, name: 'Bonalu' }] },
    );

    for (const date of [TODAY, WED, THU, FRI, '2026-07-28', '2026-07-29']) {
      const res = await avail(date);
      if (!res.available) {
        assert.ok(res.reason, `${date} refused without a structured reason`);
        continue;
      }
      for (const slot of res.available[0].free_slots) {
        const r = await book(date, slot);
        assert.equal(r.success, true, `${date} ${slot} was offered but booking refused it: ${r.error}`);
      }
    }
  });

  it('the previously divergent case: a part-minute clock no longer offers a slot the write refuses', async () => {
    // Before F-006 availability floored `now` to the minute (10:00) and offered
    // the 10:00 slot, while the write compared exact instants and refused it as
    // past. The shared cutoff rounds UP, so it is no longer offered.
    freeze('2026-07-21T04:30:45Z'); // 10:00:45 IST
    nextConfig = cfg({ buffer_minutes: 0 });

    const slots = await slotsFor(TODAY);
    assert.ok(!slots.includes('10:00'), '10:00 has already started — not offered');

    const refused = await book(TODAY, '10:00');
    assert.equal(refused.success, false, 'and the write still refuses it');
    assert.equal(refused.reason, 'past');

    const offered = await book(TODAY, slots[0]);
    assert.equal(offered.success, true, 'the first slot actually offered does book');
  });
});

// ── configless / partial tenants ────────────────────────────────────────────
describe('F-006 defaults — a tenant with no booking config behaves sanely', () => {
  it('falls back to clinicDefaults rules with one config_fallback WARN, and is NOT locked out', async () => {
    nextConfig = null;

    const ok = await book(WED, '10:00'); // Wed, clinicDefaults 09:00–18:00
    assert.equal(ok.success, true, 'a configless tenant can still book a normal weekday slot');

    const warn = warnCalls.find((c) => c[0] && c[0].scope === 'config_fallback');
    assert.ok(warn, 'a config_fallback WARN is emitted');
    assert.equal(warn[0].reason, 'no_config');
    assert.equal(warn[0].slot_minutes, 30);
    assert.deepEqual(
      warn[0].missing,
      ['slot_minutes', 'advance_days', 'buffer_minutes', 'allow_same_day', 'hours'],
      'the WARN names every field that fell back',
    );
  });

  it('applies the clinicDefaults hours and window to a configless tenant', async () => {
    nextConfig = null;

    const sunday = await book(SUN, '10:00'); // clinicDefaults: sun is closed
    assert.equal(sunday.success, false);
    assert.equal(sunday.reason, 'closed_day');

    const saturdayLate = await book('2026-07-25', '15:00'); // clinicDefaults sat 09:00–14:00
    assert.equal(saturdayLate.success, false);
    assert.equal(saturdayLate.reason, 'outside_hours');

    const beyond = await book('2026-09-01', '10:00'); // > default advance_days (30)
    assert.equal(beyond.success, false);
    assert.equal(beyond.reason, 'beyond_advance_window');
  });

  it('a partial config keeps the fields it has and defaults the rest', async () => {
    nextConfig = { booking: { slot_minutes: 30, advance_days: 7, buffer_minutes: 0, allow_same_day: true } }; // no hours

    const warnBefore = warnCalls.length;
    const sunday = await book(SUN, '10:00');
    assert.equal(sunday.reason, 'closed_day', 'missing hours fall back to clinicDefaults');

    const warn = warnCalls.slice(warnBefore).find((c) => c[0] && c[0].scope === 'config_fallback');
    assert.deepEqual(warn[0].missing, ['hours'], 'only the missing section is reported');
    assert.equal(warn[0].reason, 'field_missing');
  });

  it('a malformed day entry falls back to that day\'s default rather than reading as open-all-hours', async () => {
    // getTenantConfig never throws on a stale document, so an entry matching
    // neither union branch must not silently become "always open".
    nextConfig = cfg({}, { wed: {} });

    const early = await book(WED, '08:00');
    assert.equal(early.success, false, 'the clinicDefaults 09:00 open still applies');
    assert.equal(early.reason, 'outside_hours');

    const ok = await book(WED, '10:00');
    assert.equal(ok.success, true);
  });
});
