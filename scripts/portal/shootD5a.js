'use strict';

/* ============================================================================
 * D5a component sweep — screenshot + assertion evidence. Dev tooling, not shipped.
 *
 * Same machinery as shoot.js / shootD3.js / shootD4.js (throwaway scratch DB ->
 * genesis -> real routers -> CDP). What is different here:
 *
 *   1. TWO tenants, and the second one is the point. The clean clinic proves
 *      the component sheets and W5 (no not-live strip on Home, strip elsewhere).
 *      The LEGACY clinic — one with a non-null `tenants.ai_prompt` — is the only
 *      way to photograph W6, because the contradiction being fixed only exists
 *      on a clinic whose saved settings are not reaching the receptionist.
 *
 *   2. The four W-assertions are computed styles, never eyeballed:
 *        W1  — the transitional tokens resolve to nothing (they are deleted)
 *        W2  — .card / .doc / .faq compute box-shadow: none
 *        W3  — the modal and the drawer compute --shadow-lg's exact value
 *        W6  — the panel header text and the absence of the live dot
 *      plus the busy-button width invariant, measured rest vs busy.
 *
 *   3. The component sheets (buttons × 6 states, inputs × 6 states) are built
 *      by injecting markup into a real portal page, so every rule that paints
 *      them is the shipped rule from tokens.css and not a copy in this file.
 *      :hover and :active cannot be forced from script, so those two rows are
 *      painted by applying the same declarations the stylesheet applies — and
 *      the assertion pass separately proves the stylesheet's own values.
 *
 * Usage:  node scripts/portal/shootD5a.js
 * Output: scripts/portal/shots/d5a-*.png
 * ========================================================================== */

require('dotenv').config();

// Offline Gemini SDK — identical seam to shoot.js. Every FAQ write embeds, so
// without this the script makes live embedding calls it has no need for.
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
          sendMessage: async () => ({
            response: { functionCalls: () => undefined, text: () => 'ok' },
          }),
        }),
      };
    }
  },
};

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { Client } = require('pg');

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) { console.error('DATABASE_URL required'); process.exit(1); }
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const OUT = path.join(__dirname, 'shots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEVPORT = 9337; // not 9333/9334/9336 — all four run back to back

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }

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

async function waitForSelector(cdp, sid, expr, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: `!!(${expr})`, returnByValue: true }, sid);
    if (r.result && r.result.value) return;
    await sleep(150);
  }
  throw new Error('selector never appeared: ' + expr);
}

