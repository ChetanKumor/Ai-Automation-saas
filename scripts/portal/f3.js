'use strict';

/* ============================================================================
 * F3 EVIDENCE HARNESS — "the wizard has no way out". Dev tooling.
 *
 * Runs THE REPRO on a phone (380×820, mobile emulation, real Chrome over CDP)
 * against a fresh tenant and the real routers:
 *
 *   operator creates clinic + owner  →  owner signs in  →  opens the wizard
 *   →  walks to step 5 of 7 (Greeting) with real clicks
 *   →  types a receptionist name    →  presses "Save and finish later"
 *   →  lands on Home                →  re-opens the wizard
 *   →  resumes at step 5 with the typed value present
 *
 * Then the two exit cases the control must not get wrong:
 *
 *   CLEAN   — nothing edited, press exit: no request to any config route, no
 *             config version bump, no error, straight to Home.
 *   INVALID — a bad phone number typed, press exit: the field error is shown,
 *             the wizard STAYS on the step, and nothing typed is discarded.
 *
 * Plus a width sweep (D5b's rule: measure, do not argue) asserting the control
 * is 44px on touch widths, inside the first viewport without scrolling at
 * 380px, and adds no horizontal overflow at 320.
 *
 * Usage:  node scripts/portal/f3.js
 * Output: scripts/portal/shots/f3-*.png
 * ========================================================================== */

require('dotenv').config();

// Offline Gemini SDK — same stub f1.js/acceptance.js install, before anything
// requires the SDK. Nothing here needs a model; this spends no quota.
const GENAI_PATH = require.resolve('@google/generative-ai');
require(GENAI_PATH);
const STUB_VEC = Array(768).fill(0);
STUB_VEC[0] = 1;
require.cache[GENAI_PATH].exports = {
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return {
        embedContent: async () => ({ embedding: { values: STUB_VEC } }),
        startChat: () => ({
          sendMessage: async () => ({ response: { functionCalls: () => undefined, text: () => 'ok' } }),
        }),
      };
    }
  },
};

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client } = require('pg');

const ADMIN_DB = process.env.DATABASE_URL;
if (!ADMIN_DB) { console.error('DATABASE_URL required'); process.exit(1); }
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const CSRF = 'x-zyon-admin';
const OUT = path.join(__dirname, 'shots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEVPORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }

// ── HTTP (verbatim shape from f1.js) ─────────────────────────────────────────
function call(port, { method = 'GET', path: p, body, cookie, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { Accept: 'application/json', ...headers };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(d); } catch (_) { json = null; }
        resolve({ status: res.statusCode, body: json, setCookie: res.headers['set-cookie'] || [] });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const cookieOf = (setCookie, name) => {
  const c = (setCookie || []).find((s) => s.startsWith(name + '='));
  return c ? c.split(';')[0] : null;
};
function must(cond, msg) { if (!cond) throw new Error('EVIDENCE FAILED: ' + msg); }
const hr = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 70 - t.length)));
const ok = (msg) => console.log('  \u2713 ' + msg);

// ── CDP (verbatim shape from f1.js/shoot.js) ─────────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method) { this.listeners.forEach((l) => l(m)); }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.push(fn); }
}
async function connectBrowser() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEVPORT}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}
function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));
  });
}
// Surfaces page-side exceptions. Without this a typo inside an injected
// expression returns undefined and the harness reports a product failure that
// is actually a harness failure — the exact way f1.js's first repro driver lied.
async function evaluate(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) {
    const e = r.exceptionDetails;
    throw new Error('page threw: ' + ((e.exception && e.exception.description) || e.text));
  }
  return r.result.value;
}
async function waitFor(cdp, sid, expr, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: `!!(${expr})`, returnByValue: true }, sid);
    if (r.result && r.result.value) return;
    await sleep(150);
  }
  throw new Error('never appeared: ' + expr);
}

