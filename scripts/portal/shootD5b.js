'use strict';

/* ============================================================================
 * D5b tables + mobile pass — screenshot + assertion evidence. Dev tooling.
 *
 * Same machinery as shoot.js / shootD3.js / shootD4.js / shootD5a.js (throwaway
 * scratch DB -> genesis -> real routers -> CDP). What is different here:
 *
 *   1. THE HARD OUTCOME IS A MEASUREMENT, not a screenshot. `measure()` walks
 *      all 12 navigation destinations at 320px and 380px and reports
 *      document.scrollWidth vs clientWidth for each. The session's acceptance
 *      criterion — zero horizontal scroll at 320px on every page — is that
 *      table, run before and after, never an eyeball on a PNG.
 *
 *   2. It also names the WIDEST OFFENDING ELEMENT when a page overflows, so a
 *      failure points at a selector rather than at a page.
 *
 *   3. The tenant is seeded with data that is deliberately hostile to a narrow
 *      viewport: a six-figure fee, a long Telugu treatment name, a doctor with
 *      a long name, holidays, and FAQs. A page with no rows cannot overflow.
 *
 * Usage:  node scripts/portal/shootD5b.js            (full run)
 *         MEASURE_ONLY=1 node scripts/portal/shootD5b.js   (the 0.3 table only)
 * Output: scripts/portal/shots/d5b-*.png
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
const DEVPORT = 9338; // 9333/9334/9336/9337 are taken by the earlier harnesses
const MEASURE_ONLY = !!process.env.MEASURE_ONLY;
/**
 * BEFORE=1 — skip every assertion and suffix the output `-before`.
 *
 * The session's deliverable is each register at 1440 and 380 BEFORE AND AFTER,
 * and the "before" state is by definition one where the assertions fail: that is
 * what the session was for. Without this switch the run dies on the first
 * measurement and never reaches a camera, so the pair can only ever be
 * half-produced. Check the pre-session files out into the working tree, run with
 * BEFORE=1, restore, run normally.
 */
const BEFORE = !!process.env.BEFORE;
const SUFFIX = BEFORE ? '-before' : '';

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

async function newPage(cdp, { url, cookie, port, width, height, mobile, preload, collapsed, waitFor, zoom }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: width || 1440, height: height || 900, deviceScaleFactor: 1, mobile: !!mobile,
  }, sessionId);
  if (zoom) await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }, sessionId);
  if (cookie) {
    await cdp.send('Network.setCookie',
      { name: cookie.name, value: cookie.value, url: `http://127.0.0.1:${port}/` }, sessionId);
  }
  // One Chrome profile is shared by every target, so the Verbatim panel's
  // collapse preference leaks between targets unless each one states it.
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
  return { targetId, sessionId };
}

