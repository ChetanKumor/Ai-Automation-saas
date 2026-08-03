'use strict';

// F3-A — the onboarding wizard had no way out.
//
// Progress ALREADY persisted before this session: persistStep writes
// meta.onboarding_step on every goTo, and main() resumes from it on boot
// (public/portal/wizard.js). What was missing was the CONTROL — spec §3.8's
// "Save and finish later", top right, on every step. An owner mid-wizard on a
// phone could go forward, go back, or abandon the product.
//
// ── Why these are SOURCE assertions ──────────────────────────────────────────
// wizard.js is a browser IIFE with no exports and this repo has no DOM library
// in its dependency tree (no jsdom, no happy-dom, and no test uses one), so the
// only in-suite instrument is source text — the precedent set by
// portalShadowNotice.unit.test.js and portalTestComposer.unit.test.js. These pin
// the SHAPE of the fix. The behavioural proof is the CDP run in
// scripts/portal/f3.js: the phone repro at 380px, the clean-card exit, the
// dirty-and-invalid exit, and the touch-target measurement.
//
// What the shape assertions are actually worth: the standing hazard in this file
// is not that the exit button disappears, it is that someone later "fixes" an
// exit bug by giving the control its own fetch to a config endpoint. That is the
// one thing the wizard has never had and must never have (wizard.js's own header
// comment: "This file never re-implements a form or a write path"), and the
// third test below is what fails if it happens.

process.env.LOG_LEVEL = 'silent';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const P = (f) => path.join(__dirname, '../../public/portal/', f);
const JS = fs.readFileSync(P('wizard.js'), 'utf8');
const HTML = fs.readFileSync(P('wizard.html'), 'utf8');
const CSS = fs.readFileSync(P('wizard.css'), 'utf8');

// Comments stripped before matching: this change's own comments quote the
// endpoints and the mechanisms the tests exist to constrain, so an unstripped
// search would match the prose rather than the code.
const CODE = JS
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

const onExit = (CODE.match(/function onExitClick\(\)\s*\{[\s\S]*?\n {2}\}/) || [''])[0];