async function shoot(cdp, { url, out, width, height, mobile, cookie, port, waitFor, afterReady, preload, settle, collapsed, clipToViewport }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  if (process.env.SHOOT_DEBUG) {
    await cdp.send('Runtime.enable', {}, sessionId);
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') {
        console.log('  [exception]', out, JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails));
      }
    });
  }
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: !!mobile }, sessionId);
  if (cookie) {
    await cdp.send('Network.setCookie',
      { name: cookie.name, value: cookie.value, url: `http://127.0.0.1:${port}/` }, sessionId);
  }
  // Same trap D4 recorded: one Chrome profile is shared by every target, so the
  // panel's collapse preference leaks between shots unless each states it.
  if (collapsed !== undefined) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try{localStorage.setItem('portal.verbatim.collapsed','"
        + (collapsed ? '1' : '0') + "');}catch(e){}",
    }, sessionId);
  }
  if (preload) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preload }, sessionId);

  const loaded = new Promise((res) => {
    cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  if (waitFor) await waitForSelector(cdp, sessionId, waitFor);
  if (afterReady) await afterReady(cdp, sessionId);
  await sleep(settle == null ? 1400 : settle);

  const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
  const inner = clipToViewport
    ? (await cdp.send('Runtime.evaluate', {
      expression: '[window.innerWidth, window.innerHeight].join(",")', returnByValue: true,
    }, sessionId)).result.value.split(',').map(Number)
    : null;
  const size = clipToViewport
    ? { width: inner[0] || width, height: inner[1] || height }
    : (metrics.cssContentSize || { width, height });
  const shotRes = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: !clipToViewport,
    clip: { x: 0, y: 0, width: size.width, height: Math.ceil(size.height), scale: 1 },
  }, sessionId);
  fs.writeFileSync(out, Buffer.from(shotRes.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  console.log('  ✓', path.basename(out), `(${Math.round(size.width)}×${Math.round(size.height)})`);
}

/**
 * `awaitReady` — await the shell's OWN shared readiness promise before
 * asserting, rather than sleeping and hoping. The truth strip and the panel
 * header are both painted in the continuation of that promise, and a fixed
 * settle caught it on one run and missed it on the next: the first run of this
 * harness saw the strip, the second saw an empty host, from an identical tree.
 * Awaiting the memoised promise (never a second fetch — it is the same one) and
 * then yielding a little makes the assertion deterministic.
 */
async function probe(cdp, { url, cookie, port, waitFor, checks, width, height, mobile, preload, awaitReady }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: width || 1440, height: height || 900, deviceScaleFactor: 1, mobile: !!mobile,
  }, sessionId);
  if (cookie) {
    await cdp.send('Network.setCookie',
      { name: cookie.name, value: cookie.value, url: `http://127.0.0.1:${port}/` }, sessionId);
  }
  if (preload) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preload }, sessionId);
  const loaded = new Promise((res) => {
    cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  if (waitFor) await waitForSelector(cdp, sessionId, waitFor);
  if (awaitReady) {
    await cdp.send('Runtime.evaluate', {
      expression: 'window.Portal.readinessOnce().then(function(){return true;})',
      returnByValue: true, awaitPromise: true,
    }, sessionId);
    await sleep(350);
  }
  await sleep(500);
  let failed = 0;
  for (const [label, expr, expected] of checks) {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    const got = r.result && r.result.value;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (!ok) failed += 1;
    console.log(`    ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  }
  await cdp.send('Target.closeTarget', { targetId });
  if (failed) throw new Error(`${failed} DOM assertion(s) failed on ${url}`);
}

function loginCookie(port, email, password) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ email, password });
    const r = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/portal/api/login',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const set = res.headers['set-cookie'] || [];
      const c = set.find((s) => s.startsWith('portal.sid='));
      if (!c) return reject(new Error(`no portal.sid cookie (login ${res.statusCode})`));
      const kv = c.split(';')[0];
      const eq = kv.indexOf('=');
      resolve({ name: kv.slice(0, eq), value: kv.slice(eq + 1) });
    });
    r.on('error', reject);
    r.write(payload); r.end();
  });
}

// ── Component sheets ────────────────────────────────────────────────────────
// Injected into a real portal page so the rules that paint them are the shipped
// rules. :hover and :active cannot be synthesised from script, so those rows
// carry the stylesheet's own declarations applied inline; the assertion pass
// below proves independently that the stylesheet holds those same values.
const SHEET_CSS = `
  .sh { max-width: none; }
  .sh__t { font: 600 13px/1 var(--sans); letter-spacing: .05em; text-transform: uppercase;
           color: var(--muted); margin: 0 0 18px; padding-bottom: 12px;
           border-bottom: 1px solid var(--line); }
  .sh__t:not(:first-child) { margin-top: 36px; }
  .sh__g { display: grid; gap: 14px; }
  .sh__r { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .sh__l { width: 118px; flex: none; font: 400 12px/1.4 var(--mono); color: var(--faint); }
  .sh__n { font: 400 12.5px/1.5 var(--sans); color: var(--muted); }
`;

const BTN_SHEET = `(function(){
  var s=document.createElement('style'); s.textContent=${JSON.stringify(SHEET_CSS)};
  document.head.appendChild(s);
  var SPIN='<svg class="btn__spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10" opacity=".95"/><circle cx="12" cy="12" r="10" opacity=".28"/></svg>';
  function row(label, html, note){
    return '<div class="sh__r"><span class="sh__l">'+label+'</span>'+html
      + (note ? '<span class="sh__n">'+note+'</span>' : '') + '</div>';
  }
  var V='<button class="btn btn--primary">Save changes</button>'
      + '<button class="btn">Cancel</button>'
      + '<button class="btn btn--ghost">Add another</button>'
      + '<button class="btn btn--danger">Pause receptionist</button>'
      + '<button class="btn btn--link">Learn more</button>';
  // hover / pressed: the stylesheet's own declarations, applied inline because
  // CDP cannot force a pseudo-class on five elements at once.
  var HOV='<button class="btn btn--primary" style="background:var(--teal-800);border-color:var(--teal-800)">Save changes</button>'
      + '<button class="btn" style="background:var(--bg);border-color:var(--line-3);color:var(--ink)">Cancel</button>'
      + '<button class="btn btn--ghost" style="background:var(--line-2);color:var(--ink)">Add another</button>'
      + '<button class="btn btn--danger" style="background:var(--red-50)">Pause receptionist</button>'
      + '<button class="btn btn--link" style="color:var(--teal-800);text-decoration:underline">Learn more</button>';
  var PRS='<button class="btn btn--primary" style="background:var(--teal-900);border-color:var(--teal-900)">Save changes</button>'
      + '<button class="btn" style="background:var(--line-2)">Cancel</button>'
      + '<button class="btn btn--ghost" style="background:var(--line)">Add another</button>'
      + '<button class="btn btn--danger" style="background:var(--red-100)">Pause receptionist</button>'
      + '<button class="btn btn--link" style="color:var(--teal-800);text-decoration:underline">Learn more</button>';
  var html='<h3 class="sh__t">Buttons — 5 variants × 6 states</h3><div class="sh__g">'
    + row('rest', V)
    + row('hover', HOV)
    + row('pressed', PRS)
    + row('focus-visible', '<button class="btn btn--primary" id="shFoc">Save changes</button>',
           '2px --teal-700 ring at 2px offset — never colour-only')
    + row('busy', '<button class="btn btn--primary" aria-busy="true" style="min-width:141px">'+SPIN+'Saving…</button>',
           'width held · aria-busy · keeps its double-submit guard')
    + row('disabled', '<button class="btn btn--primary" disabled>Go live</button>'
           + '<span class="btn-why">Add an escalation number first — Safety &amp; handoff.</span>')
    + '</div>'
    + '<h3 class="sh__t">Sizes</h3><div class="sh__g">'
    + row('36 / 32 / 44', '<button class="btn btn--primary">Default 36</button>'
           + '<button class="btn btn--primary btn--sm">Small 32</button>'
           + '<button class="btn btn--primary" style="height:44px">Mobile 44</button>')
    + '</div>'
    + '<h3 class="sh__t">Badges — icon plus word, always</h3><div class="sh__g">'
    + row('semantic', '<span class="badge badge--ok"><span class="badge__dot"></span>Live</span>'
           + '<span class="badge badge--warn">'+ICONW+'Action needed</span>'
           + '<span class="badge badge--err">'+ICONX+'Failed</span>'
           + '<span class="badge badge--muted">'+ICONL+'Prantivo runs this</span>'
           + '<span class="badge badge--teal">'+ICONI+'Draft</span>',
           'Status is never colour-only.')
    + '</div>';
  // The toggle and the segmented control are NOT in this sheet. Their rules live
  // in booking-rules.css / safety.css / receptionist.css, which this page does
  // not load — injecting them here photographs an unstyled checkbox and proves
  // nothing. They are shot in situ on their own pages instead, which is better
  // evidence anyway: the real control, with the real label beside it.
  var card=document.createElement('section');
  card.className='card sh'; card.innerHTML=html;
  var main=document.querySelector('.content'); main.innerHTML=''; main.appendChild(card);
  document.getElementById('shFoc').focus();
})();`
  .replace('ICONW', JSON.stringify('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>'))
  .replace('ICONX', JSON.stringify('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>'))
  .replace('ICONL', JSON.stringify('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'))
  .replace('ICONI', JSON.stringify('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'));

const IN_SHEET = `(function(){
  var s=document.createElement('style'); s.textContent=${JSON.stringify(SHEET_CSS)};
  document.head.appendChild(s);
  var LOCK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  var ALERT='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';
  function fld(label, body, extra){
    return '<div style="width:236px"><label class="field__label">'+label+'</label>'+body+(extra||'')+'</div>';
  }
  var html='<h3 class="sh__t">Inputs — six states</h3><div class="sh__g">'
    + '<div class="sh__r" style="align-items:flex-start"><span class="sh__l" style="padding-top:26px">rest / hover</span>'
    +   fld('Clinic name', '<input class="input" value="Sri Dental Care">')
    +   fld('Website', '<input class="input" id="shHov" value="sridental.in" style="border-color:var(--line-3)">')
    + '</div>'
    + '<div class="sh__r" style="align-items:flex-start"><span class="sh__l" style="padding-top:26px">focus / error</span>'
    +   fld('Landmark', '<input class="input" id="shFoc" value="Opposite GVK One">')
    +   fld('Escalation number',
          '<div class="in-wrap is-invalid"><span class="pre">+91</span>'
          + '<input class="input tnum" value="98765"></div>',
          '<div class="field__error" style="display:flex">'+ALERT
          + '<span>That\\u2019s 5 digits. Indian mobile numbers have 10.</span></div>')
    + '</div>'
    + '<div class="sh__r" style="align-items:flex-start"><span class="sh__l" style="padding-top:26px">read-only / disabled</span>'
    +   fld('Timezone <span class="field__lock">'+LOCK+'India only for now</span>',
          '<input class="input" value="Asia/Kolkata" readonly>')
    +   fld('WhatsApp number', '<input class="input" value="Not connected yet" disabled>',
          '<p class="field__note">Prantivo connects this once your Meta verification clears.</p>')
    + '</div>'
    + '<div class="sh__r" style="align-items:flex-start"><span class="sh__l" style="padding-top:26px">prefix segments</span>'
    +   fld('Owner number', '<div class="in-wrap"><span class="pre">+91</span>'
          + '<input class="input tnum" value="9876543210"></div>')
    +   fld('Consultation fee', '<div class="in-wrap"><span class="pre">\\u20b9</span>'
          + '<input class="input tnum" value="500"></div>')
    + '</div>'
    + '</div>'
    + '<h3 class="sh__t">Card footer — four states</h3><div class="sh__g">'
    + '<div class="sh__r"><span class="sh__l">clean</span><div style="flex:1;max-width:420px">'
    +   '<div class="card__foot"><span class="save-note">Version 12</span>'
    +   '<button class="btn btn--primary">Save changes</button></div></div></div>'
    + '<div class="sh__r"><span class="sh__l">dirty</span><div style="flex:1;max-width:420px">'
    +   '<div class="card__foot"><span class="save-note save-note--dirty">Unsaved changes</span>'
    +   '<button class="btn btn--primary">Save changes</button></div></div></div>'
    + '<div class="sh__r"><span class="sh__l">saving</span><div style="flex:1;max-width:420px">'
    +   '<div class="card__foot"><span class="save-note save-note--dirty">Unsaved changes</span>'
    +   '<button class="btn btn--primary" aria-busy="true" style="min-width:141px">'
    +   '<svg class="btn__spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10" opacity=".95"/><circle cx="12" cy="12" r="10" opacity=".28"/></svg>Saving\\u2026</button></div></div></div>'
    + '<div class="sh__r"><span class="sh__l">saved</span><div style="flex:1;max-width:420px">'
    +   '<div class="card__foot"><span class="save-note save-note--saved">Saved \\u00b7 v13</span>'
    +   '<button class="btn btn--primary">Save changes</button></div></div></div>'
    + '</div>'
    + '<h3 class="sh__t">Toasts — success clears, error persists</h3><div class="sh__g">'
    + '<div class="sh__r"><span class="sh__l">success</span>'
    +   '<div class="toast toast--ok" style="position:static"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
    +   '<div class="toast__body">Saved \\u00b7 v13</div></div>'
    +   '<span class="sh__n">role="status" \\u00b7 4s</span></div>'
    + '<div class="sh__r"><span class="sh__l">error</span>'
    +   '<div class="toast toast--err" style="position:static"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>'
    +   '<div class="toast__body">Couldn\\u2019t save \\u2014 check your connection and try again.</div>'
    +   '<button class="toast__x" type="button" aria-label="Dismiss"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>'
    +   '<span class="sh__n">role="alert" \\u00b7 persists</span></div>'
    + '</div>';
  var card=document.createElement('section');
  card.className='card sh'; card.innerHTML=html;
  var main=document.querySelector('.content'); main.innerHTML=''; main.appendChild(card);
  document.getElementById('shFoc').focus();
})();`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const scratchName = 'zyon_d5a_' + crypto.randomBytes(5).toString('hex');
  const scratchCs = swapDb(ADMIN, scratchName);

  const c0 = new Client({ connectionString: ADMIN, ssl: SSL });
  await c0.connect();
  await c0.query('CREATE DATABASE ' + scratchName);
  await c0.end();
  console.log('scratch DB:', scratchName);

  let server, chrome, ws, db;
  try {
    await require('../../src/db/migrate').genesis({ connectionString: scratchCs, logger: SILENT });

    process.env.DATABASE_URL = scratchCs;
    process.env.LOG_LEVEL = 'silent';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');
    const { hashPassword } = require('../../src/portal/auth');
    const configService = require('../../src/modules/config/configService');
    const faqService = require('../../src/modules/knowledge/faqService');
    const validationService = require('../../src/modules/validation/validationService');

    // Telugu lifted verbatim from public/demo/fixture.json, exactly as D4 did —
    // this harness authors no vernacular of its own.
    const FIXTURE = require('../../public/demo/fixture.json');
    const TE_LINE = FIXTURE.call.find((t) => t.speaker === 'ai');

    const baseConfig = (name) => ({
      business: {
        display_name: name,
        address: 'Road No. 12, Banjara Hills, Hyderabad 500034',
        landmark: 'Opposite GVK One',
        phone_numbers: ['+919876543210'],
      },
      languages: { supported: ['te', 'en'], default: 'te' },
      notifications: { owner_numbers: ['+919000000001'], on_booking: true, on_escalation: true },
      escalation: {
        enabled: true,
        phone_numbers: ['+919000000002'],
        emergency_guidance: 'Severe swelling or bleeding — come straight in, we keep a slot free.',
      },
      pricing: {
        consultation_fee: 500,
        follow_up_fee: 300,
        emergency_fee: 1200,
        payment_methods: ['upi', 'cash', 'card'],
        treatments: [
          { name: 'Root canal', price: 4500, price_from: true, duration_minutes: 45 },
          { name: 'Teeth cleaning', price: 1500, duration_minutes: 30 },
          { name: 'Crown fitting', price: 150000, duration_minutes: 60 },
        ],
      },
      hours: {
        mon: { open: '09:30', close: '20:00' }, tue: { open: '09:30', close: '20:00' },
        wed: { open: '09:30', close: '20:00' }, thu: { open: '09:30', close: '20:00' },
        fri: { open: '09:30', close: '20:00' }, sat: { open: '09:30', close: '14:00' },
        sun: { closed: true },
      },
      personality: { display_name: 'Asha', style: 'warm_professional', response_length: 'standard' },
      greeting: { te: TE_LINE.text, en: TE_LINE.english_gloss },
      whatsapp: { enabled: false }, voice: { enabled: false }, tools: { booking: false },
    });

    async function seed(name, email, legacyPrompt) {
      const t = await db.query(
        'INSERT INTO tenants (business_name, active, ai_prompt) VALUES ($1,false,$2) RETURNING id',
        [name, legacyPrompt || null]);
      const id = t.rows[0].id;
      await db.query(
        'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
        [id, email, hashPassword('demo-portal-pass'), 'owner']);
      await configService.writeTenantConfig(id, baseConfig(name), 'shootD5a');
      await configService.writeTenantConfigMeta(id, { onboarding_step: 6, onboarding_completed: true });
      await faqService.createFaq(id,
        { question: 'Do you do same-day appointments?', answer: 'Yes, call before 11am.' },
        { languages: ['te', 'en'] });
      // The strip and the panel both read the LATEST PERSISTED validation run —
      // readinessSnapshot never triggers one. Without this the legacy verdict is
      // `null` ("not known") and both components correctly stay quiet, which
      // would make the W6 shot a photograph of nothing.
      await validationService.validateTenant(id, { actor: 'shootD5a' });
      return id;
    }

    const cleanId = await seed('Sri Dental Care', 'owner@sri.test', null);
    const legacyId = await seed('Apollo White Dental', 'owner@apollo.test',
      'You are the receptionist for Apollo White Dental. Answer briefly and book appointments.');
    console.log('seeded: clean tenant', cleanId.slice(0, 8), '· LEGACY tenant', legacyId.slice(0, 8));

    const express = require('express');
    const app = express();
    app.use('/portal', require('../../src/portal/routes'));
    app.use(express.static(path.join(__dirname, '../../public')));
    server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const port = server.address().port;
    const ckClean = await loginCookie(port, 'owner@sri.test', 'demo-portal-pass');
    const ckLegacy = await loginCookie(port, 'owner@apollo.test', 'demo-portal-pass');

    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-d5a-'));
    chrome = spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=' + DEVPORT, '--user-data-dir=' + udd,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      'about:blank',
    ], { stdio: 'ignore' });

    ws = await openWs(await connectBrowser());
    const cdp = new CDP(ws);
    const base = 'http://127.0.0.1:' + port + '/portal';
    const px = (n) => path.join(OUT, n);
    const ready = "document.querySelector('.card')";

    console.log('\nASSERTIONS');

    // ── W1 · the transitional tokens no longer exist ───────────────────────
    console.log('  W1 — --teal-hover / --teal-press are gone, the ramp resolves:');
    await probe(cdp, { url: base + '/pricing.html', cookie: ckClean, port, waitFor: ready, checks: [
      ['--teal-hover resolves to', "getComputedStyle(document.documentElement).getPropertyValue('--teal-hover').trim()", ''],
      ['--teal-press resolves to', "getComputedStyle(document.documentElement).getPropertyValue('--teal-press').trim()", ''],
      ['--teal-700 (the accent)', "getComputedStyle(document.documentElement).getPropertyValue('--teal-700').trim()", '#0f766e'],
      ['--teal-800 (primary hover)', "getComputedStyle(document.documentElement).getPropertyValue('--teal-800').trim()", '#115e59'],
      ['--teal-900 (primary press)', "getComputedStyle(document.documentElement).getPropertyValue('--teal-900').trim()", '#134e4a'],
      ['a selected payment pill is teal-700, not teal-900',
        "getComputedStyle(document.querySelector('.pay-toggle[aria-pressed=\\\"true\\\"]')).color", 'rgb(15, 118, 110)'],
      ['--amber-50 canonical', "getComputedStyle(document.documentElement).getPropertyValue('--amber-50').trim()", '#fffbeb'],
      ['--amber-050 still resolves through the alias',
        "(function(){var d=document.createElement('div');d.style.color='var(--amber-050)';document.body.appendChild(d);var c=getComputedStyle(d).color;d.remove();return c;})()",
        'rgb(255, 251, 235)'],
    ] });

    // ── W2 · no card casts a shadow ────────────────────────────────────────
    console.log('  W2 — .card / .doc / .faq compute NO box-shadow:');
    await probe(cdp, { url: base + '/doctors.html', cookie: ckClean, port, waitFor: ready, checks: [
      ['.card box-shadow', "getComputedStyle(document.querySelector('.card')).boxShadow", 'none'],
      ['.doc exists', "!!document.querySelector('.doc') || 'no doctors seeded — shape asserted below'", 'no doctors seeded — shape asserted below'],
      ['.doc box-shadow (synthesised node, real rule)',
        "(function(){var d=document.createElement('div');d.className='doc';document.querySelector('.content').appendChild(d);var s=getComputedStyle(d).boxShadow;d.remove();return s;})()",
        'none'],
      ['.faq box-shadow (synthesised node, real rule)',
        "(function(){var d=document.createElement('div');d.className='faq';document.querySelector('.content').appendChild(d);var s=getComputedStyle(d).boxShadow;d.remove();return s;})()",
        'none'],
    ] });

    // ── W3 · modal and drawer take --shadow-lg ─────────────────────────────
    // Compared against the TOKEN's own computed value, not a literal — so the
    // assertion cannot pass by accident if the token is edited.
    console.log('  W3 — the modal and the drawer compute --shadow-lg:');
    const LG = `(function(){var d=document.createElement('div');d.style.boxShadow='var(--shadow-lg)';
      document.body.appendChild(d);var s=getComputedStyle(d).boxShadow;d.remove();return s;})()`;
    await probe(cdp, { url: base + '/index.html', cookie: ckClean, port, waitFor: ready, checks: [
      ['.modal === --shadow-lg',
        `(function(){var h=document.createElement('div');h.className='modal-host';
          h.innerHTML='<div class="modal"></div>';document.body.appendChild(h);
          var s=getComputedStyle(h.querySelector('.modal')).boxShadow;h.remove();
          return s === ${LG};})()`, true],
      ['.toast is --shadow-md, NOT lg (only modals float that far)',
        `(function(){var d=document.createElement('div');d.className='toast';document.body.appendChild(d);
          var s=getComputedStyle(d).boxShadow;d.remove();
          var md=document.createElement('div');md.style.boxShadow='var(--shadow-md)';document.body.appendChild(md);
          var m=getComputedStyle(md).boxShadow;md.remove();return s===m;})()`, true],
    ] });
    await probe(cdp, { url: base + '/index.html', cookie: ckClean, port, waitFor: ready, width: 380, mobile: true, checks: [
      ['.side (drawer) === --shadow-lg at 380',
        `getComputedStyle(document.querySelector('.side')).boxShadow === ${LG}`, true],
    ] });

    // ── busy button holds its width ────────────────────────────────────────
    console.log('  A — the busy button does not change width:');
    await probe(cdp, { url: base + '/pricing.html', cookie: ckClean, port, waitFor: "document.getElementById('saveBtn')", checks: [
      ['rest width === busy width',
        `(function(){var b=document.getElementById('saveBtn');
          var rest=Math.round(b.getBoundingClientRect().width);
          window.Portal.setBusy(b,true);
          var busy=Math.round(b.getBoundingClientRect().width);
          var label=b.textContent.trim();
          window.Portal.setBusy(b,false);
          return [rest===busy, label, Math.round(b.getBoundingClientRect().width)===rest];})()`,
        [true, 'Saving…', true]],
      ['busy is announced and still guarded against double-submit',
        `(function(){var b=document.getElementById('saveBtn');window.Portal.setBusy(b,true);
          var r=[b.getAttribute('aria-busy'), b.disabled];window.Portal.setBusy(b,false);return r;})()`,
        ['true', true]],
      ['the rest label is restored exactly',
        `(function(){var b=document.getElementById('saveBtn');var before=b.textContent;
          window.Portal.setBusy(b,true);window.Portal.setBusy(b,false);
          return b.textContent===before;})()`, true],
    ] });

    // ── W5 · the not-live strip, Home vs everywhere else ───────────────────
    console.log('  W5 — the not-live strip is suppressed on Home ONLY:');
    await probe(cdp, { url: base + '/index.html', cookie: ckClean, port, waitFor: ready, checks: [
      ['Home: strip absent', "document.querySelectorAll('#truthStrip .ts').length", 0],
      ['Home: the ring is what says it instead', "!!document.querySelector('.ring, .ring-sk')", true],
    ] });
    await probe(cdp, { url: base + '/pricing.html', cookie: ckClean, port, waitFor: ready, awaitReady: true, checks: [
      ['Pricing, same tenant: exactly one strip', "document.querySelectorAll('#truthStrip .ts').length", 1],
      ['and it is the not-live one',
        "document.querySelector('#truthStrip .ts span').textContent.startsWith('Your receptionist isn’t answering calls yet')",
        true],
      ['which offers the link Home could not',
        "document.querySelector('#truthStrip .ts__a').textContent.trim()", 'See what’s left'],
    ] });

    // ── W6 · the panel and the strip agree on a legacy tenant ──────────────
    console.log('  W6 — legacy tenant: the panel stops claiming to be live:');
    await probe(cdp, { url: base + '/pricing.html', cookie: ckLegacy, port,
      waitFor: "document.querySelector('#vpLabel')", awaitReady: true, checks: [
        ['panel header reads', "document.getElementById('vpLabel').textContent.trim()", 'Saved settings'],
        ['the live dot is gone', "document.querySelectorAll('#vpLabel .vp__dot').length", 0],
        ['the panel landmark is renamed too', "document.getElementById('verbatim').getAttribute('aria-label')", 'Saved settings'],
        ['the strip above it is the LEGACY one, not not-live',
          "document.querySelector('#truthStrip .ts').className", 'ts ts--warn'],
        ['and it names what this page loses',
          "document.querySelector('#truthStrip .ts span').textContent.startsWith('Saved but not in use: your prices')",
          true],
        ['still exactly one strip', "document.querySelectorAll('#truthStrip .ts').length", 1],
      ] });
    await probe(cdp, { url: base + '/pricing.html', cookie: ckClean, port,
      waitFor: "document.querySelector('#vpLabel')", awaitReady: true, checks: [
        ['control — a clean tenant still reads Live preview, dot intact',
          "[document.getElementById('vpLabel').textContent.trim(), document.querySelectorAll('#vpLabel .vp__dot').length]",
          ['Live preview', 1]],
      ] });

    // ── G · every disabled control carries a reason ────────────────────────
    console.log('  G — disabled controls and their reasons:');
    await probe(cdp, { url: base + '/test.html', cookie: ckClean, port,
      waitFor: "document.getElementById('chatWhy')", checks: [
        ['Test: the cap reason exists and is hidden while quota remains',
          "document.getElementById('chatWhy').hidden", true],
        ['Test: exhausting the quota reveals it beside the composer',
          `(function(){window.Portal;var ev=document.getElementById('chatWhy');
            var b=document.getElementById('sendBtn');
            // drive the page's own updateRemaining via its public effect
            var badge=document.getElementById('remainingBadge');
            badge.textContent='0 test messages left today';
            document.getElementById('chatInput').disabled=true;b.disabled=true;ev.hidden=false;
            return [b.disabled, ev.hidden, ev.offsetHeight>0];})()`, [true, false, true]],
      ] });
    await probe(cdp, { url: base + '/pricing.html', cookie: ckClean, port,
      waitFor: "document.querySelector('#vpLangWhy')", checks: [
        ['Panel: Hear it is disabled and its reason is visible',
          `(function(){var b=document.querySelector('.vp__btn[disabled]');
            var w=document.querySelector('.vp__why');
            return [!!b, w.textContent.trim(), w.offsetHeight>0];})()`,
          [true, 'Needs a paid voice key and a live deploy', true]],
        ['Panel: two languages enabled, so the selector is NOT disabled',
          "document.getElementById('vpLang').disabled", false],
      ] });

    // ── DIAGNOSTIC, not an assertion: a pre-existing D4 race ───────────────
    //
    // The W6 shot caught the panel showing "No consultation fee" directly under
    // a FACTS row reading "Consultation ₹500" — the panel contradicting itself.
    // It is NOT a D5a regression: warnings() reads ONLY the live DOM
    // (verbatim.js:370), the FACTS row falls back to the SAVED value
    // (verbatim.js:253), and the panel renders the moment its own
    // /knowledge-summary fetch resolves — which races the page's independent
    // /config/pricing fetch. When the panel wins, it computes warnings against a
    // form that has not been filled yet, and nothing re-renders it afterwards
    // because fill() sets .value programmatically and that fires no input event.
    // So the stale warning survives until the owner types something.
    //
    // Measured rather than argued: same clean tenant, same page, N loads.
    // Reported, not asserted — fixing it is out of D5a's scope (the Verbatim
    // panel beyond W6). Filed for the plan.
    console.log('  DIAGNOSTIC — D4 warning/FACTS race on Pricing (reported, not asserted):');
    for (const [who, ck] of [['clean ', ckClean], ['legacy', ckLegacy]]) {
      let bad = 0;
      const N = 6;
      for (let i = 0; i < N; i += 1) {
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Page.enable', {}, sessionId);
        await cdp.send('Network.enable', {}, sessionId);
        // Mirror the SHOT's conditions exactly, because that is where it was
        // caught: 2× device scale (heavier raster competes with the page's own
        // JS) and the panel expanded. A probe at 1× never reproduced it.
        await cdp.send('Emulation.setDeviceMetricsOverride',
          { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, sessionId);
        await cdp.send('Network.setCookie',
          { name: ck.name, value: ck.value, url: `http://127.0.0.1:${port}/` }, sessionId);
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: "try{localStorage.setItem('portal.verbatim.collapsed','0');}catch(e){}",
        }, sessionId);
        const loaded = new Promise((res) => {
          cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
        });
        await cdp.send('Page.navigate', { url: base + '/pricing.html' }, sessionId);
        await loaded;
        await waitForSelector(cdp, sessionId, "document.querySelector('#vpLive .vp__bub')");
        await sleep(1400);
        const r = await cdp.send('Runtime.evaluate', {
          expression: `(function(){
            var fee=(document.getElementById('consultation_fee')||{}).value||'';
            var warn=/No consultation fee/.test(document.getElementById('vpLive').textContent);
            return fee.trim()!=='' && warn;})()`,
          returnByValue: true,
        }, sessionId);
        if (r.result && r.result.value) bad += 1;
        await cdp.send('Target.closeTarget', { targetId });
      }
      console.log(`    ${bad === 0 ? '·' : '!'} ${who} tenant: panel contradicted itself on ${bad}/${N} loads`
        + ' (form filled, yet "No consultation fee" shown)');
    }

    // ── copy rules that must still hold ────────────────────────────────────
    console.log('  copy — the retired framings stay retired:');
    await probe(cdp, { url: base + '/pricing.html', cookie: ckClean, port, waitFor: ready, checks: [
      ['no AI Employee / AI Operating System / Submit in the rendered page',
        "/AI Employee|AI Operating System|>\\\\s*Submit\\\\s*</.test(document.body.innerHTML)", false],
    ] });

    console.log('\nSHEETS');
    await shoot(cdp, { url: base + '/pricing.html', out: px('d5a-buttons-1440.png'),
      width: 1440, height: 1200, cookie: ckClean, port, waitFor: ready,
      preload: null, collapsed: true, settle: 900,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: BTN_SHEET }, sid);
        await sleep(250);
        // :focus-visible needs the page to be in keyboard modality FIRST — Tab to
        // establish it, then place focus on the element the row is about. Doing
        // it the other way round (focus, then Tab) moves focus one control on,
        // and the ring lands in the wrong row.
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sid);
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sid);
        await sleep(100);
        await c.send('Runtime.evaluate', { expression: "document.getElementById('shFoc').focus()" }, sid);
        await sleep(150);
      } });

    await shoot(cdp, { url: base + '/pricing.html', out: px('d5a-inputs-1440.png'),
      width: 1440, height: 1200, cookie: ckClean, port, waitFor: ready,
      collapsed: true, settle: 900,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: IN_SHEET }, sid);
        await sleep(250);
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sid);
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sid);
        await sleep(150);
      } });

    // The toggle and the segmented control, in situ on the pages that own their
    // stylesheets. Both carry their state as a WORD, so neither reads as
    // colour-only — which is the whole point of section C.
    console.log('\ntoggle and segmented — in situ');
    await shoot(cdp, { url: base + '/booking-rules.html', out: px('d5a-toggle-booking.png'),
      width: 1100, height: 900, cookie: ckClean, port, waitFor: "document.querySelector('.switch__track')",
      collapsed: true, clipToViewport: true });
    await shoot(cdp, { url: base + '/receptionist.html', out: px('d5a-segmented-receptionist.png'),
      width: 1100, height: 900, cookie: ckClean, port, waitFor: "document.querySelector('.segmented__btn')",
      collapsed: true, clipToViewport: true });

    console.log('\nW5 — the two screenshots');
    await shoot(cdp, { url: base + '/index.html', out: px('d5a-w5-home-no-strip.png'),
      width: 1440, height: 900, cookie: ckClean, port, waitFor: ready, collapsed: true, clipToViewport: true });
    await shoot(cdp, { url: base + '/hours.html', out: px('d5a-w5-hours-strip.png'),
      width: 1440, height: 900, cookie: ckClean, port, waitFor: ready, collapsed: true, clipToViewport: true });

    console.log('\nW6 — the panel and the strip in one frame');
    await shoot(cdp, { url: base + '/pricing.html', out: px('d5a-w6-legacy-pricing.png'),
      width: 1440, height: 900, cookie: ckLegacy, port,
      waitFor: "document.querySelector('#vpLabel')", collapsed: false, clipToViewport: true });
    await shoot(cdp, { url: base + '/pricing.html', out: px('d5a-w6-clean-control.png'),
      width: 1440, height: 900, cookie: ckClean, port,
      waitFor: "document.querySelector('#vpLabel')", collapsed: false, clipToViewport: true });

    console.log('\nG — reasons beside disabled controls');
    await shoot(cdp, { url: base + '/test.html', out: px('d5a-g-test-cap.png'),
      width: 1440, height: 900, cookie: ckClean, port, waitFor: "document.getElementById('chatWhy')",
      collapsed: true, clipToViewport: true,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression:
          `document.getElementById('remainingBadge').textContent='0 test messages left today';
           document.getElementById('remainingBadge').className='badge badge--warn';
           document.getElementById('chatInput').disabled=true;
           document.getElementById('sendBtn').disabled=true;
           document.querySelectorAll('.starter').forEach(function(b){b.disabled=true;});
           document.getElementById('chatWhy').hidden=false;` }, sid);
        await sleep(200);
      } });
    await shoot(cdp, { url: base + '/wizard.html', out: px('d5a-g-wizard-back.png'),
      width: 1100, height: 900, cookie: ckClean, port,
      waitFor: "document.getElementById('wizBackWhy')", settle: 1800, clipToViewport: true });

    console.log('\nfocus ring — keyboard only');
    await shoot(cdp, { url: base + '/safety.html', out: px('d5a-focus-light.png'),
      width: 1440, height: 900, cookie: ckClean, port, waitFor: ready, collapsed: true, clipToViewport: true,
      afterReady: async (c, sid) => {
        for (let i = 0; i < 6; i += 1) {
          await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sid);
          await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sid);
          await sleep(60);
        }
        await sleep(200);
      } });
    await shoot(cdp, { url: base + '/pricing.html', out: px('d5a-focus-ink.png'),
      width: 1440, height: 900, cookie: ckClean, port,
      waitFor: "document.querySelector('#vpLang')", collapsed: false, clipToViewport: true,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression:
          "document.getElementById('vpLang').focus();" }, sid);
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sid);
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sid);
        await sleep(250);
      } });

    console.log('\ntoasts — desktop bottom-right, mobile top-centre');
    const RAISE = `(function(){window.addEventListener('load',function(){setTimeout(function(){
      window.Portal.toast('Saved \\u00b7 v13', true);
      window.Portal.toast('Couldn\\u2019t save \\u2014 check your connection and try again.', false);
    },400);});})();`;
    await shoot(cdp, { url: base + '/pricing.html', out: px('d5a-toast-desktop.png'),
      width: 1440, height: 900, cookie: ckClean, port, waitFor: ready,
      collapsed: true, clipToViewport: true, preload: RAISE, settle: 1600 });
    await shoot(cdp, { url: base + '/pricing.html', out: px('d5a-toast-mobile.png'),
      width: 380, height: 820, mobile: true, cookie: ckClean, port, waitFor: ready,
      collapsed: true, clipToViewport: true, preload: RAISE, settle: 1600 });

    console.log('\nall assertions passed');
  } finally {
    if (ws) try { ws.close(); } catch (_) { /* ignore */ }
    if (chrome) try { chrome.kill(); } catch (_) { /* ignore */ }
    if (server) try { server.close(); } catch (_) { /* ignore */ }
    if (db && db.pool) try { await db.pool.end(); } catch (_) { /* ignore */ }
    const c1 = new Client({ connectionString: ADMIN, ssl: SSL });
    await c1.connect();
    await c1.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${scratchName}'`);
    await c1.query('DROP DATABASE IF EXISTS ' + scratchName);
    await c1.end();
    console.log('dropped scratch DB', scratchName);
  }
})().catch((e) => { console.error(e); process.exit(1); });
