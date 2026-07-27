'use strict';

// F-F001 — the portal reports success for edits that are silently inert.
//
// On a clinic with a non-null `tenants.ai_prompt`, aiService short-circuits the
// config read (`aiService.js:468-469`) and returns the hand-written script
// verbatim (`:400-405`), so every prompt field the portal writes is inert. The
// owner was shown "Saved · v{N}" and a readiness row reading "Using the latest
// instruction format" — a success state that lies.
//
// These tests cover the OWNER-FACING half only. The backend behaviour is
// deliberate, documented and out of scope here; what must hold is that the
// portal stops asserting the reassuring case, and that it distinguishes what is
// shadowed from what still works (A-007).
//
// No DB and no DOM: shadow-notice.js is UMD-lite (cf. booking-summary.js), so
// node requires the exact file the browser loads. The DOM-side wiring in
// shell.js/home.js and the per-page script tags are asserted against source,
// following the precedent in portalOnboarding.integration.test.js.

process.env.LOG_LEVEL = 'silent';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SN = require('../../public/portal/shadow-notice');
const { CHECK_NAMES } = require('../../src/modules/validation/validationService');

const PORTAL = path.join(__dirname, '../../public/portal');
const read = (f) => fs.readFileSync(path.join(PORTAL, f), 'utf8');

// Readiness runs as the portal actually receives them (name+severity only —
// readinessSnapshot strips the operator `detail`).
const runWith = (severity) => ({
  passed: true,
  checks: [
    { name: 'config.exists', severity: 'pass' },
    { name: 'hours.sane', severity: 'pass' },
    { name: SN.CHECK_NAME, severity },
  ],
  skipped: [],
});
const SHADOWED_RUN = runWith('warn');
const CLEAN_RUN = runWith('pass');
// A run from before this check existed, or any run that didn't record it.
const RUN_WITHOUT_CHECK = { passed: true, checks: [{ name: 'config.exists', severity: 'pass' }], skipped: [] };

// Page ids (<body data-page>) → the HTML file that declares them.
const PAGE_FILES = {
  profile: 'clinic-profile.html',
  hours: 'hours.html',
  pricing: 'pricing.html',
  booking: 'booking-rules.html',
  receptionist: 'receptionist.html',
  safety: 'safety.html',
  knows: 'knows.html',
};

describe('F-F001 shadow notice — the verdict', () => {
  it('a clinic whose check WARNS is shadowed', () => {
    assert.equal(SN.isShadowed(SHADOWED_RUN), true);
  });

  it('a clinic whose check PASSES is not shadowed', () => {
    assert.equal(SN.isShadowed(CLEAN_RUN), false);
  });

  // The honesty case. /api/readiness reads the LATEST PERSISTED run and never
  // triggers a new one, so a clinic that has never been validated has no
  // verdict at all. Guessing either way swaps one false claim for another.
  it('returns null — not a guess — when there is no evidence', () => {
    assert.equal(SN.isShadowed(null), null, 'no readiness payload');
    assert.equal(SN.isShadowed(undefined), null, 'undefined run');
    assert.equal(SN.isShadowed({}), null, 'run with no checks array');
    assert.equal(SN.isShadowed({ checks: null }), null, 'checks not an array');
    assert.equal(SN.isShadowed(RUN_WITHOUT_CHECK), null, 'run predates the check');
  });

  it('reads the same check name validationService actually emits', () => {
    assert.ok(CHECK_NAMES.includes(SN.CHECK_NAME),
      `${SN.CHECK_NAME} must exist in the validation catalog — otherwise the notice can never fire`);
  });
});

describe('F-F001 shadow notice — which pages warn', () => {
  it('every page that writes a shadowed config path is covered (A-007)', () => {
    assert.deepEqual(Object.keys(SN.SHADOWED).sort(),
      ['booking', 'hours', 'knows', 'pricing', 'profile', 'receptionist', 'safety']);
  });

  // The other half of A-007. These bypass the prompt head — doctors read
  // tenant_entities, FAQs/documents are injected into the prompt TAIL — so they
  // work normally and a notice on them would itself be false.
  it('pages whose data still reaches the receptionist do NOT warn', () => {
    for (const page of ['doctors', 'faqs', 'history', 'test', 'home', 'wizard']) {
      assert.equal(SN.pageNotice(page), null, `${page} is not shadowed and must not warn`);
      assert.equal(SN.noticeHtml(page, SHADOWED_RUN), '', `${page} must render no notice`);
    }
  });

  it('an unknown page id renders nothing', () => {
    assert.equal(SN.noticeHtml('does-not-exist', SHADOWED_RUN), '');
  });
});

