'use strict';

// Unit tests for the COLLECTIONS_ENABLED flag gate (F-010).
// Stubs out all I/O (DB, cron, actions registry) so no real resources are touched.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Stub: isolated actions registry (does NOT pollute global core/actions Map) ──
let registered = {};
const actionsPath = require.resolve('../../core/actions');
require.cache[actionsPath] = {
  id: actionsPath, filename: actionsPath, loaded: true,
  exports: {
    register: (name, fn) => { registered[name] = fn; },
    execute: async (name, params, ctx) => {
      const h = registered[name];
      return h ? h(params, ctx) : { skipped: true };
    },
  },
};

// ── Stub: collectionsCron — records start() calls, returns a no-op task ──
let cronStarted = false;
const mockCronTask = { stop: () => {} };
const cronPath = require.resolve('../../src/modules/collections/collectionsCron');
require.cache[cronPath] = {
  id: cronPath, filename: cronPath, loaded: true,
  exports: { start: () => { cronStarted = true; return mockCronTask; } },
};

// ── Stub: db — prevents any real DB calls ──
const dbPath = require.resolve('../../src/db/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: async () => ({ rows: [] }) },
};

// ── Stub: collectionsService ──
const svcPath = require.resolve('../../src/modules/collections/collectionsService');
require.cache[svcPath] = {
  id: svcPath, filename: svcPath, loaded: true,
  exports: { schedulePayment: async () => ({}), markPaid: async () => ({}) },
};

describe('COLLECTIONS_ENABLED flag (F-010)', () => {
  let colMod;

  beforeEach(() => {
    registered = {};
    cronStarted = false;
    // Fresh module instance so init() state is clean
    const colPath = require.resolve('../../src/modules/collections');
    delete require.cache[colPath];
    colMod = require('../../src/modules/collections');
  });

  it('flag OFF (init not called): no actions registered, cronTask undefined, cron not started', () => {
    // Deliberately do NOT call colMod.init() — mirrors COLLECTIONS_ENABLED=false gate in server.js
    assert.equal(registered['schedule_payment_reminder'], undefined,
      'schedule_payment_reminder must not be registered when collections is OFF');
    assert.equal(registered['mark_payment_received'], undefined,
      'mark_payment_received must not be registered when collections is OFF');
    assert.equal(colMod.cronTask, undefined,
      'cronTask must be undefined when collections is OFF');
    assert.equal(cronStarted, false,
      'cron must not start when collections is OFF');
  });

  it('flag ON (init called): both actions registered, cron started, cronTask set', () => {
    colMod.init();

    assert.ok(registered['schedule_payment_reminder'],
      'schedule_payment_reminder must be registered when collections is ON');
    assert.ok(registered['mark_payment_received'],
      'mark_payment_received must be registered when collections is ON');
    assert.equal(cronStarted, true, 'cron must start when collections is ON');
    assert.strictEqual(colMod.cronTask, mockCronTask,
      'cronTask must be the value returned by cron.start()');
  });

  it('flag ON then shutdown: cronTask.stop() is callable (shutdown guard)', () => {
    colMod.init();
    // Mirrors the server.js shutdown: `if (collectionsTask) collectionsTask.stop()`
    const task = colMod.cronTask;
    assert.ok(task, 'cronTask must be set after init()');
    assert.doesNotThrow(() => task.stop(), 'cronTask.stop() must not throw');
  });

  it('flag OFF: shutdown guard holds — cronTask falsy, stop never called', () => {
    // No init() call; mimic server shutdown path
    const task = colMod.cronTask;
    assert.ok(!task, 'cronTask must be falsy when flag is OFF');
    // The guard `if (collectionsTask) collectionsTask.stop()` skips stop() safely
    let stopCalled = false;
    if (task) { task.stop(); stopCalled = true; }
    assert.equal(stopCalled, false, 'stop() must not be called when collectionsTask is falsy');
  });
});