describe('Onboarding wizard exit (F3-A)', () => {
  it('offers the exit control in the wizard chrome, above the card, on every step', () => {
    assert.match(HTML, /id="wizExit"/, 'the exit control is missing from wizard.html');
    assert.match(HTML, /id="wizExit"[^>]*>\s*Save and finish later/,
      'spec §3.8 names the control "Save and finish later"');

    // Above the card and outside the footer nav: it must render on the Review
    // step too, and .wiz__nav is below the iframe — an exit an owner has to
    // scroll a long Hours form to reach is not "always available".
    const progress = (HTML.match(/<div class="wiz__progress">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
    assert.match(progress, /id="wizExit"/,
      'the exit control must live in .wiz__progress — the wizard chrome above the card');
    const nav = (HTML.match(/<div class="wiz__nav">[\s\S]*?<\/div>/) || [''])[0];
    assert.doesNotMatch(nav, /id="wizExit"/, 'the exit control must not be in the footer nav');

    // Nothing in renderStep may hide it: it is not in the review/form/multi
    // branching at all, which is what makes "on every step" structural.
    const render = (CODE.match(/function renderStep\(\)[\s\S]*?\n {2}\}/) || [''])[0];
    assert.doesNotMatch(render, /wizExit/,
      'renderStep must not touch the exit control — per-step visibility is how it stops being always available');
  });

  it('saves through the step\'s existing save path, never a second one', () => {
    assert.ok(onExit, 'onExitClick is gone');
    assert.match(onExit, /form\.requestSubmit\(\)/,
      'the dirty exit must trigger the embedded page\'s OWN submit');
    assert.match(onExit, /watchIframeSave\(/,
      'success/failure must be inferred by the same watcher Continue uses');
    assert.doesNotMatch(onExit, /fetch\(/,
      'the exit path must not issue its own request — that is a second save path');
  });

  it('adds no new endpoint to the wizard', () => {
    // wizard.js's header: "This file never re-implements a form or a write
    // path." Its whole surface is two routes, and this session added neither.
    const urls = [...CODE.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual([...new Set(urls)], ['/portal/api/onboarding', '/portal/api/readiness'],
      'wizard.js may only ever call the onboarding and readiness routes');
  });

  it('exits without saving when the card is clean', () => {
    assert.match(onExit, /if\s*\(step\.kind\s*!==\s*'form'\s*\|\|\s*!stepIsDirty\(\)\)\s*\{\s*exitToHome\(\)/,
      'a clean card (or a step with no page-level form) must leave without a save');

    // Dirty comes from the class the embedded page already writes — the same
    // signal shell.js's sticky save bar observes. A private flag here would be
    // a second source of truth for one fact.
    const isDirty = (CODE.match(/function stepIsDirty\(\)[\s\S]*?\n {2}\}/) || [''])[0];
    assert.match(isDirty, /save-note--dirty/,
      'dirty must be read from the page\'s own #saveNote class, not a new flag');
  });

  it('keeps the owner on the step when the save is rejected', () => {
    // The embedded page has painted its own inline field errors by this point.
    // Leaving here would discard what the owner typed on the way out — the one
    // failure mode this control could introduce.
    const rejected = (onExit.match(/success === false\)\s*\{([\s\S]*?)\}\s*else/) || [])[1];
    assert.ok(rejected, 'onExitClick has no rejected-save branch');
    assert.doesNotMatch(rejected, /window\.location|exitToHome/,
      'a rejected save must not navigate — the owner\'s unsaved input would be lost');
    assert.match(rejected, /wizSaveNote/, 'the rejection must be stated on screen');
  });

  it('persists the resume point before leaving, including from step 0', () => {
    const exitTo = (CODE.match(/function exitToHome\(\)[\s\S]*?\n {2}\}/) || [''])[0];
    assert.match(exitTo, /persistStep\(state\.step\)/,
      'exit must persist the CURRENT step — goTo never runs for step 0, which main() renders directly');
    assert.match(exitTo, /\.then\([\s\S]*?window\.location\.href = 'index\.html'/,
      'navigation must wait for the write — navigating cancels an in-flight fetch');
  });

  it('cannot fire two submits at one form', () => {
    // Continue and the exit control drive the same form.requestSubmit(). Both
    // go inactive for the length of either request; disabled is this portal's
    // only double-submit guard (spec §2.9 deviation, recorded at D5a).
    const busy = (CODE.match(/function setNavBusy\(pressed\)[\s\S]*?\n {2}\}/) || [''])[0];
    assert.ok(busy, 'setNavBusy is gone');
    assert.match(busy, /cont\.disabled = !!pressed/, 'Continue must go inactive while either save runs');
    assert.match(busy, /exit\.disabled = !!pressed/, 'the exit control must go inactive while either save runs');
    assert.match(onExit, /setNavBusy\('exit'\)/, 'the exit path must take the busy state');
  });

  it('watches the embedded save by observation, not by sampling', () => {
    // Found by A's evidence run and PRE-EXISTING since S16, shared with
    // Continue: watchIframeSave polled saveBtn.disabled every 120ms, and a
    // validation 400 opens and closes that window in single-digit milliseconds.
    // When the poll missed it the watcher sat out its 20s timeout and reported a
    // rejected save as a hung one. A finer poll would have narrowed the window
    // and kept the bug, so the interval is gone rather than tuned.
    const watch = (CODE.match(/function watchIframeSave\([\s\S]*?\n {2}\}/) || [''])[0];
    assert.ok(watch, 'watchIframeSave is gone');
    assert.doesNotMatch(watch, /setInterval/,
      'a sampled watcher cannot see a transition shorter than its interval');
    assert.match(watch, /MutationObserver/, 'the save must be observed, not sampled');
    assert.match(watch, /let sawBusy = btn\.disabled/,
      'busy must be seeded from live state — requestSubmit() dispatches synchronously, ' +
      'so the true transition has already happened by the time the observer attaches');
  });

  it('needs no touch-target rule of its own — .btn is already 44px on mobile', () => {
    // D5b pinned `.btn { height: 44px }` at ≤860px (tokens.css). If the exit
    // control ever stops being a plain `.btn`, it silently drops under the
    // touch floor the way `.golive .btn` did, and this is the tripwire.
    assert.match(HTML, /class="btn wiz__exit"/,
      'the exit control must stay a plain .btn or it loses the ≤860px 44px height');
    assert.match(CSS, /\.wiz__exit \{[^}]*flex: none/,
      'the exit control must not shrink — the step label is what wraps at 320px');
  });
});