async function shoot(cdp, opts) {
  const { out, settle, clipToViewport, afterReady, awaitReady } = opts;
  const { targetId, sessionId } = await newPage(cdp, opts);
  // deviceScaleFactor 2 for the actual capture — the measurement pass wants 1.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: opts.width, height: opts.height, deviceScaleFactor: 2, mobile: !!opts.mobile,
  }, sessionId);
  // The truth strip paints in the continuation of the shell's own memoised
  // readiness promise. Without awaiting it, a shot of a page that HAS a strip
  // may or may not contain one, from an identical tree.
  if (awaitReady) {
    await cdp.send('Runtime.evaluate', {
      expression: 'window.Portal.readinessOnce().then(function(){return true;}).catch(function(){return false;})',
      returnByValue: true, awaitPromise: true,
    }, sessionId);
    await sleep(300);
  }
  if (afterReady) await afterReady(cdp, sessionId);
  await sleep(settle == null ? 1400 : settle);
  const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
  const inner = clipToViewport
    ? (await cdp.send('Runtime.evaluate', {
      expression: '[window.innerWidth, window.innerHeight].join(",")', returnByValue: true,
    }, sessionId)).result.value.split(',').map(Number)
    : null;
  const size = clipToViewport
    ? { width: inner[0] || opts.width, height: inner[1] || opts.height }
    : (metrics.cssContentSize || { width: opts.width, height: opts.height });
  // With clipToViewport the clip is OMITTED, not set to the viewport's size: a
  // clip is in PAGE coordinates, so `{x:0,y:0}` photographs the top of the
  // document however far the page has been scrolled. That is what produced a
  // "sticky save bar" screenshot showing the top of Pricing and no save bar.
  const shotRes = await cdp.send('Page.captureScreenshot', clipToViewport
    ? { format: 'png', captureBeyondViewport: false }
    : {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: size.width, height: Math.ceil(size.height), scale: 1 },
    }, sessionId);
  fs.writeFileSync(out, Buffer.from(shotRes.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  console.log('  ✓', path.basename(out), `(${Math.round(size.width)}×${Math.round(size.height)})`);
}

async function probe(cdp, opts) {
  const { checks, awaitReady } = opts;
  const { targetId, sessionId } = await newPage(cdp, opts);
  if (awaitReady) {
    await cdp.send('Runtime.evaluate', {
      expression: 'window.Portal.readinessOnce().then(function(){return true;})',
      returnByValue: true, awaitPromise: true,
    }, sessionId);
    await sleep(350);
  }
  await sleep(opts.settle == null ? 600 : opts.settle);
  if (opts.afterReady) await opts.afterReady(cdp, sessionId);
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
  if (failed) throw new Error(`${failed} DOM assertion(s) failed on ${opts.url}`);
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

/**
 * "This writing page has finished loading."
 *
 * The last thing every writing page's main() does is stamp `Version N` into
 * #saveNote — after fill() has run and after `baseline` has been snapshotted.
 * Waiting on a form FIELD instead is a race: the fields are in the parsed HTML
 * from the first byte, so a probe that types into one before main() resolves has
 * its value overwritten by fill() and its dirty flag cleared by the same line
 * that stamps the version. That is exactly what produced a "sticky save bar"
 * screenshot with no save bar in it, and it is the kind of race that reports a
 * feature as broken when the feature is fine and the harness is early.
 */
const FORM_READY = "document.getElementById('saveNote') && document.getElementById('saveNote').textContent.length > 0";

// The 12 navigation destinations (shell.js NAV; `Documents` is an inert Soon
// row with no page). Every one is measured; none is sampled.
const PAGES = [
  ['Home',             'index.html'],
  ['Clinic profile',   'clinic-profile.html'],
  ['Hours & holidays', 'hours.html'],
  ['Pricing',          'pricing.html'],
  ['Doctors',          'doctors.html'],
  ['Booking rules',    'booking-rules.html'],
  ['FAQs',             'faqs.html'],
  ['Receptionist',     'receptionist.html'],
  ['Safety & handoff', 'safety.html'],
  ['What it knows',    'knows.html'],
  ['Test',             'test.html'],
  ['History',          'history.html'],
];

/**
 * The session's hard outcome. scrollWidth > clientWidth on the document element
 * IS horizontal scroll — it is what the browser itself uses to decide whether to
 * draw the bar. When a page overflows we also walk every element and report the
 * widest right edge, so the failure names a selector.
 */
const OVERFLOW_EXPR = `(function(){
  var d=document.documentElement;
  var over=d.scrollWidth - d.clientWidth;
  var worst=null;
  if(over>0){
    var vw=d.clientWidth, max=vw;
    var all=document.querySelectorAll('*');
    for(var i=0;i<all.length;i++){
      var e=all[i];
      var r=e.getBoundingClientRect();
      if(r.width===0&&r.height===0) continue;
      var right=r.right + window.scrollX;
      if(right>max+0.5){
        max=right;
        worst=(e.tagName.toLowerCase())
          + (e.id?('#'+e.id):'')
          + (e.className&&typeof e.className==='string'?('.'+e.className.trim().split(/\\s+/).join('.')):'')
          + ' @'+Math.round(right);
      }
    }
  }
  return [d.scrollWidth, d.clientWidth, over, worst];
})()`;

async function measure(cdp, { base, cookie, port, label }) {
  const widths = [320, 380];
  const rows = [];
  for (const [name, file] of PAGES) {
    const row = { name, file, at: {} };
    for (const w of widths) {
      const { targetId, sessionId } = await newPage(cdp, {
        url: base + '/' + file, cookie, port, width: w, height: 820, mobile: true,
        collapsed: true, waitFor: "document.querySelector('.content')",
      });
      // The truth strip is painted in the continuation of the shell's OWN
      // memoised readiness promise. Sleeping and hoping is what made the first
      // baseline run read 0 overflow on Doctors at 380 and 10 at 320 from an
      // identical tree — the strip simply had not landed yet on that target.
      // Await the same promise (never a second fetch) before measuring.
      await cdp.send('Runtime.evaluate', {
        expression: 'window.Portal.readinessOnce().then(function(){return true;}).catch(function(){return false;})',
        returnByValue: true, awaitPromise: true,
      }, sessionId);
      await sleep(1500);
      const r = await cdp.send('Runtime.evaluate',
        { expression: OVERFLOW_EXPR, returnByValue: true }, sessionId);
      const [sw, cw, over, worst] = r.result.value;
      row.at[w] = { sw, cw, over, worst };
      await cdp.send('Target.closeTarget', { targetId });
    }
    rows.push(row);
  }
  console.log(`\n  ── ${label} — document.scrollWidth vs clientWidth ──`);
  console.log('  page                 320: scroll/client  over    380: scroll/client  over');
  let bad = 0;
  for (const r of rows) {
    const a = r.at[320]; const b = r.at[380];
    if (a.over > 0 || b.over > 0) bad += 1;
    console.log('  ' + r.name.padEnd(20)
      + String(a.sw).padStart(6) + '/' + String(a.cw).padEnd(5)
      + String(a.over).padStart(6) + '   '
      + String(b.sw).padStart(6) + '/' + String(b.cw).padEnd(5)
      + String(b.over).padStart(6)
      + (a.worst ? '\n      320 widest: ' + a.worst : '')
      + (b.worst ? '\n      380 widest: ' + b.worst : ''));
  }
  console.log(`  ${bad === 0 ? '✓' : '✗'} ${12 - bad}/12 pages with zero horizontal scroll at both widths`);
  return { rows, bad };
}

/**
 * The 640–767 band. Spec §2.9 requires that no table has horizontal scroll below
 * 768px; this portal's table→card breakpoint is 640, because 768 is a round
 * number the spec chose without reading a stylesheet that uses 860/640/560/520/
 * 480 and nothing between. That leaves a 128px band where the tables are still
 * in ROW form, and the honest thing is to measure it rather than argue that the
 * 760px content column makes it safe.
 *
 * Only the pages carrying a table-shaped register are walked — the band is about
 * tables, and a page without one has nothing to say here.
 */
const BAND_PAGES = [
  ['Hours & holidays', 'hours.html'],
  ['Pricing',          'pricing.html'],
  ['Doctors',          'doctors.html'],
  ['FAQs',             'faqs.html'],
  ['What it knows',    'knows.html'],
  ['History',          'history.html'],
  ['Home',             'index.html'],
];

async function measureBand(cdp, { base, cookie, port }) {
  console.log('\n  ── the 640–767 band — tables are still ROWS here ──');
  let bad = 0;
  for (const [name, file] of BAND_PAGES) {
    const out = [];
    for (const w of [640, 700, 767]) {
      const { targetId, sessionId } = await newPage(cdp, {
        url: base + '/' + file, cookie, port, width: w, height: 900, mobile: true,
        collapsed: true, waitFor: "document.querySelector('.content')",
      });
      await cdp.send('Runtime.evaluate', {
        expression: 'window.Portal.readinessOnce().then(function(){return true;}).catch(function(){return false;})',
        returnByValue: true, awaitPromise: true,
      }, sessionId);
      await sleep(1200);
      const r = await cdp.send('Runtime.evaluate', { expression: OVERFLOW_EXPR, returnByValue: true }, sessionId);
      const [, , over, worst] = r.result.value;
      if (over > 0) bad += 1;
      out.push(`${w}:${over}${worst ? ' (' + worst + ')' : ''}`);
      await cdp.send('Target.closeTarget', { targetId });
    }
    console.log('  ' + name.padEnd(20) + 'overflow at ' + out.join('  ·  '));
  }
  console.log(`  ${bad === 0 ? '✓' : '✗'} ${bad} overflowing measurement(s) across ${BAND_PAGES.length} pages × 3 widths`);
  return bad;
}

/**
 * Every interactive element on a page, measured at its EFFECTIVE touch target.
 *
 * A 16px checkbox inside a <label> is not a 16px target — the label is what the
 * thumb lands on, and clicking it toggles the box. Measuring the raw <input>
 * would report a failure the owner cannot experience and hide the real question,
 * which is how big the thing you can actually hit is. Where a control has a
 * wrapping label, that label is the target and the input is skipped.
 */
const TARGETS_EXPR = `(function(){
  var sel='button, a[href], input:not([type=hidden]), select, textarea, [role=button], [tabindex]:not([tabindex="-1"])';
  var out=[], seen=[];
  var nodes=document.querySelectorAll(sel);
  for(var i=0;i<nodes.length;i++){
    var e=nodes[i];
    if(e.closest('.side, .side__scrim, [hidden], .sk-wrap')) continue;
    if(e.disabled) continue;
    var cs=getComputedStyle(e);
    if(cs.visibility==='hidden'||cs.display==='none') continue;
    var t=e;
    if(e.tagName==='INPUT'&&(e.type==='checkbox'||e.type==='radio')){
      var lab=e.closest('label');
      if(lab) t=lab;
    }
    if(seen.indexOf(t)!==-1) continue;
    seen.push(t);
    var r=t.getBoundingClientRect();
    if(r.width===0&&r.height===0) continue;
    out.push({
      s:(t.tagName.toLowerCase())+(t.id?('#'+t.id):'')
        +(t.className&&typeof t.className==='string'?('.'+t.className.trim().split(/\\s+/).slice(0,2).join('.')):''),
      w:Math.round(r.width*10)/10, h:Math.round(r.height*10)/10,
    });
  }
  return out;
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const scratchName = 'zyon_d5b_' + crypto.randomBytes(5).toString('hex');
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
    const doctorService = require('../../src/modules/doctor/doctorService');
    const validationService = require('../../src/modules/validation/validationService');

    // Telugu lifted verbatim from public/demo/fixture.json — this harness
    // authors no vernacular of its own (same rule D4 and D5a followed).
    const FIXTURE = require('../../public/demo/fixture.json');
    const TE_LINE = FIXTURE.call.find((t) => t.speaker === 'ai');

    const YEAR = new Date().getFullYear() + 1;
    const config = {
      business: {
        display_name: 'Sri Sai Multispeciality Dental Care',
        address: 'Plot 42, Road No. 12, Banjara Hills, Hyderabad 500034',
        landmark: 'Opposite GVK One shopping mall, next to the HDFC ATM',
        phone_numbers: ['+919876543210', '+919876543211'],
      },
      languages: { supported: ['te', 'hi', 'en'], default: 'te' },
      notifications: { owner_numbers: ['+919000000001'], on_booking: true, on_escalation: true },
      escalation: {
        enabled: true,
        phone_numbers: ['+919000000002'],
        emergency_guidance: 'Severe swelling or bleeding — come straight in, we keep a slot free.',
      },
      // Deliberately hostile to a narrow viewport: a six-figure fee, a long
      // treatment name, and a Telugu name. A short list cannot overflow.
      pricing: {
        consultation_fee: 500,
        follow_up_fee: 300,
        emergency_fee: 1200,
        payment_methods: ['upi', 'cash', 'card'],
        treatments: [
          { name: 'Root canal treatment (single sitting)', price: 4500, price_from: true, duration_minutes: 45, notes: 'Includes the follow-up review visit' },
          { name: 'Teeth cleaning and polishing', price: 1500, duration_minutes: 30 },
          { name: 'Full-mouth implant rehabilitation', price: 185000, duration_minutes: 120 },
          { name: 'దంత శుభ్రత', price: 900, duration_minutes: 20 },
          { name: 'Wisdom tooth extraction', price: 6500, price_from: true, duration_minutes: 60, archived: true },
        ],
      },
      hours: {
        mon: { open: '09:30', close: '20:00' }, tue: { open: '09:30', close: '20:00' },
        wed: { open: '09:30', close: '20:00' }, thu: { open: '09:30', close: '20:00' },
        fri: { open: '09:30', close: '20:00' }, sat: { open: '09:30', close: '14:00' },
        sun: { closed: true },
        holidays: [
          { date: `${YEAR}-01-26`, name: 'Republic Day' },
          { date: `${YEAR}-08-15`, name: 'Independence Day — clinic closed all day' },
          { date: '2020-10-02', name: 'Gandhi Jayanti' },
        ],
      },
      booking: { slot_minutes: 30, advance_days: 30, buffer_minutes: 10, allow_same_day: true,
        cancellation_policy: 'Call us at least four hours before your slot and we will move it free of charge.' },
      personality: { display_name: 'Asha', style: 'warm_professional', response_length: 'standard' },
      greeting: { te: TE_LINE.text, en: TE_LINE.english_gloss },
      whatsapp: { enabled: false }, voice: { enabled: false }, tools: { booking: false },
    };

    const t = await db.query(
      'INSERT INTO tenants (business_name, active, ai_prompt) VALUES ($1,false,NULL) RETURNING id',
      ['Sri Sai Multispeciality Dental Care']);
    const tenantId = t.rows[0].id;
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [tenantId, 'owner@sri.test', hashPassword('demo-portal-pass'), 'owner']);
    await configService.writeTenantConfig(tenantId, config, 'shootD5b');
    // A second and third revision, so History has a REGISTER rather than a
    // single row — a one-row list cannot show a row rule, a hover, or the
    // absence of zebra striping, which is most of what section A asserts.
    //
    // Each write passes the WHOLE document. writeTenantConfig merges its input
    // onto clinicDefaults, not onto the live document (PORTAL-P2-S4), so posting
    // `{ pricing: { consultation_fee: 550 } }` on its own does not edit one fee
    // — it replaces the clinic with the defaults plus that fee, and the seeded
    // treatments vanish.
    await configService.writeTenantConfig(tenantId,
      { ...config, pricing: { ...config.pricing, consultation_fee: 550 } }, 'owner@sri.test');
    await configService.writeTenantConfig(tenantId,
      { ...config, pricing: { ...config.pricing, consultation_fee: 500 },
        business: { ...config.business, landmark: 'Opposite GVK One, beside the HDFC ATM' } },
      'owner@sri.test');
    await configService.writeTenantConfigMeta(tenantId, { onboarding_step: 6, onboarding_completed: true });

    for (const d of [
      { name: 'Dr. Venkateswara Rao Kondapalli', specialization: 'Endodontist and root canal specialist' },
      { name: 'Dr. Priya Sharma', specialization: 'Orthodontist' },
    ]) {
      await doctorService.createDoctor(tenantId, {
        name: d.name, specialization: d.specialization, languages: ['te', 'en'],
        days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], start: '10:00', end: '18:00',
      }, { languages: ['te', 'hi', 'en'] });
    }
    for (const f of [
      { question: 'Do you do same-day appointments?', answer: 'Yes — call before 11am and we will fit you in the same day.' },
      { question: 'Is parking available at the clinic?', answer: 'Yes, there is basement parking under the building.' },
      { question: 'Do you treat children?', answer: 'Yes, we see children from age three upwards.' },
    ]) {
      await faqService.createFaq(tenantId, f, { languages: ['te', 'en'] });
    }
    // Both the truth strip and the Verbatim panel read the LATEST PERSISTED
    // validation run; readinessSnapshot never triggers one.
    await validationService.validateTenant(tenantId, { actor: 'shootD5b' });
    console.log('seeded tenant', tenantId.slice(0, 8));

    const express = require('express');
    const app = express();
    app.use('/portal', require('../../src/portal/routes'));
    app.use(express.static(path.join(__dirname, '../../public')));
    server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const port = server.address().port;
    const cookie = await loginCookie(port, 'owner@sri.test', 'demo-portal-pass');

    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-d5b-'));
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

    // ── THE HARD OUTCOME ────────────────────────────────────────────────────
    console.log('\nMEASUREMENT — zero horizontal scroll, all 12 pages, 320 and 380');
    const m = await measure(cdp, { base, cookie, port, label: process.env.MEASURE_LABEL || 'D5b' });
    const band = await measureBand(cdp, { base, cookie, port });
    if (MEASURE_ONLY) {
      console.log(m.bad === 0 ? '\nzero overflow everywhere' : `\n${m.bad} page(s) overflow`);
      return;
    }
    if (!BEFORE && m.bad !== 0) throw new Error(`${m.bad} page(s) still scroll horizontally`);
    if (!BEFORE && band !== 0) throw new Error(`${band} overflow(s) in the 640–767 band`);

    if (BEFORE) {
      console.log('\nBEFORE mode — assertions skipped; shooting the registers only.');
    } else {
    console.log('\nASSERTIONS');

    // ── B · tabular figures compute everywhere a number is rendered ─────────
    const TAB = "(function(s){var e=document.querySelector(s);return e?getComputedStyle(e).fontVariantNumeric:'MISSING';})";
    console.log('  B — font-variant-numeric on every numeric render site:');
    await probe(cdp, { url: base + '/pricing.html', cookie, port, waitFor: "document.querySelector('.tr__price')",
      collapsed: true, checks: [
        ['fee input', `${TAB}('#consultation_fee')`, 'tabular-nums'],
        ['treatment price', `${TAB}('.tr__price')`, 'tabular-nums'],
        ['treatment duration', `${TAB}('.tr__dur')`, 'tabular-nums'],
        ['archived counter', `${TAB}('#archivedCount')`, 'tabular-nums'],
        ['save note (Saved · v{N})', `${TAB}('#saveNote')`, 'tabular-nums'],
      ] });
    await probe(cdp, { url: base + '/hours.html', cookie, port, waitFor: "document.querySelector('.day__time')",
      collapsed: true, checks: [
        ['weekday time input', `${TAB}('.day__time')`, 'tabular-nums'],
        ['holiday date input', `${TAB}('.holiday__date')`, 'tabular-nums'],
      ] });
    await probe(cdp, { url: base + '/doctors.html', cookie, port, waitFor: "document.querySelector('.hours-pair__input')",
      collapsed: true, checks: [
        ['doctor hours input', `${TAB}('.hours-pair__input')`, 'tabular-nums'],
      ] });
    await probe(cdp, { url: base + '/booking-rules.html', cookie, port, waitFor: "document.querySelector('.unit__input')",
      collapsed: true, checks: [
        ['advance days / buffer', `${TAB}('.unit__input')`, 'tabular-nums'],
      ] });
    await probe(cdp, { url: base + '/clinic-profile.html', cookie, port, waitFor: "document.querySelector('.phone-row .input')",
      collapsed: true, checks: [
        ['phone number', `${TAB}('.phone-row .input')`, 'tabular-nums'],
      ] });
    await probe(cdp, { url: base + '/safety.html', cookie, port, waitFor: "document.querySelector('.phone-row .input')",
      collapsed: true, checks: [
        ['escalation number', `${TAB}('.phone-row .input')`, 'tabular-nums'],
      ] });
    await probe(cdp, { url: base + '/faqs.html', cookie, port, waitFor: "document.getElementById('faqCount')",
      collapsed: true, checks: [
        ['FAQ counter', `${TAB}('#faqCount')`, 'tabular-nums'],
      ] });
    await probe(cdp, { url: base + '/test.html', cookie, port, waitFor: "document.getElementById('remainingBadge')",
      collapsed: true, checks: [
        ['test-message counter', `${TAB}('#remainingBadge')`, 'tabular-nums'],
      ] });
    await probe(cdp, { url: base + '/index.html', cookie, port, waitFor: "document.querySelector('.ring__num, .ring-sk')",
      collapsed: true, settle: 1600, checks: [
        ['readiness numerator', `${TAB}('.ring__num')`, 'tabular-nums'],
        ['readiness denominator', `${TAB}('.ring__den')`, 'tabular-nums'],
        ['last-checked date', `${TAB}('.readiness__ran')`, 'tabular-nums'],
      ] });
    await probe(cdp, { url: base + '/history.html', cookie, port, waitFor: "document.querySelector('.hist-row')",
      collapsed: true, checks: [
        ['history version', `${TAB}('.hist-row__version')`, 'tabular-nums'],
        ['history date', `${TAB}('.hist-row__meta')`, 'tabular-nums'],
      ] });
    await probe(cdp, { url: base + '/knows.html', cookie, port, waitFor: "document.querySelector('.kv__v')",
      collapsed: true, checks: [
        ['knows value column', `${TAB}('.kv__v')`, 'tabular-nums'],
      ] });

    // ── A · table style: horizontal rules only, no zebra, no vertical rules ──
    //
    // There is no `.tb` component and none was built: the portal has no <table>
    // at all, every register is div rows, and each page owns its own row class.
    // Inventing a shared `.tb` would have shipped exactly the dead code the
    // `.tnum` ruling objects to. So section A is asserted against the registers
    // that actually exist, per row class, on the property that matters — a row
    // is drawn by a rule beneath it and by nothing else.
    const RULES = `(function(sel){
      var rows=document.querySelectorAll(sel);
      if(rows.length<2) return 'TOO FEW ROWS: '+rows.length;
      var bg=null, vertical=0, horizontal=0, zebra=false;
      for(var i=0;i<rows.length;i++){
        var c=getComputedStyle(rows[i]);
        if(c.borderLeftWidth!=='0px'||c.borderRightWidth!=='0px') vertical++;
        if(c.borderTopWidth!=='0px'||c.borderBottomWidth!=='0px') horizontal++;
        if(bg===null) bg=c.backgroundColor; else if(c.backgroundColor!==bg) zebra=true;
      }
      return {vertical:vertical, ruled:horizontal>0, zebra:zebra};
    })`;
    console.log('  A — every register: horizontal rules only, no zebra, no cell borders:');
    await probe(cdp, { url: base + '/hours.html', cookie, port, waitFor: "document.querySelector('.holiday-row')",
      collapsed: true, checks: [
        ['weekly hours rows', `${RULES}('.day')`, { vertical: 0, ruled: true, zebra: false }],
        ['holiday rows', `${RULES}('.holiday-row')`, { vertical: 0, ruled: true, zebra: false }],
      ] });
    await probe(cdp, { url: base + '/history.html', cookie, port, waitFor: "document.querySelector('.hist-row')",
      collapsed: true, checks: [
        ['change-log rows', `${RULES}('.hist-row')`, { vertical: 0, ruled: true, zebra: false }],
      ] });
    // Hover is asserted on its OWN target: a hovered row legitimately differs
    // from its neighbours, which is indistinguishable from zebra striping to the
    // check above. Measuring both on one page made the row rule assertion fail
    // for the right reason at the wrong time.
    await probe(cdp, { url: base + '/history.html', cookie, port, waitFor: "document.querySelector('.hist-row')",
      collapsed: true,
      // Real :hover, driven by a real mouse move — Chrome applies the pseudo-class
      // to a synthetic mouseMoved, so this reads the painted value rather than
      // re-stating the stylesheet back to itself.
      afterReady: async (c, sid) => {
        const box = await c.send('Runtime.evaluate', {
          expression: `(function(){var r=document.querySelectorAll('.hist-row')[1].getBoundingClientRect();
            return [Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)].join(',');})()`,
          returnByValue: true,
        }, sid);
        const [x, y] = box.result.value.split(',').map(Number);
        await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, sid);
        await sleep(300);
      },
      checks: [
        ['hovered row fills with --bg; its neighbours do not (so it is not zebra)',
          `(function(){var r=document.querySelectorAll('.hist-row');
            var p=document.createElement('div');p.style.background='var(--bg)';
            document.body.appendChild(p);var bg=getComputedStyle(p).backgroundColor;p.remove();
            return [getComputedStyle(r[1]).backgroundColor===bg,
                    getComputedStyle(r[0]).backgroundColor===getComputedStyle(r[2]).backgroundColor];})()`,
          [true, true]],
      ] });
    await probe(cdp, { url: base + '/index.html', cookie, port, waitFor: "document.querySelector('.check')",
      collapsed: true, settle: 1600, checks: [
        ['readiness check rows', `${RULES}('.check')`, { vertical: 0, ruled: true, zebra: false }],
      ] });
    await probe(cdp, { url: base + '/knows.html', cookie, port, waitFor: "document.querySelector('.kv')",
      collapsed: true, checks: [
        ['label/value rows', `${RULES}('.kv')`, { vertical: 0, ruled: true, zebra: false }],
        ['plain-list rows', `${RULES}('.plain-list li')`, { vertical: 0, ruled: true, zebra: false }],
      ] });
    await probe(cdp, { url: base + '/pricing.html', cookie, port, waitFor: "document.querySelector('.tr')",
      collapsed: true, checks: [
        ['fees are right-aligned (spec §2.9: numbers right)',
          `[getComputedStyle(document.getElementById('consultation_fee')).textAlign,
            getComputedStyle(document.querySelector('.tr__price')).textAlign]`, ['right', 'right']],
        ['no treatment row is zebra-striped',
          `(function(){var r=document.querySelectorAll('.tr:not(.tr--archived)');
            if(r.length<2)return 'TOO FEW';
            return getComputedStyle(r[0]).backgroundColor===getComputedStyle(r[1]).backgroundColor;})()`, true],
      ] });

    // ── restored elements (rulings 4) ───────────────────────────────────────
    console.log('  restored — the two elements mobile used to delete:');
    await probe(cdp, { url: base + '/hours.html', cookie, port, width: 380, height: 820, mobile: true,
      waitFor: "document.querySelector('.holiday-row--past')", collapsed: true, checks: [
        // `display` reads `block`, not `inline-block`: the badge is a grid item
        // at this width and grid blockifies its children. Visibility is what the
        // ruling is about, so visibility is what is asserted — a painted box,
        // inside the viewport, with its text intact.
        ['hours.css:152 — the Past badge is visible at 380',
          `(function(){var b=document.querySelector('.holiday-row--past .holiday__past');
            var r=b.getBoundingClientRect();
            return [getComputedStyle(b).display!=='none', r.width>0 && r.height>0,
                    r.right<=document.documentElement.clientWidth, b.textContent.trim()];})()`,
          [true, true, true, 'past']],
      ] });
    await probe(cdp, { url: base + '/index.html', cookie, port, width: 380, height: 820, mobile: true,
      waitFor: "document.querySelector('.check')", collapsed: true, settle: 1800, checks: [
        ['home.css:182 — the fix link is visible at 380',
          `(function(){var a=document.querySelector('a.check__link');
            if(!a)return 'NO FAILING OWNER CHECK';
            var r=a.getBoundingClientRect();
            return [getComputedStyle(a).display!=='none', r.width>0, r.height>0];})()`,
          [true, true, true]],
        // Scrolled into view FIRST: the checks sit below the fold on a 380×820
        // viewport, and elementFromPoint returns null for a point outside it —
        // which reads as "nothing is there" when the truth is "not on screen".
        ['and it is reachable by touch: >= 44 high, and the tap lands on the link',
          `(function(){var a=document.querySelector('a.check__link');
            if(!a)return 'NO FAILING OWNER CHECK';
            a.scrollIntoView({block:'center'});
            var r=a.getBoundingClientRect();
            var hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
            return [Math.round(r.height)>=44, !!(hit===a||a.contains(hit)),
                    hit?hit.tagName.toLowerCase():null];})()`,
          [true, true, 'a']],
        ['it has an href to act on, not just a label',
          "(function(){var a=document.querySelector('a.check__link');return a?!!a.getAttribute('href'):'NO FAILING OWNER CHECK';})()",
          true],
      ] });

    // ── D · the sticky save bar, driven by the EXISTING dirty mechanism ──────
    console.log('  D — the mobile sticky save bar:');
    await probe(cdp, { url: base + '/pricing.html', cookie, port, width: 380, height: 820, mobile: true,
      waitFor: FORM_READY, collapsed: true, checks: [
        ['clean: no bar',
          "(function(){var b=document.getElementById('stickySave');return !!(b&&!b.hidden);})()", false],
        // Awaits a tick. The bar is driven by a MutationObserver, whose callback
        // is a microtask \u2014 it runs before paint, so the owner never sees a stale
        // frame, but it has not run yet at the end of the synchronous block that
        // dispatched the event.
        ['dirty via the page\u2019s OWN input event: bar appears',
          `new Promise(function(res){
            var i=document.getElementById('consultation_fee');
            i.value='777';i.dispatchEvent(new Event('input',{bubbles:true}));
            setTimeout(function(){
              var b=document.getElementById('stickySave');
              res([!!b, b?!b.hidden:null, document.getElementById('saveNote').className,
                   document.body.classList.contains('has-save-bar')]);},0);})`,
          [true, true, 'save-note save-note--dirty', true]],
        ['content is not hidden behind it: body padding >= the bar height',
          `(function(){var b=document.getElementById('stickySave');
            var h=Math.round(b.getBoundingClientRect().height);
            var pad=parseFloat(getComputedStyle(document.querySelector('.content')).paddingBottom);
            return [h>0, pad>=h];})()`, [true, true]],
        // Two fixed surfaces share the bottom edge on the eight editing pages.
        // The bar has to be the one the thumb can reach.
        ['the Verbatim sheet yields the bottom edge to the bar',
          `(function(){var b=document.getElementById('stickySave').getBoundingClientRect();
            var v=document.getElementById('verbatim');
            var vr=v.getBoundingClientRect();
            return [Math.round(b.bottom)===Math.round(window.innerHeight),
                    Math.round(vr.bottom)<=Math.round(b.top),
                    getComputedStyle(v).bottom];})()`, [true, true, '69px']],
        ['the bar\u2019s Save is the card\u2019s Save — one save path, not two',
          `(function(){var b=document.getElementById('stickySaveBtn');
            var hit=false;var real=document.getElementById('saveBtn');
            var orig=real.click.bind(real);real.click=function(){hit=true;};
            b.click();real.click=orig;return hit;})()`, true],
        ['safe-area inset is respected',
          `(function(){var b=document.getElementById('stickySave');
            return /env\\(safe-area-inset-bottom/.test(
              Array.from(document.styleSheets).map(function(s){
                try{return Array.from(s.cssRules).map(function(r){return r.cssText;}).join('');}
                catch(e){return '';}}).join(''));})()`, true],
        ['reverting to the saved value hides it again, and gives the padding back',
          `new Promise(function(res){var i=document.getElementById('consultation_fee');
            i.value='500';i.dispatchEvent(new Event('input',{bubbles:true}));
            setTimeout(function(){res([document.getElementById('stickySave').hidden,
              document.body.classList.contains('has-save-bar')]);},0);})`, [true, false]],
      ] });
    await probe(cdp, { url: base + '/pricing.html', cookie, port, width: 1440, height: 900,
      waitFor: FORM_READY, collapsed: true, checks: [
        ['desktop: dirty, and the bar stays out of the way',
          `(function(){var i=document.getElementById('consultation_fee');
            i.value='777';i.dispatchEvent(new Event('input',{bubbles:true}));
            var b=document.getElementById('stickySave');
            return [!!b, getComputedStyle(b).display];})()`, [true, 'none']],
      ] });

    // ── save path unchanged: dirty -> save -> the SERVER's value refilled ────
    console.log('  save path — the server\u2019s returned value is refilled, unchanged:');
    for (const [page, field, typed, expect] of [
      ['pricing.html', 'consultation_fee', ' 0777 ', '777'],
      ['clinic-profile.html', 'landmark', 'Beside the Metro pillar 1042', 'Beside the Metro pillar 1042'],
    ]) {
      await probe(cdp, { url: base + '/' + page, cookie, port, width: 380, height: 820, mobile: true,
        waitFor: FORM_READY, collapsed: true, checks: [
          [`${page}: sticky Save -> server value in the form`,
            `(function(){
              var i=document.getElementById('${field}');
              i.value=${JSON.stringify(typed)};i.dispatchEvent(new Event('input',{bubbles:true}));
              document.getElementById('stickySaveBtn').click();
              return new Promise(function(res){
                var n=0;var t=setInterval(function(){
                  n++;
                  var note=document.getElementById('saveNote');
                  if(/^Saved/.test(note.textContent)){clearInterval(t);
                    res([document.getElementById('${field}').value,
                         document.getElementById('stickySave').hidden,
                         /^Saved · v\\d+/.test(note.textContent)]);}
                  else if(n>60){clearInterval(t);res(['TIMEOUT',note.textContent,null]);}
                },200);});})()`,
            [expect, true, true]],
        ] });
    }

    // ── F · touch targets ───────────────────────────────────────────────────
    //
    // ALL TWELVE PAGES, not the two the session asked for. The two required
    // pages would have found `.pay-toggle` and `.day__toggle` and missed
    // `.golive .btn` on the ten others — and the fixes are portal-wide rules, so
    // measuring two pages and shipping a shared change proves the wrong thing.
    console.log('  F — touch targets at 380, all 12 pages (44×44 spec, 24×24 floor):');
    for (const [, page] of PAGES) {
      await probe(cdp, { url: base + '/' + page, cookie, port, width: 380, height: 820, mobile: true,
        waitFor: "document.querySelector('.content')", collapsed: true, settle: 1600, checks: [
          [`${page.replace('.html', '').padEnd(15)} every interactive box is >= 44×44`,
            `(function(){var t=${TARGETS_EXPR};
              return t.filter(function(e){return e.w<44||e.h<44;})
                      .map(function(e){return e.s+' '+e.w+'×'+e.h;});})()`, []],
        ] });
    }

    // ── copy rules that must still hold ─────────────────────────────────────
    console.log('  copy — the retired framings stay retired:');
    await probe(cdp, { url: base + '/pricing.html', cookie, port, waitFor: ready, collapsed: true, checks: [
      ['no AI Employee / AI Operating System / Submit in the rendered page',
        "/AI Employee|AI Operating System|>\\\\s*Submit\\\\s*</.test(document.body.innerHTML)", false],
    ] });

    // ── E · the sticky page header on mobile ────────────────────────────────
    console.log('  E — sticky page header at 380: title stays, description goes:');
    await probe(cdp, { url: base + '/pricing.html', cookie, port, width: 380, height: 820, mobile: true,
      waitFor: ready, collapsed: true, checks: [
        ['before scroll: description visible',
          "document.querySelector('.page-head__sub').offsetHeight>0", true],
        ['after scroll: header pinned, title visible, description gone',
          `(function(){window.scrollTo(0,600);
            return new Promise(function(res){setTimeout(function(){
              var h=document.querySelector('.page-head');
              var r=h.getBoundingClientRect();
              res([h.classList.contains('is-stuck'),
                   Math.round(r.top),
                   document.querySelector('.page-head__title').offsetHeight>0,
                   document.querySelector('.page-head__sub').offsetHeight>0]);},400);});})()`,
          [true, 56, true, false]],
      ] });

    }

    // ── SCREENSHOTS ─────────────────────────────────────────────────────────
    // Every register, before and after, at both widths. Each page waits for its
    // OWN rows, not for `.card` — `.card` is also what the loading skeleton is
    // wrapped in, so waiting on it photographed the skeleton on the two pages
    // whose fetch is slowest. Both shots came out exactly viewport-height, which
    // is what gave it away.
    console.log('\nTABLES — 1440 and 380');
    for (const [name, file, rows] of [
      ['pricing',  'pricing.html',  '.tr'],
      ['hours',    'hours.html',    '.holiday-row'],
      ['doctors',  'doctors.html',  '.doc'],
      ['faqs',     'faqs.html',     '.faq'],
      ['history',  'history.html',  '.hist-row'],
      ['knows',    'knows.html',    '.kv'],
      ['home',     'index.html',    '.check'],
    ]) {
      const waitFor = `document.querySelector('${rows}')`;
      await shoot(cdp, { url: base + '/' + file, out: px(`d5b-${name}-1440${SUFFIX}.png`),
        width: 1440, height: 1000, cookie, port, waitFor, awaitReady: true, collapsed: true, settle: 1600 });
      await shoot(cdp, { url: base + '/' + file, out: px(`d5b-${name}-380${SUFFIX}.png`),
        width: 380, height: 820, mobile: true, cookie, port, waitFor, awaitReady: true, collapsed: true, settle: 1600 });
    }

    // After-only: there is no "before" sticky save bar, and the 320/zoom passes
    // assert rather than photograph.
    if (BEFORE) { console.log('\nBEFORE mode — registers shot; done.'); return; }

    console.log('\nSTICKY SAVE BAR — dirty on Pricing at 380');
    await shoot(cdp, { url: base + '/pricing.html', out: px('d5b-sticky-save-380.png'),
      width: 380, height: 820, mobile: true, cookie, port,
      waitFor: FORM_READY, collapsed: true,
      clipToViewport: true, settle: 900,
      afterReady: async (c, sid) => {
        // The bar is `position: fixed`, so it is at the bottom of the VIEWPORT
        // whatever the scroll offset. Scrolling to the treatments card is about
        // showing it beside real content, not about bringing the bar into view.
        // '888', not '777'. The save-path probe above POSTS 777 and the server
        // stores it, so by the time this shot runs the saved consultation fee IS
        // 777 — retyping it is a no-op, the card is legitimately clean and the
        // bar correctly does not appear. That produced a "sticky save bar"
        // screenshot with no bar in it, twice, and the bar was innocent both
        // times. The dirty state has to be dirty relative to what is STORED.
        const r = await c.send('Runtime.evaluate', {
          expression: `(function(){
            var i=document.getElementById('consultation_fee');
            i.value='888';i.dispatchEvent(new Event('input',{bubbles:true}));
            return new Promise(function(res){setTimeout(function(){
              document.querySelector('#treatmentsCard').scrollIntoView({block:'start'});
              setTimeout(function(){
                var b=document.getElementById('stickySave');
                var br=b.getBoundingClientRect();
                res([Math.round(window.scrollY), b.hidden,
                     Math.round(br.top), Math.round(br.height),
                     Math.round(window.innerHeight)]);},300);},50);});})()`,
          returnByValue: true, awaitPromise: true,
        }, sid);
        const [sy, hidden, top, h, vh] = r.result.value;
        console.log(`    scrollY=${sy} · bar visible=${!hidden} · top=${top} h=${h} · viewport=${vh}`);
        // Fail loudly. A screenshot that silently contains no evidence is worse
        // than no screenshot, because it gets filed as if it were evidence.
        if (hidden || h < 44 || top + h !== vh) {
          throw new Error(`sticky save bar not pinned to the viewport bottom at shot time `
            + `(hidden=${hidden} top=${top} h=${h} viewport=${vh})`);
        }
        await sleep(400);
      } });

    console.log('\n320 — the narrowest supported viewport');
    for (const [name, file, rows] of [
      ['pricing', 'pricing.html', '.tr'], ['hours', 'hours.html', '.holiday-row'],
      ['home', 'index.html', '.check'],
    ]) {
      await shoot(cdp, { url: base + '/' + file, out: px(`d5b-${name}-320.png`),
        width: 320, height: 820, mobile: true, cookie, port,
        waitFor: `document.querySelector('${rows}')`, awaitReady: true, collapsed: true, settle: 1600 });
    }

    // ── 200% zoom ───────────────────────────────────────────────────────────
    //
    // Browser zoom HALVES the CSS viewport; it is not deviceScaleFactor, which
    // only changes how many device pixels a CSS pixel is drawn with and is
    // invisible to layout. So 200% zoom is emulated as a CSS viewport of half
    // the device width, which is what the page actually has to lay out into.
    //
    //   1280 device → 640 CSS px. The desktop case, and the one that must pass.
    //    380 device → 190 CSS px. BELOW the 320px floor this portal supports;
    //                 measured and reported, never asserted, because claiming a
    //                 pass or a fail at a width outside the stated support
    //                 window would be claiming something the session did not
    //                 promise either way.
    console.log('\n200% ZOOM — Pricing and Hours (zoom halves the CSS viewport)');
    for (const [name, file, rows] of [['pricing', 'pricing.html', '.tr'], ['hours', 'hours.html', '.holiday-row']]) {
      for (const [device, css, required] of [[1280, 640, true], [380, 190, false]]) {
        const { targetId, sessionId } = await newPage(cdp, {
          url: base + '/' + file, cookie, port, width: css, height: Math.round(820 / 2), mobile: device < 900,
          collapsed: true, waitFor: `document.querySelector('${rows}')`,
        });
        await cdp.send('Runtime.evaluate', {
          expression: 'window.Portal.readinessOnce().then(function(){return true;}).catch(function(){return false;})',
          returnByValue: true, awaitPromise: true,
        }, sessionId);
        await sleep(1200);
        const r = await cdp.send('Runtime.evaluate', { expression: OVERFLOW_EXPR, returnByValue: true }, sessionId);
        const [sw, cw, over, worst] = r.result.value;
        const mark = over === 0 ? '✓' : (required ? '✗' : '·');
        console.log(`    ${mark} ${name} @200% on a ${device}px device = ${css} CSS px: `
          + `${sw}/${cw} over=${over}${worst ? ' — ' + worst : ''}${required ? '' : '   (below the 320 floor — reported, not asserted)'}`);
        if (required) {
          const shotRes = await cdp.send('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: cw, height: 1400, scale: 1 },
          }, sessionId);
          fs.writeFileSync(px(`d5b-${name}-zoom200.png`), Buffer.from(shotRes.data, 'base64'));
        }
        await cdp.send('Target.closeTarget', { targetId });
        if (required && over !== 0) throw new Error(`${name} overflows at 200% zoom (${css} CSS px)`);
      }
    }

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