// Open a portal page in its own tab, signed in, at a given viewport.
async function openPage(cdp, { port, cookie, file, width = 380, height = 820, mobile = true }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile }, sessionId);
  const [name, value] = cookie.split('=');
  await cdp.send('Network.setCookie', { name, value, url: `http://127.0.0.1:${port}/` }, sessionId);
  const loaded = new Promise((res) => {
    cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
  });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/portal/${file}` }, sessionId);
  await loaded;
  return { targetId, sessionId };
}
// Viewport-only. `captureBeyondViewport` paints sticky elements (the top bar,
// the page header) at their scrolled-to position, which on a 2500px wizard page
// stamps a duplicate bar across the middle of the image. For "what an owner sees
// without scrolling" the viewport IS the subject, so this takes no clip at all.
async function captureViewport(cdp, sessionId, out) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`  ✓ ${path.basename(out)} (first viewport)`);
}
async function capture(cdp, sessionId, out) {
  const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
  const size = metrics.cssContentSize;
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size.width, height: Math.ceil(size.height), scale: 1 },
  }, sessionId);
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`  \u2713 ${path.basename(out)} (${Math.round(size.width)}×${Math.round(size.height)})`);
}

// The wizard is rendered, the step's iframe has finished booting (its shared
// #loadCard placeholder is hidden — the same "ready" signal wizard.js's
// readyForm() uses), and the step label matches.
const WIZ_READY =
  "!document.getElementById('wiz').hidden && (() => { const d = document.getElementById('wizFrame').contentDocument; " +
  "return d && d.getElementById('loadCard') && d.getElementById('loadCard').hidden; })()";
const stepLabel = (cdp, sid) => evaluate(cdp, sid, "document.getElementById('wizStepLabel').innerText");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const scratchName = 'zyon_f3_' + crypto.randomBytes(5).toString('hex');
  const scratchCs = swapDb(ADMIN_DB, scratchName);
  let db, server, chrome, ws;

  const c0 = new Client({ connectionString: ADMIN_DB, ssl: SSL });
  await c0.connect();
  await c0.query('CREATE DATABASE ' + scratchName);
  await c0.end();
  console.log('scratch DB:', scratchName);

  try {
    process.env.DATABASE_URL = scratchCs;
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = 'f3-admin-pass';
    await require('../../src/db/migrate').genesis({ connectionString: scratchCs, logger: SILENT });

    db = require('../../src/db/db');

    const express = require('express');
    const session = require('express-session');
    const app = express();
    app.use('/portal', require('../../src/portal/routes'));
    app.use(express.json());
    app.use(session({ secret: 'f3', resave: false, saveUninitialized: false }));
    app.use('/admin', require('../../src/admin/adminRoutes'));
    app.use(express.static(path.join(__dirname, '../../public')));
    server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const port = server.address().port;

    // ── operator ─────────────────────────────────────────────────────────────
    const adminLogin = await call(port, { method: 'POST', path: '/admin/login', body: { password: process.env.ADMIN_PASSWORD } });
    const adminCookie = cookieOf(adminLogin.setCookie, 'connect.sid');
    must(adminCookie, 'operator sign-in failed');
    const created = await call(port, {
      method: 'POST', path: '/admin/api/tenants', cookie: adminCookie,
      headers: { [CSRF]: '1' }, body: { business_name: 'F3 Dental' },
    });
    const tenantId = created.body.id || (created.body.tenant && created.body.tenant.id);
    must(tenantId, 'tenant create failed: ' + JSON.stringify(created.body));

    const ownerEmail = 'owner@f3-dental.test';
    const ownerRes = await call(port, {
      method: 'POST', path: `/admin/api/tenants/${tenantId}/owner`, cookie: adminCookie,
      headers: { [CSRF]: '1' }, body: { email: ownerEmail },
    });
    const tempPassword = ownerRes.body.password;
    must(tempPassword, 'owner create failed: ' + JSON.stringify(ownerRes.body));

    const login = await call(port, { method: 'POST', path: '/portal/api/login', body: { email: ownerEmail, password: tempPassword } });
    const cookie = cookieOf(login.setCookie, 'portal.sid');
    must(cookie, 'owner sign-in failed');

    const meta = async () => (await db.query(
      'SELECT version, config->\'meta\' AS m FROM tenant_configs WHERE tenant_id = $1', [tenantId])).rows[0];
    // persistStep is fire-and-forget on the goTo path (wizard.js's own comment
    // says so), so the POST lands a beat after the label changes. Poll rather
    // than sleep a guessed interval.
    async function metaStep(want, tries = 40) {
      for (let i = 0; i < tries; i++) {
        const m = await meta();
        if (m.m.onboarding_step === want) return m;
        await sleep(100);
      }
      return meta();
    }

    // ── Chrome ───────────────────────────────────────────────────────────────
    const udd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'f3-chrome-'));
    chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${DEVPORT}`, `--user-data-dir=${udd}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      '--force-prefers-reduced-motion=reduce', 'about:blank',
    ], { stdio: 'ignore' });
    ws = await openWs(await connectBrowser());
    const cdp = new CDP(ws);

    // Every request the page or its same-origin iframe makes, so "no save
    // fired" is an observation rather than an inference.
    const seen = [];
    cdp.on((m) => {
      if (m.method === 'Network.requestWillBeSent') {
        seen.push(m.params.request.method + ' ' + new URL(m.params.request.url).pathname);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const e = m.params.exceptionDetails;
        console.log('  ‼ page exception: ' + ((e.exception && e.exception.description) || e.text));
      }
    });
    const configWrites = () => seen.filter((s) => /^POST \/portal\/api\/(config|doctors|faqs)/.test(s));

    /* ════════════════════════════════════════════════════════════════════════
     * THE REPRO — a phone, 380×820, step 5, Save and finish later
     * ══════════════════════════════════════════════════════════════════════ */
    hr('THE REPRO — 380×820, walk to step 5 of 7, type, exit');
    const page = await openPage(cdp, { port, cookie, file: 'wizard.html' });
    await waitFor(cdp, page.sessionId, WIZ_READY);
    console.log('  start:', await stepLabel(cdp, page.sessionId));

    // Walk with REAL clicks — Skip where the step offers it, Continue on the
    // multi-kind Doctors step where it doesn't. Four presses: 1 → 5.
    for (let i = 0; i < 4; i++) {
      const before = await stepLabel(cdp, page.sessionId);
      await evaluate(cdp, page.sessionId, `(() => {
        const skip = document.getElementById('wizSkip');
        (skip.hidden ? document.getElementById('wizContinue') : skip).click();
      })()`);
      await waitFor(cdp, page.sessionId,
        `document.getElementById('wizStepLabel').innerText !== ${JSON.stringify(before)}`);
      await waitFor(cdp, page.sessionId, WIZ_READY);
      console.log('   →', await stepLabel(cdp, page.sessionId));
    }
    const atStep5 = await stepLabel(cdp, page.sessionId);
    must(/^Step 5 of 7/.test(atStep5), `expected step 5, got "${atStep5}"`);
    const arrived = await metaStep(4);
    must(arrived.m.onboarding_step === 4,
      `step 5 (index 4) must be persisted on arrival, got ${arrived.m.onboarding_step}`);
    ok(`persisted on arrival: meta.onboarding_step = ${arrived.m.onboarding_step}`);

    // The exit control, measured before it is used (verification item 5).
    hr('Exit control at 380px — 44px, and above the fold without scrolling');
    const ctl = await evaluate(cdp, page.sessionId, `(() => {
      const b = document.getElementById('wizExit');
      const r = b.getBoundingClientRect();
      return { text: b.innerText, w: Math.round(r.width), h: Math.round(r.height),
               bottom: Math.round(r.bottom), vh: window.innerHeight, scrollY: window.scrollY,
               doc: document.documentElement.scrollWidth, win: window.innerWidth };
    })()`);
    console.log('  ' + JSON.stringify(ctl));
    must(ctl.text === 'Save and finish later', `label is "${ctl.text}"`);
    must(ctl.h >= 44, `exit control is ${ctl.h}px tall — below the 44px touch floor`);
    must(ctl.w >= 44, `exit control is ${ctl.w}px wide — below the 44px touch floor`);
    must(ctl.scrollY === 0 && ctl.bottom <= ctl.vh,
      `exit control is not in the first viewport (bottom ${ctl.bottom} > ${ctl.vh})`);
    must(ctl.doc <= ctl.win, `horizontal overflow at 380px: ${ctl.doc} > ${ctl.win}`);
    ok(`${ctl.w}×${ctl.h}, bottom at ${ctl.bottom}px of a ${ctl.vh}px viewport, no scroll needed`);
    await captureViewport(cdp, page.sessionId, path.join(OUT, 'f3-wizard-step5-mobile.png'));

    // Type into the embedded page, the way a thumb does.
    const NAME = 'Asha';
    await evaluate(cdp, page.sessionId, `(() => {
      const d = document.getElementById('wizFrame').contentDocument;
      const el = d.getElementById('displayName');
      el.value = ${JSON.stringify(NAME)};
      el.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
    })()`);
    await waitFor(cdp, page.sessionId,
      "document.getElementById('wizFrame').contentDocument.getElementById('saveNote').classList.contains('save-note--dirty')");
    ok('card reports itself dirty (the page\'s own save-note--dirty)');

    const vBefore = (await meta()).version;
    await evaluate(cdp, page.sessionId, "document.getElementById('wizExit').click()");
    await waitFor(cdp, page.sessionId, "location.pathname.endsWith('/portal/index.html')", 140);
    ok('landed on Home — ' + await evaluate(cdp, page.sessionId, 'location.pathname'));

    const saved = (await call(port, { method: 'GET', path: '/portal/api/config/receptionist', cookie })).body;
    const vAfter = (await meta()).version;
    must(saved.receptionist && saved.receptionist.display_name === NAME,
      `the typed value did not save: ${JSON.stringify(saved.receptionist)}`);
    ok(`data saved through the page's own route — display_name = "${saved.receptionist.display_name}", ` +
       `config v${vBefore} → v${vAfter}`);
    must(configWrites().length === 1 && /receptionist/.test(configWrites()[0]),
      'exactly one config write, on the step\'s own endpoint: ' + JSON.stringify(configWrites()));
    ok('one write, one endpoint: ' + configWrites()[0]);

    // Re-enter: resumes at step 5 WITH the data.
    await cdp.send('Target.closeTarget', { targetId: page.targetId });
    const again = await openPage(cdp, { port, cookie, file: 'wizard.html' });
    await waitFor(cdp, again.sessionId, WIZ_READY);
    const resumed = await evaluate(cdp, again.sessionId, `(() => ({
      label: document.getElementById('wizStepLabel').innerText,
      value: document.getElementById('wizFrame').contentDocument.getElementById('displayName').value,
    }))()`);
    console.log('  ' + JSON.stringify(resumed));
    must(/^Step 5 of 7/.test(resumed.label), `resumed at "${resumed.label}", not step 5`);
    must(resumed.value === NAME, `resumed without the data: "${resumed.value}"`);
    ok('re-entering resumes at step 5 with the data present — THE REPRO PASSES');

    /* ════════════════════════════════════════════════════════════════════════
     * CASE 2 — clean card: no save fired, no error
     * ══════════════════════════════════════════════════════════════════════ */
    hr('CLEAN card exit — nothing touched');
    seen.length = 0;
    const cleanBefore = (await meta()).version;
    const cleanState = await evaluate(cdp, again.sessionId, `(() => ({
      dirty: document.getElementById('wizFrame').contentDocument
               .getElementById('saveNote').classList.contains('save-note--dirty'),
    }))()`);
    must(cleanState.dirty === false, 'the freshly-loaded card should be clean');
    await evaluate(cdp, again.sessionId, "document.getElementById('wizExit').click()");
    await waitFor(cdp, again.sessionId, "location.pathname.endsWith('/portal/index.html')", 140);
    const cleanAfter = (await meta()).version;
    console.log('  requests seen:', JSON.stringify(seen.filter((s) => s.startsWith('POST'))));
    must(configWrites().length === 0, 'a clean exit fired a save: ' + JSON.stringify(configWrites()));
    must(cleanBefore === cleanAfter, `config version moved on a clean exit: ${cleanBefore} → ${cleanAfter}`);
    ok(`no config request, version unchanged at v${cleanAfter}, landed on Home`);
    await cdp.send('Target.closeTarget', { targetId: again.targetId });

    /* ════════════════════════════════════════════════════════════════════════
     * CASE 3 — dirty AND invalid: error shown, stays put, nothing lost
     * ══════════════════════════════════════════════════════════════════════ */
    hr('DIRTY + INVALID exit — Clinic profile with a bad phone number');
    await call(port, { method: 'POST', path: '/portal/api/onboarding', cookie, body: { step: 0 } });
    const bad = await openPage(cdp, { port, cookie, file: 'wizard.html' });
    await waitFor(cdp, bad.sessionId, WIZ_READY);
    must(/^Step 1 of 7/.test(await stepLabel(cdp, bad.sessionId)), 'expected step 1 (Clinic profile)');

    const GOOD_NAME = 'F3 Dental Care';
    const BAD_PHONE = '12345';
    await evaluate(cdp, bad.sessionId, `(() => {
      const d = document.getElementById('wizFrame').contentDocument;
      const fire = (el, v) => { el.value = v; el.dispatchEvent(new d.defaultView.Event('input', { bubbles: true })); };
      fire(d.getElementById('display_name'), ${JSON.stringify(GOOD_NAME)});
      fire(d.querySelector('.phone-row .input'), ${JSON.stringify(BAD_PHONE)});
    })()`);
    const preClick = await evaluate(cdp, bad.sessionId, `(() => {
      const d = document.getElementById('wizFrame').contentDocument;
      const n = d.getElementById('saveNote');
      return { note: n && n.className, name: d.getElementById('display_name').value,
               phone: d.querySelector('.phone-row .input').value,
               form: !!d.getElementById('profileForm'),
               loadCardHidden: d.getElementById('loadCard').hidden };
    })()`);
    console.log('  pre-click: ' + JSON.stringify(preClick));
    must(/save-note--dirty/.test(preClick.note || ''), 'the card did not go dirty — the harness never typed');

    seen.length = 0;
    const invBefore = (await meta()).version;
    // CONTROL — Continue, the path that shipped in S16, through the SAME
    // rejected save. This is what proved the watcher defect was shared and
    // pre-existing rather than introduced by the new control: on a poll-based
    // watchIframeSave this reported nothing for 20 seconds and then a "taking a
    // while" toast, nondeterministically. Both paths must now answer promptly.
    const started = Date.now();
    await evaluate(cdp, bad.sessionId, "document.getElementById('wizContinue').click()");
    await waitFor(cdp, bad.sessionId, "document.getElementById('wizSaveNote').innerText.length > 0", 60);
    const control = await evaluate(cdp, bad.sessionId, `(() => {
      const d = document.getElementById('wizFrame').contentDocument;
      return { note: document.getElementById('wizSaveNote').innerText,
               cont: document.getElementById('wizContinue').innerText,
               invalid: !!d.querySelector('.input--invalid'),
               toast: (document.querySelector('.toast') || {}).innerText || '' };
    })()`);
    const controlMs = Date.now() - started;
    console.log('  CONTROL (Continue) after ' + controlMs + 'ms: ' + JSON.stringify(control));
    must(controlMs < 10000, `Continue took ${controlMs}ms to report a rejected save — the watcher is still sampling`);
    must(/Fix the highlighted fields/.test(control.note), 'Continue did not report the rejection');
    must(!/taking a while/.test(control.toast), 'Continue reported a rejected save as a hung request');
    must(control.cont === 'Save & continue', 'Continue did not return to rest');
    ok(`Continue reports the rejection in ${controlMs}ms — shared watcher fixed for both paths`);

    seen.length = 0;
    const exitStarted = Date.now();
    await evaluate(cdp, bad.sessionId, "document.getElementById('wizExit').click()");
    // The exit path writes its OWN wording — "…then finish later" rather than
    // Continue's "…to continue, or skip for now" — so this cannot be satisfied
    // by the note the CONTROL click left behind.
    await waitFor(cdp, bad.sessionId,
      "/then finish later/.test(document.getElementById('wizSaveNote').innerText)", 100);
    const exitMs = Date.now() - exitStarted;
    must(exitMs < 10000, `the exit path took ${exitMs}ms to report a rejected save`);
    ok(`exit reports the rejection in ${exitMs}ms`);
    await sleep(300);

    const after = await evaluate(cdp, bad.sessionId, `(() => {
      const d = document.getElementById('wizFrame').contentDocument;
      return {
        path: location.pathname,
        label: document.getElementById('wizStepLabel').innerText,
        wizNote: document.getElementById('wizSaveNote').innerText,
        wizNoteIsError: document.getElementById('wizSaveNote').classList.contains('wiz__save-note--error'),
        // Every field ships an empty .field__error div, so the FIRST one is not
        // the populated one — read the field the server actually named.
        fieldError: d.getElementById('err-phone_numbers').textContent,
        invalidFields: [...d.querySelectorAll('.field.is-invalid')].length,
        invalidInput: !!d.querySelector('.input--invalid'),
        keptName: d.getElementById('display_name').value,
        keptPhone: d.querySelector('.phone-row .input').value,
        exitEnabled: !document.getElementById('wizExit').disabled,
        exitLabel: document.getElementById('wizExit').innerText,
      };
    })()`);
    console.log('  ' + JSON.stringify(after, null, 2));
    const invAfter = (await meta()).version;

    must(after.path.endsWith('/portal/wizard.html'), `navigated away to ${after.path} — the edit would be lost`);
    must(/^Step 1 of 7/.test(after.label), `moved off the step: "${after.label}"`);
    must(after.fieldError && /phone number/i.test(after.fieldError),
      `no inline field error surfaced: "${after.fieldError}"`);
    must(after.invalidInput && after.invalidFields === 1,
      `the offending field is not marked invalid (${after.invalidFields} invalid fields)`);
    must(after.wizNoteIsError && /Fix the highlighted fields, then finish later/.test(after.wizNote),
      `the wizard did not say why it stayed: "${after.wizNote}"`);
    must(after.keptName === GOOD_NAME && after.keptPhone === BAD_PHONE,
      `input was discarded: ${JSON.stringify([after.keptName, after.keptPhone])}`);
    must(invBefore === invAfter, `an invalid save still wrote a version: ${invBefore} → ${invAfter}`);
    must(after.exitEnabled && after.exitLabel === 'Save and finish later',
      'the exit control must return to rest — exit is ALWAYS available (spec §3.8)');
    ok('field error shown, stayed on step 1, both values intact, no version written, exit still live');
    await captureViewport(cdp, bad.sessionId, path.join(OUT, 'f3-wizard-invalid-exit-mobile.png'));
    // …and the error itself, which sits below the fold on this long form.
    await evaluate(cdp, bad.sessionId,
      "document.getElementById('wizFrame').contentDocument.querySelector('.input--invalid')" +
      ".scrollIntoView({ block: 'center' })");
    await sleep(300);
    await captureViewport(cdp, bad.sessionId, path.join(OUT, 'f3-wizard-invalid-exit-field.png'));
    await cdp.send('Target.closeTarget', { targetId: bad.targetId });

    /* ════════════════════════════════════════════════════════════════════════
     * WIDTH SWEEP — D5b: measure, do not argue
     * ══════════════════════════════════════════════════════════════════════ */
    hr('Width sweep — the new row must not put a scrollbar on the wizard');
    for (const w of [320, 380, 640, 1180]) {
      const m = await openPage(cdp, { port, cookie, file: 'wizard.html', width: w, height: 800, mobile: w <= 640 });
      await waitFor(cdp, m.sessionId, WIZ_READY);
      const r = await evaluate(cdp, m.sessionId, `(() => {
        const b = document.getElementById('wizExit').getBoundingClientRect();
        const l = document.getElementById('wizStepLabel').getBoundingClientRect();
        return { doc: document.documentElement.scrollWidth, win: window.innerWidth,
                 h: Math.round(b.height), bottom: Math.round(b.bottom), vh: window.innerHeight,
                 right: Math.round(b.right), labelLeft: Math.round(l.left), overlap: l.right > b.left };
      })()`);
      must(r.doc <= r.win, `horizontal overflow at ${w}px: ${r.doc} > ${r.win}`);
      must(!r.overlap, `the step label collides with the exit control at ${w}px`);
      must(r.bottom <= r.vh, `exit control below the fold at ${w}px (${r.bottom} > ${r.vh})`);
      if (w <= 640) must(r.h >= 44, `exit control is ${r.h}px tall at ${w}px`);
      ok(`${w}px — no overflow (${r.doc}≤${r.win}), control ${r.h}px tall, ` +
         `bottom ${r.bottom}≤${r.vh}, no collision`);
      await cdp.send('Target.closeTarget', { targetId: m.targetId });
    }

    /* ════════════════════════════════════════════════════════════════════════
     * B — login.html names a reachable channel
     * ══════════════════════════════════════════════════════════════════════ */
    hr('B — login.html at 380px');
    const lg = await openPage(cdp, { port, cookie, file: 'login.html' });
    await sleep(600);
    const foot = await evaluate(cdp, lg.sessionId, `(() => {
      const a = document.querySelector('.login__foot a');
      const r = a.getBoundingClientRect();
      return { text: document.querySelector('.login__foot').innerText, href: a.href,
               linkText: a.innerText, h: Math.round(r.height), bottom: Math.round(r.bottom),
               vh: window.innerHeight, doc: document.documentElement.scrollWidth, win: window.innerWidth,
               colour: getComputedStyle(a).color, underline: getComputedStyle(a).textDecorationLine };
    })()`);
    console.log('  ' + JSON.stringify(foot, null, 2));
    must(/^https:\/\/wa\.me\/\d{10,15}\?/.test(foot.href), `not a reachable wa.me link: ${foot.href}`);
    must(foot.underline.includes('underline'), 'the link is colour-only — spec §2.11');
    must(foot.doc <= foot.win, `horizontal overflow at 380px: ${foot.doc} > ${foot.win}`);
    must(foot.bottom <= foot.vh, 'the reset line is below the fold at 380px');
    ok(`"${foot.linkText}" → ${foot.href}`);
    await capture(cdp, lg.sessionId, path.join(OUT, 'f3-login-mobile.png'));
    await cdp.send('Target.closeTarget', { targetId: lg.targetId });

    console.log('\nALL ASSERTIONS PASSED\n');
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { if (chrome) chrome.kill(); } catch (_) {}
    try { if (server) server.close(); } catch (_) {}
    try { if (db) await db.close(); } catch (_) {}
    process.env.DATABASE_URL = ADMIN_DB;
    const c1 = new Client({ connectionString: ADMIN_DB, ssl: SSL });
    await c1.connect();
    try {
      await c1.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c1.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c1.end(); }
    console.log('cleaned up scratch DB');
  }
})().catch((e) => { console.error('\n' + e.stack); process.exit(1); });