describe('F-F001 shadow notice — what the owner is told', () => {
  it('renders on a shadowed page for a shadowed clinic', () => {
    const html = SN.noticeHtml('pricing', SHADOWED_RUN);
    assert.ok(html.includes('shadow-notice'), 'expected the notice markup');
    assert.ok(html.includes(SN.TITLE));
  });

  it('renders NOTHING for a clinic that is not shadowed, or when unknown', () => {
    assert.equal(SN.noticeHtml('pricing', CLEAN_RUN), '', 'clean clinic must see no warning');
    assert.equal(SN.noticeHtml('pricing', null), '', 'unknown verdict must stay silent');
    assert.equal(SN.noticeHtml('pricing', RUN_WITHOUT_CHECK), '', 'no check recorded → silent');
  });

  // The requirement that gets missed: an owner needs to know WHICH of their
  // edits are inert, not merely that something is wrong.
  it('names the settings THIS page loses, not a generic failure', () => {
    const expect = {
      profile: /name, address, phone numbers and languages/i,
      hours: /opening hours and holiday closures/i,
      pricing: /your prices/i,
      booking: /booking wording/i,
      receptionist: /name, tone, reply length and greeting/i,
      safety: /handoff and escalation wording/i,
      knows: /clinic details on this page/i,
    };
    for (const [page, re] of Object.entries(expect)) {
      const html = SN.noticeHtml(page, SHADOWED_RUN);
      assert.match(html, re, `${page} must name its own shadowed settings`);
    }
  });

  // A warning implying the whole portal is dead would be its own falsehood.
  it('every notice also states what still works', () => {
    for (const page of Object.keys(SN.SHADOWED)) {
      const html = SN.noticeHtml(page, SHADOWED_RUN);
      assert.ok(html.includes(SN.SURVIVES), `${page} must say what still works`);
      assert.match(html, /appointment booking/i);
      assert.match(html, /doctors/i);
      assert.match(html, /FAQ/i);
    }
  });

  // A-007's sharpest distinction: booking-rule ENFORCEMENT is server-side
  // (appointmentService reads the config document directly), so the rules hold
  // even while the receptionist cannot describe them. Telling an owner their
  // booking rules were dead would send them chasing a bug that does not exist.
  it('the booking page says its rules are still enforced', () => {
    const html = SN.noticeHtml('booking', SHADOWED_RUN);
    assert.match(html, /still enforced/i);
    assert.match(html, /refused/i);
  });

  it('the hours page says bookings are still refused outside them', () => {
    assert.match(SN.noticeHtml('hours', SHADOWED_RUN), /still refused outside the hours/i);
  });

  it('the read-only summary page says what it shows may differ from what is said', () => {
    const html = SN.noticeHtml('knows', SHADOWED_RUN);
    assert.match(html, /may differ from what you see here/i);
    assert.ok(!/won’t use it until/.test(html), 'a page with no Save must not talk about saving');
  });

  // Spec §1: named by what the owner recognises, not how the system is built.
  it('never exposes internal vocabulary to the owner', () => {
    for (const page of Object.keys(SN.SHADOWED)) {
      const html = SN.noticeHtml(page, SHADOWED_RUN);
      for (const jargon of ['legacy', 'ai_prompt', 'prompt', 'renderer', 'config', 'template', 'tenant']) {
        assert.ok(!new RegExp(jargon, 'i').test(html),
          `${page} notice must not say "${jargon}" — the owner does not know that word`);
      }
    }
  });

  it('escapes interpolated copy', () => {
    for (const page of Object.keys(SN.SHADOWED)) {
      assert.ok(!SN.noticeHtml(page, SHADOWED_RUN).includes('<script'), `${page}: no raw markup from copy`);
    }
    // profile's copy carries a typographic apostrophe — it must survive escaping
    // rather than come out as &#39; or a mojibake entity.
    assert.ok(SN.noticeHtml('profile', SHADOWED_RUN).includes('clinic’s'),
      'typographic apostrophes survive escaping');
  });
});

