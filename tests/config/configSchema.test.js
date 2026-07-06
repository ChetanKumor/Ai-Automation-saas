'use strict';

// Pure schema tests (no DB). Proves the strict contract: full doc + defaults
// pass; unknown keys, cross-field refinements, and field-level validators all
// reject at the right path.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { configSchema } = require('../../src/modules/config/schema');
const { clinicDefaults } = require('../../src/modules/config/defaults');

// A fresh, deep clone of the defaults to mutate per test (defaults must stay
// pristine — the schema/merge never mutate it either).
const valid = () => JSON.parse(JSON.stringify(clinicDefaults));

// Collect issue paths as dotted strings for readable assertions.
const paths = (err) => err.issues.map((i) => i.path.join('.'));
const codes = (err) => err.issues.map((i) => i.code);

describe('config schema — happy path', () => {
  it('clinicDefaults alone is a fully valid document', () => {
    const r = configSchema.safeParse(clinicDefaults);
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues, null, 2));
  });

  it('a complete document passes', () => {
    assert.equal(configSchema.safeParse(valid()).success, true);
  });

  it('does not mutate clinicDefaults during parse', () => {
    const snapshot = JSON.stringify(clinicDefaults);
    configSchema.parse(clinicDefaults);
    assert.equal(JSON.stringify(clinicDefaults), snapshot);
  });

  it('applies field defaults when omitted (retention_days, crm.extraction.voice)', () => {
    const doc = valid();
    delete doc.retention_days;
    delete doc.crm.extraction.voice;
    const r = configSchema.parse(doc);
    assert.equal(r.retention_days, 365);
    assert.equal(r.crm.extraction.voice, 'off'); // Issue 3 default
  });
});

describe('config schema — strict unknown-key rejection', () => {
  it('rejects an unknown top-level key', () => {
    const doc = valid();
    doc.surprise = true;
    const r = configSchema.safeParse(doc);
    assert.equal(r.success, false);
    assert.ok(codes(r.error).includes('unrecognized_keys'), 'unrecognized_keys reported');
    assert.ok(r.error.issues.some((i) => (i.keys || []).includes('surprise')), 'names the offending key');
  });

  it('rejects an unknown nested key with the container path', () => {
    const doc = valid();
    doc.business.bogus = 1;
    const r = configSchema.safeParse(doc);
    assert.equal(r.success, false);
    const issue = r.error.issues.find((i) => i.code === 'unrecognized_keys');
    assert.deepEqual(issue.path, ['business']);
    assert.ok(issue.keys.includes('bogus'));
  });
});

describe('config schema — cross-field refinements', () => {
  it('languages.default must be within supported', () => {
    const doc = valid();
    doc.languages = { supported: ['en'], default: 'te' };
    // greeting/consent already cover en; te not supported, so only the default refine should fire here.
    doc.greeting = { en: 'hi' };
    doc.recording_consent.line = { en: 'consent' };
    const r = configSchema.safeParse(doc);
    assert.equal(r.success, false);
    assert.ok(paths(r.error).includes('languages.default'), `got ${JSON.stringify(paths(r.error))}`);
  });

  it('greeting missing a supported language → path-level error', () => {
    const doc = valid();
    delete doc.greeting.te;
    const r = configSchema.safeParse(doc);
    assert.equal(r.success, false);
    assert.ok(paths(r.error).includes('greeting.te'), `got ${JSON.stringify(paths(r.error))}`);
  });

  it('recording_consent.line missing a supported language → path-level error', () => {
    const doc = valid();
    delete doc.recording_consent.line.hi;
    const r = configSchema.safeParse(doc);
    assert.equal(r.success, false);
    assert.ok(paths(r.error).includes('recording_consent.line.hi'), `got ${JSON.stringify(paths(r.error))}`);
  });

  it('a stray (non-language) greeting key is rejected', () => {
    const doc = valid();
    doc.greeting.fr = 'bonjour';
    const r = configSchema.safeParse(doc);
    assert.equal(r.success, false);
    assert.ok(paths(r.error).includes('greeting.fr'), `got ${JSON.stringify(paths(r.error))}`);
  });
});

describe('config schema — field validators', () => {
  it('rejects a bad E.164 escalation number at its index', () => {
    const doc = valid();
    doc.escalation.phone_numbers = ['+919876543210', '12345'];
    const r = configSchema.safeParse(doc);
    assert.equal(r.success, false);
    assert.ok(paths(r.error).includes('escalation.phone_numbers.1'), `got ${JSON.stringify(paths(r.error))}`);
  });

  it('accepts a valid E.164 owner number', () => {
    const doc = valid();
    doc.notifications.owner_numbers = ['+14155550100'];
    assert.equal(configSchema.safeParse(doc).success, true);
  });

  it('rejects hours where open >= close', () => {
    const doc = valid();
    doc.hours.mon = { open: '18:00', close: '09:00' };
    const r = configSchema.safeParse(doc);
    assert.equal(r.success, false);
    assert.ok(JSON.stringify(paths(r.error)).includes('mon'), `got ${JSON.stringify(paths(r.error))}`);
  });

  it('accepts a closed day', () => {
    const doc = valid();
    doc.hours.tue = { closed: true };
    assert.equal(configSchema.safeParse(doc).success, true);
  });

  it('rejects a day carrying both closed and open/close (union strictness)', () => {
    const doc = valid();
    doc.hours.wed = { closed: true, open: '09:00', close: '18:00' };
    assert.equal(configSchema.safeParse(doc).success, false);
  });

  it('enforces retention_days bounds (30–3650)', () => {
    for (const bad of [29, 3651, 0, -1]) {
      const doc = valid();
      doc.retention_days = bad;
      assert.equal(configSchema.safeParse(doc).success, false, `retention_days=${bad} should fail`);
    }
    for (const ok of [30, 365, 3650]) {
      const doc = valid();
      doc.retention_days = ok;
      assert.equal(configSchema.safeParse(doc).success, true, `retention_days=${ok} should pass`);
    }
  });

  it('booking bounds: non-positive slot_minutes rejected', () => {
    const doc = valid();
    doc.booking.slot_minutes = 0;
    assert.equal(configSchema.safeParse(doc).success, false);
  });

  it('voice.did accepts null and a valid E.164, rejects garbage', () => {
    const nullDoc = valid(); nullDoc.voice.did = null;
    assert.equal(configSchema.safeParse(nullDoc).success, true);
    const okDoc = valid(); okDoc.voice.did = '+919876500000';
    assert.equal(configSchema.safeParse(okDoc).success, true);
    const badDoc = valid(); badDoc.voice.did = 'not-a-number';
    assert.equal(configSchema.safeParse(badDoc).success, false);
  });
});
