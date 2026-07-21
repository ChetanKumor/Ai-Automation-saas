'use strict';

/* ============================================================================
 * PORTAL-P1 screenshot evidence — dev tooling, not shipped runtime.
 *
 * S2 shots against a REAL, freshly-validated tenant:
 *   login (desktop + 380px)  ·  home/readiness (desktop + 380px)
 * S3 additions:
 *   • home shot doubles as the disabled Go-live + "N items need your attention"
 *     evidence (the seeded tenant has failing checks → blockers > 0);
 *   • an ADMIN "create owner account" shot driven through the real admin panel:
 *     type an email → click Create → the one-time temp password panel appears.
 *
 * It stands up a THROWAWAY scratch DB (genesis) so it never touches neondb,
 * seeds a tenant + owner + a real tenant_config, then runs the REAL
 * validationService.validateTenant — only the two network-bound checks
 * (kb.retrieval embedding, whatsapp.live Meta ping) are stubbed via opts.deps,
 * and turn.scripted is skipped (it would spend a live model turn). Everything the
 * ring shows is a genuine validation verdict.
 *
 * Rendering: the real /portal router + express.static('public'), driven over the
 * Chrome DevTools Protocol (Node global WebSocket — no new dependency). Mobile
 * uses Emulation.setDeviceMetricsOverride (a TRUE 380px layout viewport — the
 * correct fix for the DEMO-01 "headless --window-size ignores mobile" lesson),
 * and Chrome runs with reduced-motion so the ring/pulse settle deterministically.
 *
 * Usage:  node scripts/portal/shoot.js
 * Output: scripts/portal/shots/*.png
 * ========================================================================== */

require('dotenv').config();
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
const DEVPORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }

// ── Minimal CDP client over the browser WebSocket ────────────────────────────
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

async function shoot(cdp, { url, out, width, height, mobile, cookie, port, waitFor, afterReady }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  // Opt-in diagnostics (SHOOT_DEBUG=1) — console/exception/XHR visibility for
  // debugging a new shot's afterReady interaction. Found live: a click landing
  // on a not-yet-wired button produces NONE of these (no exception, no request)
  // — the tell that a waitFor condition resolved before the page's own async
  // init did, rather than a genuine app error.
  if (process.env.SHOOT_DEBUG) {
    await cdp.send('Runtime.enable', {}, sessionId);
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.consoleAPICalled') {
        console.log('  [console]', out, m.params.type, (m.params.args || []).map((a) => a.value ?? a.description).join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        console.log('  [exception]', out, JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails));
      }
      if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/')) {
        console.log('  [response]', out, m.params.response.status, m.params.response.url);
      }
    });
  }
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: !!mobile }, sessionId);
  if (cookie) {
    await cdp.send('Network.setCookie',
      { name: cookie.name, value: cookie.value, url: `http://127.0.0.1:${port}/` }, sessionId);
  }

  const loaded = new Promise((res) => {
    cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  await waitForSelector(cdp, sessionId, waitFor);
  // Optional interaction (e.g. fill a form + click) driven over CDP before capture.
  if (afterReady) await afterReady(cdp, sessionId);
  await sleep(1300); // ring fill (.9s) + fonts settle

  const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
  const size = metrics.cssContentSize || { width, height };
  const shotRes = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size.width, height: Math.ceil(size.height), scale: 1 },
  }, sessionId);
  fs.writeFileSync(out, Buffer.from(shotRes.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  console.log('  ✓', path.basename(out), `(${Math.round(size.width)}×${Math.round(size.height)})`);
}

// ── HTTP login → session cookie ──────────────────────────────────────────────
// Generic over both auth surfaces: `path` + the cookie name we expect back.
function loginCookieVia(port, path, cookieName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method: 'POST', path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const set = res.headers['set-cookie'] || [];
      const c = set.find((s) => s.startsWith(cookieName + '='));
      if (!c) return reject(new Error(`no ${cookieName} cookie (login ${res.statusCode})`));
      const kv = c.split(';')[0];
      const eq = kv.indexOf('=');
      resolve({ name: kv.slice(0, eq), value: kv.slice(eq + 1) });
    });
    r.on('error', reject);
    r.write(payload); r.end();
  });
}
const loginCookie = (port, email, password) =>
  loginCookieVia(port, '/portal/api/login', 'portal.sid', { email, password });