describe('F-F001 save confirmation', () => {
  // A-008: the exact moment the portal lies. The value IS stored and versioned;
  // the claim that it took effect is what is false.
  it('a save on a shadowed page is NOT an unqualified success', () => {
    const msg = SN.savedMessage(7, SHADOWED_RUN, 'pricing');
    assert.notEqual(msg, 'Saved · v7', 'must not report plain success');
    assert.ok(msg.startsWith('Saved · v7'), 'the save DID happen — the version is real');
    assert.match(msg, /not reaching your receptionist yet/i);
  });

  it('a save on a clinic that is not shadowed is the plain confirmation', () => {
    assert.equal(SN.savedMessage(7, CLEAN_RUN, 'pricing'), 'Saved · v7');
  });

  it('an unknown verdict gets the plain confirmation, never a guess', () => {
    assert.equal(SN.savedMessage(7, null, 'pricing'), 'Saved · v7');
    assert.equal(SN.savedMessage(7, RUN_WITHOUT_CHECK, 'pricing'), 'Saved · v7');
  });

  it('a page whose settings are not shadowed stays plain even on a shadowed clinic', () => {
    assert.equal(SN.savedMessage(7, SHADOWED_RUN, 'doctors'), 'Saved · v7');
    assert.equal(SN.savedMessage(7, SHADOWED_RUN, 'faqs'), 'Saved · v7');
  });
});

describe('F-F001 readiness row (shell.js + home.js)', () => {
  const shell = read('shell.js');
  const home = read('home.js');

  // The finding's third mechanism: the label asserted the reassuring case in
  // BOTH states. Lifting the suppression without this would tell the same lie,
  // more visibly.
  it('the check no longer asserts the reassuring case unconditionally', () => {
    assert.match(shell, /'tenant\.legacy_prompt':[\s\S]*?labelWarn:/,
      'tenant.legacy_prompt must carry a warn-state label');
  });

  it('checkMeta swaps the label on a warn verdict and leaves every other check alone', () => {
    // Exercise the real map by evaluating shell.js's CHECK_META + checkMeta in
    // isolation — the source is the contract, so read it rather than restate it.
    const metaSrc = shell.slice(shell.indexOf('const CHECK_META'), shell.indexOf('const $ = (sel, root)'));
    const checkMeta = new Function(`${metaSrc}; return checkMeta;`)();

    assert.equal(checkMeta('tenant.legacy_prompt').label, 'Using the latest instruction format',
      'the pass-state label is unchanged');
    assert.equal(checkMeta('tenant.legacy_prompt', 'pass').label, 'Using the latest instruction format');
    assert.notEqual(checkMeta('tenant.legacy_prompt', 'warn').label, 'Using the latest instruction format',
      'a warned clinic must NOT be told it is on the latest format');
    assert.equal(checkMeta('tenant.legacy_prompt', 'warn').label, 'Following a custom script');

    // Every other check is severity-independent — one arg or two, same answer.
    for (const name of ['hours.sane', 'kb.populated', 'whatsapp.config', 'turn.scripted']) {
      assert.equal(checkMeta(name, 'warn').label, checkMeta(name).label, `${name} must be unaffected`);
      assert.equal(checkMeta(name, 'fail').material, checkMeta(name).material);
    }
    // Unknown checks keep the safe default.
    assert.equal(checkMeta('some.future.check').material, true);
  });

  it('home passes the severity through when rendering a row', () => {
    assert.match(home, /const m = metaFor\(c\.name, c\.severity\)/,
      'checkRow must resolve the label against the verdict');
  });

  it('the advisory sub-line names the consequence, not the mechanism', () => {
    assert.ok(!home.includes('An older instruction format is in use'),
      'the old copy told the owner nothing they could act on');
    assert.match(home, /aren’t reaching your receptionist yet/);
  });

  // The icon is the loudest element in an advisory row (advisory rows carry no
  // badge), so a green tick there reasserts what the copy just withdrew.
  it('an advisory warn no longer renders the reassuring green tick', () => {
    const fn = home.slice(home.indexOf('function rowState'), home.indexOf('function checkRow'));
    const rowState = new Function('IC', `${fn}; return rowState;`)({ check: 'CHECK', alert: 'ALERT', op: 'OP' });

    const advisoryWarn = rowState({ severity: 'warn' }, { material: false, actor: 'system' });
    assert.equal(advisoryWarn.icon, 'ALERT', 'an advisory warn must not take the pass icon');
    assert.notEqual(advisoryWarn.iconCls, 'pass');

    // Unchanged for everything else.
    assert.equal(rowState({ severity: 'pass' }, { material: true, actor: 'system' }).badge, 'Ready');
    assert.equal(rowState({ severity: 'fail' }, { material: true, actor: 'owner' }).badge, 'Action needed');
    assert.equal(rowState({ severity: 'skipped' }, { material: true, actor: 'operator' }).badge, 'Not in use');
    assert.equal(rowState({ severity: 'pass' }, { material: true, actor: 'operator' }).badge, 'Operator-run');
    // A MATERIAL warn (doctor.schedule) keeps its existing treatment.
    assert.equal(rowState({ severity: 'warn' }, { material: true, actor: 'owner' }).badge, 'Ready');
  });
});

