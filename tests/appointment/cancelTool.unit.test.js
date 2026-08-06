'use strict';

// B2-R1 — the cancel tool's DECLARATION, pinned.
//
// The gate itself is enforced server-side and proven behaviourally in
// tests/appointment/cancel.integration.test.js (an omitted `confirmed` cancels
// nothing, against a real database). What this file pins is the half of the
// contract that lives in the declaration handed to Gemini, and which no
// behavioural test can reach: that `confirmed` is a REQUIRED parameter rather
// than an optional one the model can omit into, and that TOOL_META marks the
// tool mutating.
//
// ⚠️ These are SOURCE-SHAPE assertions, and deliberately so. `TOOLS` and
// `TOOL_META` are module-private in aiService.js — exporting them purely to
// test them would widen a runtime module's surface for no runtime consumer,
// which is the trade tests/portal/portalTestComposer.unit.test.js already made
// for the same reason. Requiring aiService here would also construct the Gemini
// SDK client at import. Reading the file as text costs neither.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'modules', 'ai', 'aiService.js'), 'utf8');

// The `cancel_appointment` object literal inside the TOOLS declaration array.
const DECL = SRC.slice(
  SRC.indexOf("name: 'cancel_appointment'"),
  SRC.indexOf('}];', SRC.indexOf("name: 'cancel_appointment'")));

describe('cancel_appointment declaration (B2-R1)', () => {
  it('is declared as a tool at all', () => {
    assert.ok(SRC.includes("name: 'cancel_appointment'"), 'the tool is declared');
    assert.ok(DECL.length > 0);
  });

  it('marks confirmed REQUIRED — not an optional the model can omit into', () => {
    assert.match(DECL, /required:\s*\['appointment_time',\s*'confirmed'\]/,
      '`confirmed` must be in the required list; an optional boolean is a suggestion, not a gate');
  });

  it('gives confirmed an explicit two-call description', () => {
    assert.match(DECL, /confirmed:\s*\{\s*type:\s*'boolean'/, 'declared as a boolean');
    // The model has to be told what each value MEANS, not just that it exists.
    assert.match(DECL, /false on the FIRST call/);
    assert.match(DECL, /Never send true on your first call/);
  });

  it('tells the model the first call cancels nothing and the action is irreversible', () => {
    assert.match(DECL, /TWO CALLS ARE REQUIRED/);
    assert.match(DECL, /CANNOT be undone/);
    // And routes the "I just want a different time" case away from destruction.
    assert.match(DECL, /use reschedule_appointment instead/);
  });

  it('carries NO appointment id parameter — the lookup stays server-side', () => {
    assert.ok(!/appointment_id/.test(DECL),
      'an identifier the model can read back to a caller eventually will be');
    assert.match(DECL, /appointment_time:\s*\{\s*type:\s*'string'/,
      'the appointment is resolved from (tenant, customer, time), as the move is');
  });

  it('is registered in TOOL_META as mutating', () => {
    assert.match(SRC, /cancel_appointment:\s*\{\s*mutating:\s*true\s*\}/,
      'one declaration name covers both phases, so the flag must describe the destructive one');
  });

  it('the system prompt tail names the tool and its two-call discipline', () => {
    assert.match(SRC, /call cancel_appointment TWICE/);
    assert.match(SRC, /Never send confirmed=true on your first call/);
    assert.match(SRC, /that is reschedule_appointment, not a cancellation/);
    // The pre-existing booking lines are untouched — this session added, it did
    // not rewrite the block.
    assert.match(SRC, /Never call book_appointment on first mention — confirm first, book second/);
  });
});