const adminLoginCookie = (port, password) =>
  loginCookieVia(port, '/admin/login', 'connect.sid', { password });

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const scratchName = 'zyon_shot_' + crypto.randomBytes(5).toString('hex');
  const scratchCs = swapDb(ADMIN, scratchName);

  const c0 = new Client({ connectionString: ADMIN, ssl: SSL });
  await c0.connect();
  await c0.query('CREATE DATABASE ' + scratchName);
  await c0.end();
  console.log('scratch DB:', scratchName);

  let server, chrome, ws, db;
  try {
    const runner = require('../../src/db/migrate');
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Bind everything to the scratch DB before first require of db/services.
    process.env.DATABASE_URL = scratchCs;
    process.env.LOG_LEVEL = 'silent';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shoot-admin-pass';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');
    const { hashPassword } = require('../../src/portal/auth');
    const configService = require('../../src/modules/config/configService');
    const validationService = require('../../src/modules/validation/validationService');
    const aiService = require('../../src/modules/ai/aiService');
    const knowledgeService = require('../../src/modules/knowledge/knowledgeService');

    // Seed: a clinic + owner. Config is clinicDefaults + a real escalation number
    // (numbers.e164 passes) but no FAQs yet (kb checks fail → an owner action item
    // with a page link) and no WhatsApp creds (operator "handled by Prantivo").
    const email = 'owner@sunrisedental.test';
    const password = 'demo-portal-pass';
    const t = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id",
      ['Sunrise Dental']);
    const tenantId = t.rows[0].id;
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [tenantId, email, hashPassword(password), 'owner']);

    await configService.writeTenantConfig(tenantId, {
      business: {
        display_name: 'Sunrise Dental',
        address: '2nd Floor, Pearl Plaza, Ameerpet, Hyderabad 500016',
        landmark: 'above HDFC Bank, opposite Ameerpet Metro',
        website: 'https://sunrisedental.in',
        phone_numbers: ['+919876543210', '+914023456789'],
      },
      languages: { supported: ['te', 'hi', 'en'], default: 'te' },
      notifications: { owner_numbers: ['+919000000001'] },
      // Safety & handoff (S10): the callback offer on, two staff numbers, and the
      // clinic's own emergency guidance + a give-out number — so the page shows a
      // filled state and the emergency block actually renders into the prompt.
      escalation: {
        enabled: true,
        phone_numbers: ['+919000000002', '+919000000003'],
        emergency_guidance: 'Come straight to the clinic — we keep an emergency slot free every hour, and someone is on the desk until 8pm.',
        emergency_number: '+919000000009',
      },
      // Hours: a short Wednesday + a closed Saturday (varied grid), plus one past
      // and one upcoming holiday so the S5 shot shows both the closed-day render
      // and the past-date de-emphasis.
      hours: {
        wed: { open: '09:00', close: '13:00' },
        sat: { closed: true },
        holidays: [
          { date: '2026-08-15', name: 'Independence Day' },
          { date: '2026-01-26', name: 'Republic Day' },
        ],
      },
      // Pricing (S6): real fees + a treatment list that exercises every row
      // variant — a "starts at" price, a duration, a note, and one ARCHIVED row
      // so the "Show archived (1)" toggle appears and the archived styling shows.
      pricing: {
        consultation_fee: 500,
        follow_up_fee: 300,
        emergency_fee: 1200,
        payment_methods: ['upi', 'cash', 'card'],
        insurance: { stance: 'selected_insurers', note: 'Star Health, HDFC Ergo, Niva Bupa' },
        treatments: [
          { name: 'Root canal', price: 4000, price_from: true, duration_minutes: 45 },
          { name: 'Teeth cleaning', price: 1500, duration_minutes: 30, notes: 'includes polishing' },
          { name: 'Tooth extraction', price: 2500, duration_minutes: 20 },
          { name: 'Dental crown', price: 6000, price_from: true },
          { name: 'Teeth whitening', price: 3500, archived: true },
        ],
      },
      // Booking rules (S9): non-default values on every enforced knob, so the
      // page's plain-English summary reads as a real sentence rather than the
      // defaults, plus two of the three policy texts (the third stays empty to
      // show the optional state).
      booking: {
        slot_minutes: 20,
        advance_days: 30,
        buffer_minutes: 120,
        allow_same_day: true,
        cancellation_policy: 'Please call at least 4 hours before your appointment. There is no cancellation charge.',
        walk_in_policy: 'Walk-ins are welcome before 11am; you may have to wait up to 30 minutes.',
      },
      // Receptionist (S13): a name, a real Telugu greeting (this tenant's default
      // language — proves the Noto Telugu render), a Professional tone, Concise
      // length, and a distinct voice/pace so the saved state is unmistakably real.
      personality: {
        display_name: 'Asha',
        style: 'formal',
        response_length: 'concise',
      },
      greeting: {
        te: 'నమస్తే! సన్‌రైజ్ డెంటల్‌కు స్వాగతం. నేను ఆశా, మీకు ఎలా సహాయపడగలను?',
        hi: 'नमस्ते! सनराइज़ डेंटल में आपका स्वागत है।',
        en: 'Hello! This is Sunrise Dental, how can I help you today?',
      },
      voice: { sarvam_speaker: 'ritu', pace: 1.05 },
    }, 'shoot');

    // Doctors (S8): NOT a config section — these are tenant_entities rows, the
    // storage appointmentService books against. Seeded to exercise every card
    // state at once: a doctor whose Wednesday runs past the clinic's 13:00 close
    // (quiet warning), a clean doctor, one with no working days ("Not bookable"),
    // and one archived (the "No longer seeing patients" card).
    const seedDoctor = (data, type = 'schedule') => db.query(
      'INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1,$2,$3)',
      [tenantId, type, JSON.stringify(data)]);
    await seedDoctor({ doctor: 'Dr. Sharma', specialization: 'Endodontist', languages: ['te', 'en'],
      days: ['Mon', 'Wed', 'Fri'], start: '10:00', end: '17:00' });
    await seedDoctor({ doctor: 'Dr. Reddy', specialization: 'Orthodontist', languages: ['te', 'hi', 'en'],
      days: ['Tue', 'Thu'], start: '09:00', end: '13:00' });
    await seedDoctor({ doctor: 'Dr. Naidu', specialization: 'Oral surgeon', languages: ['te'],
      days: [], start: '10:00', end: '16:00' });
    await seedDoctor({ doctor: 'Dr. Kulkarni', specialization: 'Periodontist', languages: ['hi', 'en'],
      days: ['Mon', 'Thu'], start: '11:00', end: '15:00' }, 'schedule_archived');

    // FAQs (S11): 3 real Q/A pairs — enough to show a genuine loaded list, but
    // deliberately UNDER the 5-chunk kb.populated threshold so the readiness
    // narrative below (kb checks still an owner action item) stays true.
    const faqService = require('../../src/modules/knowledge/faqService');
    await faqService.createFaq(tenantId,
      { question: 'Do you accept insurance?', answer: 'Yes — we accept Star Health, HDFC Ergo, and Niva Bupa.' },
      { languages: ['te', 'hi', 'en'] });
    await faqService.createFaq(tenantId,
      { question: 'Where can I park?', answer: 'Free parking is available in the Pearl Plaza basement.' },
      { languages: ['te', 'hi', 'en'] });
    await faqService.createFaq(tenantId,
      { question: 'Do you see children?', answer: 'Yes, Dr. Reddy sees patients of all ages, including children.', language: 'en' },
      { languages: ['te', 'hi', 'en'] });

    const run = await validationService.validateTenant(tenantId, {
      skip: ['turn.scripted'],
      deps: { getRelevantChunks: async () => [], pingNumber: async () => 'stub' },
    });
    const passed = run.checks.filter((c) => c.severity !== 'fail').length;
    console.log(`validation run: ${passed}/${run.checks.length} checks not-failed, skipped ${run.skipped.length}`);

    // A SECOND clinic with NO owner yet — the subject of the admin create-owner shot.
    const meadow = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id",
      ['Meadow Physiotherapy']);
    const meadowId = meadow.rows[0].id;
    await configService.writeTenantConfig(meadowId, {
      business: { display_name: 'Meadow Physiotherapy' },
    }, 'shoot');

    // A THIRD clinic with an owner but zero FAQs — the empty-state shot (S11).
    // Kept separate from Sunrise Dental (which now has 3 real FAQs) rather than
    // clearing Sunrise's, so the "loaded list" and "empty state" shots are both
    // real, simultaneously-true states.
    const freshEmail = 'owner@freshclinic.test';
    const freshPassword = 'demo-portal-pass-2';
    const fresh = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id",
      ['Fresh Clinic']);
    const freshId = fresh.rows[0].id;
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [freshId, freshEmail, hashPassword(freshPassword), 'owner']);

    // S14: "Test your receptionist" runs a REAL turn through the real renderer +
    // real brain — stub the model + RAG here (in-process, same seam the test
    // suite uses) so that shot costs zero live Gemini calls, embedding included.
    knowledgeService.getRelevantChunks = async () => [];
    aiService._setModelProvider(() => ({
      startChat: () => ({
        sendMessage: async () => ({
          response: {
            functionCalls: () => undefined,
            text: () => 'The consultation fee is five hundred rupees.',
            usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, totalTokenCount: 50 },
            candidates: [{ finishReason: 'STOP' }],
          },
        }),
      }),
    }));

    // Real /portal + /admin routers + static serving (mirrors server.js for these
    // paths). Admin needs its session middleware mounted before the router.
    const express = require('express');
    const session = require('express-session');
    const app = express();
    app.use('/portal', require('../../src/portal/routes'));
    app.use(session({
      secret: 'shoot-secret-abcdefghijklmnopqrstuvwx',
      resave: false, saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 12 * 3600 * 1000 },
    }));
    app.use('/admin', require('../../src/admin/adminRoutes'));
    app.use(express.static(path.join(__dirname, '../../public')));
    server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const port = server.address().port;
    console.log('server on', port);

    const cookie = await loginCookie(port, email, password);
    const freshCookie = await loginCookie(port, freshEmail, freshPassword);
    const adminCookie = await adminLoginCookie(port, process.env.ADMIN_PASSWORD);

    // Launch Chrome (reduced motion → deterministic ring/pulse).
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-shot-'));
    chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${DEVPORT}`, `--user-data-dir=${udd}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      '--force-prefers-reduced-motion=reduce', 'about:blank',
    ], { stdio: 'ignore' });

    ws = await openWs(await connectBrowser());
    const cdp = new CDP(ws);

    const base = `http://127.0.0.1:${port}/portal`;
    console.log('capturing:');
    await shoot(cdp, { url: `${base}/login.html`, out: path.join(OUT, 'login-desktop.png'),
      width: 1280, height: 860, port, waitFor: "document.getElementById('form')" });
    await shoot(cdp, { url: `${base}/login.html`, out: path.join(OUT, 'login-mobile.png'),
      width: 380, height: 820, mobile: true, port, waitFor: "document.getElementById('form')" });
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 'home-desktop.png'),
      width: 1280, height: 900, cookie, port,
      waitFor: "document.querySelector('.ring')||document.querySelector('.empty')" });
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 'home-mobile.png'),
      width: 380, height: 820, mobile: true, cookie, port,
      waitFor: "document.querySelector('.ring')||document.querySelector('.empty')" });

    // S4: clinic profile — the first config-write page. Desktop + 380px show the
    // loaded form (the seeded tenant carries real identity values); the third shot
    // captures the field-level validation state (empty name + a malformed phone →
    // Save → inline errors that name the fix).
    await shoot(cdp, { url: `${base}/clinic-profile.html`, out: path.join(OUT, 's4-profile-desktop.png'),
      width: 1280, height: 1000, cookie, port,
      waitFor: "document.getElementById('profileCard') && !document.getElementById('profileCard').hidden" });
    await shoot(cdp, { url: `${base}/clinic-profile.html`, out: path.join(OUT, 's4-profile-mobile.png'),
      width: 380, height: 900, mobile: true, cookie, port,
      waitFor: "document.getElementById('profileCard') && !document.getElementById('profileCard').hidden" });
    await shoot(cdp, {
      url: `${base}/clinic-profile.html`, out: path.join(OUT, 's4-profile-error.png'),
      width: 1280, height: 1000, cookie, port,
      waitFor: "document.getElementById('profileCard') && !document.getElementById('profileCard').hidden",
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.getElementById('display_name').value='';"
            + "var ph=document.querySelector('.phone-row .input');"
            + "if(!ph){document.getElementById('addPhone').click();ph=document.querySelector('.phone-row .input');}"
            + "ph.value='not a phone';"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.field.is-invalid')");
      },
    });

    // S5: hours & holidays — the second config-write page. Desktop + 380px show the
    // loaded 7-day grid (Wednesday short, Saturday closed) + the holiday rows (one
    // past, de-emphasised). The third shot captures the validation state (Wednesday
    // close-before-open → Save → an inline per-row error that names the fix).
    const hoursReady = "document.getElementById('hoursForm') && !document.getElementById('hoursForm').hidden";
    await shoot(cdp, { url: `${base}/hours.html`, out: path.join(OUT, 's5-hours-desktop.png'),
      width: 1280, height: 1100, cookie, port, waitFor: hoursReady });
    await shoot(cdp, { url: `${base}/hours.html`, out: path.join(OUT, 's5-hours-mobile.png'),
      width: 380, height: 1000, mobile: true, cookie, port, waitFor: hoursReady });
    await shoot(cdp, {
      url: `${base}/hours.html`, out: path.join(OUT, 's5-hours-error.png'),
      width: 1280, height: 1100, cookie, port, waitFor: hoursReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){var w=document.querySelector('.day[data-day=\"wed\"]');"
            + "w.querySelector('[data-role=\"open\"]').value='18:00';"
            + "w.querySelector('[data-role=\"close\"]').value='09:00';"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.day.is-invalid')");
      },
    });

    // S6: pricing — the third config-write page. Desktop + 380px show the loaded
    // fees, the treatment rows (a "starts at" price, durations, a note) and the
    // payment/insurance card; the archived row sits behind "Show archived (1)".
    // The third shot captures two validation states at once: a non-integer fee and
    // a duplicate ACTIVE treatment name → Save → inline errors that name the fix.
    const pricingReady = "document.getElementById('pricingForm') && !document.getElementById('pricingForm').hidden";
    await shoot(cdp, { url: `${base}/pricing.html`, out: path.join(OUT, 's6-pricing-desktop.png'),
      width: 1280, height: 1200, cookie, port, waitFor: pricingReady });
    await shoot(cdp, { url: `${base}/pricing.html`, out: path.join(OUT, 's6-pricing-mobile.png'),
      width: 380, height: 1000, mobile: true, cookie, port, waitFor: pricingReady });
    await shoot(cdp, {
      url: `${base}/pricing.html`, out: path.join(OUT, 's6-pricing-error.png'),
      width: 1280, height: 1200, cookie, port, waitFor: pricingReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.getElementById('consultation_fee').value='12.5';"
            + "var rows=document.querySelectorAll('.tr');"
            + "rows[1].querySelector('.tr__name').value=rows[0].querySelector('.tr__name').value;"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.tr.is-invalid')");
      },
    });

    // S8: doctors — the first page that is NOT a config section (these rows drive
    // real bookings). Desktop + 380px show the loaded cards: a doctor carrying the
    // outside-clinic-hours warning, a clean one, one flagged "Not bookable", and
    // the archived card beneath. The third shot captures the validation state —
    // renaming a doctor to one that already exists → Save → the inline duplicate
    // error that names the fix.
    const doctorsReady = "document.querySelector('.doc') || !document.getElementById('emptyCard').hidden";
    await shoot(cdp, { url: `${base}/doctors.html`, out: path.join(OUT, 's8-doctors-desktop.png'),
      width: 1280, height: 1200, cookie, port, waitFor: doctorsReady });
    await shoot(cdp, { url: `${base}/doctors.html`, out: path.join(OUT, 's8-doctors-mobile.png'),
      width: 380, height: 1000, mobile: true, cookie, port, waitFor: doctorsReady });
    await shoot(cdp, {
      url: `${base}/doctors.html`, out: path.join(OUT, 's8-doctors-error.png'),
      width: 1280, height: 1200, cookie, port, waitFor: doctorsReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){var d=document.querySelectorAll('.doc');"
            + "var first=d[0].querySelector('.input').value;"
            + "d[1].querySelector('.input').value=first;"
            + "d[1].querySelector('[data-role=\"save\"]').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.doc .field.is-invalid')");
      },
    });

    // S9: booking rules — the first page whose every control changes enforced
    // behaviour (F-006). Desktop + 380px show the plain-English summary derived
    // from the saved rules, the four enforced settings, and the policy texts under
    // the heading that says they are recited, not enforced. The third shot is the
    // validation state that matters most: advance_days = 0, which looks like
    // "stop taking bookings" and is actually undefined — the error names the real
    // way to do that.
    const bookingReady = "document.getElementById('bookingForm') && !document.getElementById('bookingForm').hidden";
    await shoot(cdp, { url: `${base}/booking-rules.html`, out: path.join(OUT, 's9-booking-desktop.png'),
      width: 1280, height: 1200, cookie, port, waitFor: bookingReady });
    await shoot(cdp, { url: `${base}/booking-rules.html`, out: path.join(OUT, 's9-booking-mobile.png'),
      width: 380, height: 1100, mobile: true, cookie, port, waitFor: bookingReady });
    await shoot(cdp, {
      url: `${base}/booking-rules.html`, out: path.join(OUT, 's9-booking-error.png'),
      width: 1280, height: 1200, cookie, port, waitFor: bookingReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.getElementById('advance_days').value='0';"
            + "document.getElementById('buffer_minutes').value='500';"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.field.is-invalid')");
      },
    });

    // S10: safety & handoff — the escalation/emergency form plus the read-only
    // protections panel. Desktop + 380px show the whole page; the third shot is
    // the panel alone (scrolled to it), which is the deliverable that has to be
    // legible on its own; the fourth is the validation state that matters most
    // here — a number typed without its country code, which normalizePhone would
    // otherwise turn into a real number in another country.
    const safetyReady = "document.getElementById('safetyForm') && !document.getElementById('safetyForm').hidden"
      + " && document.getElementById('protCard') && !document.getElementById('protCard').hidden";
    await shoot(cdp, { url: `${base}/safety.html`, out: path.join(OUT, 's10-safety-desktop.png'),
      width: 1280, height: 1500, cookie, port, waitFor: safetyReady });
    await shoot(cdp, { url: `${base}/safety.html`, out: path.join(OUT, 's10-safety-mobile.png'),
      width: 380, height: 1400, mobile: true, cookie, port, waitFor: safetyReady });
    await shoot(cdp, {
      url: `${base}/safety.html`, out: path.join(OUT, 's10-safety-protections.png'),
      width: 1280, height: 1000, cookie, port, waitFor: safetyReady,
      // Full-page capture ignores scrolling, so the panel is isolated by hiding
      // the form above it — the shot is evidence about the panel, not the page.
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.getElementById('safetyForm').hidden=true;",
        }, sid);
        await sleep(200);
      },
    });
    await shoot(cdp, {
      url: `${base}/safety.html`, out: path.join(OUT, 's10-safety-error.png'),
      width: 1280, height: 1100, cookie, port, waitFor: safetyReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.querySelector('.phone-row .input').value='9876543210';"
            + "document.getElementById('emergency_number').value='98765-BAD';"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.field.is-invalid')");
      },
    });

    // S11: FAQs — the first page writing knowledge_chunks. Desktop + 380px show
    // Sunrise Dental's 3 real FAQs (loaded, not-yet-enough-for-readiness state);
    // the third shot is Fresh Clinic's genuine empty state (the example-question
    // instruction, spec §4); the fourth adds a blank card and saves it empty →
    // the inline "question is required" / "answer is required" errors.
    const faqsReady = "document.querySelector('.faq') || !document.getElementById('emptyCard').hidden";
    await shoot(cdp, { url: `${base}/faqs.html`, out: path.join(OUT, 's11-faqs-desktop.png'),
      width: 1280, height: 1100, cookie, port, waitFor: faqsReady });
    await shoot(cdp, { url: `${base}/faqs.html`, out: path.join(OUT, 's11-faqs-mobile.png'),
      width: 380, height: 1200, mobile: true, cookie, port, waitFor: faqsReady });
    await shoot(cdp, { url: `${base}/faqs.html`, out: path.join(OUT, 's11-faqs-empty.png'),
      width: 1280, height: 900, cookie: freshCookie, port, waitFor: faqsReady });
    await shoot(cdp, {
      url: `${base}/faqs.html`, out: path.join(OUT, 's11-faqs-error.png'),
      width: 1280, height: 1200, cookie, port, waitFor: faqsReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.getElementById('addFaq').click();"
            + "var cards=document.querySelectorAll('.faq');"
            + "cards[cards.length-1].querySelector('[data-role=\"save\"]').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.faq .field.is-invalid')");
      },
    });

    // S13: receptionist — persona + voice. Desktop + 380px show the loaded page:
    // the "Asha" self-intro name, the Professional/Concise segmented controls,
    // the three greeting fields (Telugu is Sunrise Dental's DEFAULT language —
    // this is the Telugu-rendering proof, in the self-hosted Noto Sans Telugu
    // font, marked "Default"), and the Voice card's amber known-gap notice. The
    // third shot isolates the greeting card alone (same isolation technique as
    // S10's protections-panel shot) so the Telugu render is unambiguous evidence
    // on its own. The fourth is the validation state that matters most on this
    // page: clearing the DEFAULT language's greeting → Save → the inline
    // "it's your default language" error.
    const receptionistReady = "document.getElementById('receptionistForm') && !document.getElementById('receptionistForm').hidden";
    await shoot(cdp, { url: `${base}/receptionist.html`, out: path.join(OUT, 's13-receptionist-desktop.png'),
      width: 1280, height: 1400, cookie, port, waitFor: receptionistReady });
    await shoot(cdp, { url: `${base}/receptionist.html`, out: path.join(OUT, 's13-receptionist-mobile.png'),
      width: 380, height: 1500, mobile: true, cookie, port, waitFor: receptionistReady });
    await shoot(cdp, {
      url: `${base}/receptionist.html`, out: path.join(OUT, 's13-receptionist-telugu-greeting.png'),
      width: 1280, height: 500, cookie, port, waitFor: receptionistReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.getElementById('personaCard').hidden=true;"
            + "document.getElementById('voiceCard').hidden=true;",
        }, sid);
        await sleep(200);
      },
    });
    await shoot(cdp, {
      url: `${base}/receptionist.html`, out: path.join(OUT, 's13-receptionist-error.png'),
      width: 1280, height: 1400, cookie, port, waitFor: receptionistReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.getElementById('greet-te').value='';"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.field.is-invalid')");
      },
    });

    // S14: test your receptionist — one real turn through the real renderer +
    // real brain (model stubbed above so this costs zero live Gemini calls).
    // Desktop + 380px show the empty state (starter questions); the third shot
    // clicks a starter and waits for the receptionist bubble + its provenance
    // line; the fourth is the daily-limit state, shot against Fresh Clinic after
    // pre-seeding 20 turn_traces rows so the very first click already hits it.
    // Waits for test.js's main() to finish (async, gated on window.Portal.me) —
    // NOT just the static #chatForm element existing, which is present from
    // first paint and would race the click-handler wiring (found live: the
    // reply/limited shots' afterReady click landed on a still-unwired button).
    const testReady = "document.body.dataset.testReady === '1'";
    await shoot(cdp, { url: `${base}/test.html`, out: path.join(OUT, 's14-test-desktop.png'),
      width: 1280, height: 900, cookie, port, waitFor: testReady });
    await shoot(cdp, { url: `${base}/test.html`, out: path.join(OUT, 's14-test-mobile.png'),
      width: 380, height: 820, mobile: true, cookie, port, waitFor: testReady });
    await shoot(cdp, {
      url: `${base}/test.html`, out: path.join(OUT, 's14-test-reply.png'),
      width: 1280, height: 900, cookie, port, waitFor: testReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.querySelector('.starter[data-q=\"What is the consultation fee?\"]').click();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.msg__prov')");
      },
    });
    for (let i = 0; i < 20; i++) {
      await db.query(`INSERT INTO turn_traces (tenant_id, channel) VALUES ($1, 'test')`, [freshId]);
    }
    await shoot(cdp, {
      url: `${base}/test.html`, out: path.join(OUT, 's14-test-limited.png'),
      width: 1280, height: 900, cookie: freshCookie, port, waitFor: testReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.querySelector('.starter[data-q=\"What are your timings?\"]').click();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.msg--system')");
      },
    });

    // S3: admin "create owner account" — fill the email, click Create, wait for the
    // one-time password panel, then capture. Uses the admin connect.sid cookie.
    await shoot(cdp, {
      url: `http://127.0.0.1:${port}/admin/tenant-detail.html?id=${meadowId}`,
      out: path.join(OUT, 's3-admin-create-owner.png'),
      width: 1280, height: 900, cookie: adminCookie, port,
      waitFor: "document.getElementById('ownerCreateBtn') && document.getElementById('detail').style.display==='block'",
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.getElementById('ownerEmail').value='owner@meadowphysio.example';"
            + "document.getElementById('ownerCreateBtn').click();",
        }, sid);
        await waitForSelector(c, sid,
          "document.getElementById('ownerResult') && getComputedStyle(document.getElementById('ownerResult')).display!=='none'");
      },
    });

    console.log('done →', OUT);
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { if (chrome) chrome.kill(); } catch (_) {}
    try { if (server) server.close(); } catch (_) {}
    try { if (db) await db.close(); } catch (_) {}
    const c1 = new Client({ connectionString: ADMIN, ssl: SSL });
    await c1.connect();
    try {
      await c1.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c1.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c1.end(); }
    console.log('cleaned up scratch DB');
  }
})().catch((e) => { console.error('shoot failed:', e); process.exit(1); });