describe('F-F001 wiring', () => {
  // Closes the loop: a page added to SHADOWED but never given the script would
  // silently warn nobody, which is the exact defect being fixed.
  it('every shadowed page loads shadow-notice.js, before shell.js', () => {
    for (const page of Object.keys(SN.SHADOWED)) {
      const file = PAGE_FILES[page];
      assert.ok(file, `SHADOWED page "${page}" has no HTML file mapped in this test`);
      const html = read(file);
      assert.match(html, new RegExp(`<body data-page="${page}"`),
        `${file} must declare data-page="${page}"`);
      // Match the SCRIPT TAGS, not any mention — these pages also name shell.js
      // in a markup comment far above the tags.
      const sn = html.indexOf('<script src="./shadow-notice.js">');
      const sh = html.indexOf('<script src="./shell.js">');
      assert.ok(sn !== -1, `${file} must load shadow-notice.js`);
      assert.ok(sh !== -1, `${file} must load shell.js`);
      assert.ok(sn < sh, `${file} must load shadow-notice.js BEFORE shell.js — shell reads window.ShadowNotice on boot`);
    }
  });

  it('shell renders the notice even inside the onboarding wizard iframe', () => {
    const shell = read('shell.js');
    // The header control is chrome and is skipped when embedded; the notice is
    // page content, and a wizard user is the person about to waste the most work.
    assert.match(shell, /if \(!embedded\) renderHeaderLifecycle\(\);\s*\n\s*renderShadowNotice\(\);/,
      'renderShadowNotice must run unconditionally, not behind the !embedded gate');
  });

  it('no shadowed page still builds an unqualified save confirmation', () => {
    const savers = ['clinic-profile.js', 'hours.js', 'pricing.js', 'booking-rules.js', 'receptionist.js', 'safety.js'];
    for (const f of savers) {
      const src = read(f);
      assert.ok(!/'Saved · v' \+ data\.version/.test(src),
        `${f} must not hand-build its save message — it bypasses the F-F001 qualification`);
      assert.match(src, /window\.Portal\.savedMessage\(data\.version, data\.readiness\)/,
        `${f} must route its confirmation through Portal.savedMessage`);
    }
  });

  it('the notice adds no second readiness round trip', () => {
    const shell = read('shell.js');
    const fetches = shell.match(/\/portal\/api\/readiness/g) || [];
    assert.equal(fetches.length, 1, 'readiness must be fetched through the one shared promise');
  });

  // §2: static stack — no framework, no bundler, no build step.
  it('ships as plain browser-loadable script with no imports', () => {
    const src = read('shadow-notice.js');
    assert.ok(!/\bimport\s|\bexport\s|require\(/.test(src),
      'shadow-notice.js must load as a plain <script> and require nothing');
  });
});
