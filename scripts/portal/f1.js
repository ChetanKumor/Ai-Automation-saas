'use strict';

/* ============================================================================
 * F1 EVIDENCE HARNESS — "readiness does not reflect FAQ count". Dev tooling.
 *
 * Replays the reported journey on a FRESH tenant, through the real routers, over
 * HTTP, and photographs Home on both sides of the fix:
 *
 *   operator creates clinic + owner  →  owner completes the wizard
 *   →  owner adds 4 FAQs  →  owner presses Go live  →  REFUSED (run persisted)
 *   →  owner reads "Add at least 5 FAQs"  →  adds 2 more  (now SIX)
 *   →  owner returns to Home            ← BEFORE shot: the run has expired
 *   →  owner presses "Check again"      ← the F1 control, clicked for real
 *   →                                     AFTER shot: 8/8, Go live available
 *
 * The root cause, established in Phase 0 and pinned by the shots: this was never
 * a counting bug. `checkKbPopulated` counted correctly at every point. The run
 * simply predated the FAQ writes, and the portal reported that expired run as
 * CURRENT because staleness was computed from `tenant_configs.updated_at` alone
 * while FAQs live in `knowledge_chunks`.
 *
 * Chrome drives the real UI over CDP (same machinery as shoot.js): the re-check
 * is a genuine click on the rendered button, not a fetch this script makes.
 *
 * Usage:  node scripts/portal/f1.js
 * Output: scripts/portal/shots/f1-*.png
 * ========================================================================== */

require('dotenv').config();

// Offline Gemini SDK — same stub acceptance.js uses, installed before anything
// requires the SDK. kb.retrieval genuinely embeds; the run spends no quota.
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
const DEVPORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }

// ── HTTP ─────────────────────────────────────────────────────────────────────
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

// ── CDP (verbatim shape from shoot.js) ───────────────────────────────────────
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
async function waitFor(cdp, sid, expr, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: `!!(${expr})`, returnByValue: true }, sid);
    if (r.result && r.result.value) return;
    await sleep(150);
  }
  throw new Error('never appeared: ' + expr);
}
const evaluate = async (cdp, sid, expression) =>
  (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid)).result.value;

async function openHome(cdp, { port, cookie, width = 1180, height = 900, mobile = false }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile }, sessionId);
  const [name, value] = cookie.split('=');
  await cdp.send('Network.setCookie', { name, value, url: `http://127.0.0.1:${port}/` }, sessionId);
  const loaded = new Promise((res) => {
    cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
  });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/portal/index.html` }, sessionId);
  await loaded;
  await waitFor(cdp, sessionId, "document.querySelector('.ring')||document.querySelector('.emp')");
  await sleep(1400); // ring fill (.9s) + fonts
  return { targetId, sessionId };
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

// The shell's CHECK_META material set, transcribed so the score printed here is
// the score home.js renders (public/portal/shell.js).
const MATERIAL = new Set(['config.exists', 'config.schema', 'prompt.renders', 'hours.sane',
  'numbers.e164', 'consent.lines', 'kb.populated', 'kb.retrieval', 'doctor.schedule',
  'whatsapp.config', 'whatsapp.live', 'voice.config', 'turn.scripted']);
const OWNER_ACTIONED = new Set(['hours.sane', 'numbers.e164', 'kb.populated', 'kb.retrieval', 'doctor.schedule']);
function score(run) {
  if (!run || !run.checks) return 'no run';
  let passed = 0, total = 0;
  for (const c of run.checks) {
    if (!MATERIAL.has(c.name)) continue;
    total += 1;
    if (c.severity !== 'fail') passed += 1;
  }
  return `${passed}/${total}`;
}
function deriveGoLive(run) { // public/portal/shell.js deriveGoLive
  if (!run || !run.checks) return { eligible: true, unknown: true, blockers: 0 };
  let blockers = 0;
  for (const c of run.checks) {
    if (MATERIAL.has(c.name) && OWNER_ACTIONED.has(c.name) && c.severity === 'fail') blockers += 1;
  }
  if (run.stale) return { eligible: true, stale: true, blockers };
  if (run.passed) return { eligible: true, blockers: 0 };
  return { eligible: false, blockers };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const scratchName = 'zyon_f1_' + crypto.randomBytes(5).toString('hex');
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
    if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = 'f1-admin-pass';
    await require('../../src/db/migrate').genesis({ connectionString: scratchCs, logger: SILENT });

    db = require('../../src/db/db');
    const configService = require('../../src/modules/config/configService');
    const validationService = require('../../src/modules/validation/validationService');

    const express = require('express');
    const session = require('express-session');
    const app = express();
    app.use('/portal', require('../../src/portal/routes'));
    app.use(express.json());
    app.use(session({ secret: 'f1', resave: false, saveUninitialized: false }));
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
      headers: { [CSRF]: '1' }, body: { business_name: 'F1 Dental' },
    });
    const tenantId = created.body.id || (created.body.tenant && created.body.tenant.id);
    must(tenantId, 'tenant create failed: ' + JSON.stringify(created.body));

    const ownerEmail = 'owner@f1-dental.test';
    const ownerRes = await call(port, {
      method: 'POST', path: `/admin/api/tenants/${tenantId}/owner`, cookie: adminCookie,
      headers: { [CSRF]: '1' }, body: { email: ownerEmail },
    });
    const tempPassword = ownerRes.body.password;
    must(tempPassword, 'owner create failed: ' + JSON.stringify(ownerRes.body));

    const login = await call(port, { method: 'POST', path: '/portal/api/login', body: { email: ownerEmail, password: tempPassword } });
    const cookie = cookieOf(login.setCookie, 'portal.sid');
    must(cookie, 'owner sign-in failed');

    const post = async (p, body, expect = 200) => {
      const r = await call(port, { method: 'POST', path: p, cookie, body });
      must(r.status === expect, `${p} → ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    };

    // ── owner completes the wizard ───────────────────────────────────────────
    await post('/portal/api/config/identity', {
      display_name: 'F1 Dental', address: 'Plot 44, Jubilee Hills, Hyderabad',
      landmark: 'Opposite Peddamma Temple', phone_numbers: ['+919000000010'],
      languages: ['te', 'hi', 'en'],
    });
    await post('/portal/api/config/hours', {
      days: {
        mon: { open: '09:00', close: '18:00' }, tue: { open: '09:00', close: '18:00' },
        wed: { open: '09:00', close: '18:00' }, thu: { open: '09:00', close: '18:00' },
        fri: { open: '09:00', close: '18:00' }, sat: { open: '09:00', close: '14:00' },
        sun: { closed: true },
      },
      holidays: [], emergency_number: '+919000000011',
    });
    await post('/portal/api/config/pricing', {
      consultation_fee: 500, follow_up_fee: 300, emergency_fee: 1200,
      payment_methods: ['upi', 'cash'],
      insurance: { stance: 'selected_insurers', note: 'Star Health, HDFC Ergo' },
      treatments: [{ name: 'Root canal', price: 4000, price_from: true, duration_minutes: 45 }],
    });
    await post('/portal/api/config/receptionist', {
      display_name: 'Asha',
      greeting: { en: 'Hello! F1 Dental, how can I help?', hi: 'नमस्ते!', te: 'నమస్తే!' },
      tone: 'warm', response_length: 'standard', voice_speaker: 'shubh', pace: 1.0,
    });
    await post('/portal/api/config/safety', {
      enabled: true, phone_numbers: ['+919000000012'],
      emergency_guidance: 'Come straight to the clinic.', emergency_number: '+919000000013',
    });
    // Walk to the last wizard step so `completed` turns true — otherwise Home
    // redirects a never-started owner straight into the wizard (home.js main()).
    await post('/portal/api/onboarding', { step: 6 });

    // The operator half of onboarding, exactly as scripts/portal/acceptance.js
    // does it: channels off + booking off, so every remaining material check is
    // owner-side and kb.populated is the only thing that can block. The founder's
    // tenant additionally runs doctor.schedule and turn.scripted (which need a
    // live tool-calling model), which is why their ring reads 10 and this one 8.
    const live = await configService.getTenantConfig(tenantId);
    await configService.writeTenantConfig(tenantId,
      { ...live, whatsapp: { enabled: false }, voice: { enabled: false }, tools: { booking: false } }, 'cli');

    const FAQS = [
      ['Do you accept insurance?', 'Yes — Star Health and HDFC Ergo are accepted.'],
      ['Where can I park?', 'Free parking is available in the basement.'],
      ['Do you see children?', 'Yes, we see patients of all ages.'],
      ['Do you offer emergency appointments?', 'Yes, we keep one emergency slot free every hour.'],
      ['What should I bring to my first visit?', 'Bring a photo ID and any previous dental X-rays.'],
      ['What are your timings on Saturday?', 'We are open 9am to 2pm on Saturdays.'],
    ];

    // ── 1. four FAQs, then Go live ───────────────────────────────────────────
    for (const [question, answer] of FAQS.slice(0, 4)) await post('/portal/api/faqs', { question, answer });
    const refused = await call(port, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });
    hr('1. Go live with FOUR FAQs — refused, and a run is persisted');
    console.log('  HTTP', refused.status, refused.body && refused.body.code,
      '· blocking:', JSON.stringify((refused.body && refused.body.blocking) || []));
    must(refused.status === 409, 'expected a 409 refusal');

    // ── 2. the 5th and 6th FAQ ───────────────────────────────────────────────
    hr('2. Owner reads the fix copy and adds FAQ #5 and #6');
    for (const [question, answer] of FAQS.slice(4)) {
      const r = await post('/portal/api/faqs', { question, answer });
      console.log(`  POST /portal/api/faqs → ${r.faqs.length} FAQs` +
        `; response.readiness ring = ${score(r.readiness.run)}, stale = ${r.readiness.run.stale}`);
    }

    const { rows: chunkRows } = await db.query(
      'SELECT count(*)::int AS n, max(created_at) AS last FROM knowledge_chunks WHERE tenant_id = $1', [tenantId]);
    const { rows: cfgRows } = await db.query(
      'SELECT updated_at FROM tenant_configs WHERE tenant_id = $1', [tenantId]);

    const before = (await call(port, { method: 'GET', path: '/portal/api/readiness', cookie })).body;
    hr('RAW GET /portal/api/readiness  (six FAQs on file, before the re-check)');
    console.log(JSON.stringify(before.body || before, null, 2));

    const run = before.run;
    hr('The three fields, and the comparison');
    console.log('  run.created_at                 :', new Date(run.created_at).toISOString());
    console.log('  run.stale                      :', run.stale);
    console.log('  kb.populated severity          :', run.checks.find((c) => c.name === 'kb.populated').severity);
    console.log('  knowledge_chunks count         :', chunkRows[0].n);
    console.log('  LAST FAQ WRITE                 :', new Date(chunkRows[0].last).toISOString());
    console.log('  tenant_configs.updated_at      :', new Date(cfgRows[0].updated_at).toISOString());
    console.log('  run predates the last FAQ write:', new Date(run.created_at) < new Date(chunkRows[0].last));
    console.log('  ring:', score(run), '· go-live:', JSON.stringify(deriveGoLive(run)));
    must(run.stale === true, 'the run predates the FAQ writes and must report itself stale');

    // ── 3. photograph Home, click Check again, photograph it again ───────────
    const udd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'f1-chrome-'));
    chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${DEVPORT}`, `--user-data-dir=${udd}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      '--force-prefers-reduced-motion=reduce', 'about:blank',
    ], { stdio: 'ignore' });
    ws = await openWs(await connectBrowser());
    const cdp = new CDP(ws);

    hr('3. BEFORE — Home with an expired run');
    const page = await openHome(cdp, { port, cookie });
    const beforeUi = await evaluate(cdp, page.sessionId, `(() => ({
      ring: (document.querySelector('.ring') || {}).ariaLabel,
      expired: !!document.querySelector('.readiness__expired'),
      expiredTitle: (document.querySelector('.readiness__expired-t') || {}).innerText,
      expiredBody: (document.querySelector('.readiness__expired-d') || {}).innerText,
      recheckBtn: (document.querySelector('[data-recheck]') || {}).innerText,
      lifecycle: (document.querySelector('#lifecycle') || {}).innerText,
      staleWrapper: !!document.querySelector('.golive--stale'),
      kbFix: [...document.querySelectorAll('.check__fix')].map(e => e.innerText).find(t => /FAQ/.test(t)),
    }))()`);
    console.log(JSON.stringify(beforeUi, null, 2));
    must(beforeUi.expired, 'Home must state that the run has expired');
    must(beforeUi.recheckBtn, 'Home must offer Check again');
    must(beforeUi.staleWrapper, 'the lifecycle control must be visibly the stale variant');
    await capture(cdp, page.sessionId, path.join(OUT, 'f1-before.png'));

    // D5b found a 10px horizontal scrollbar on eleven of twelve pages that had
    // been invisible for two sessions because no width measurement existed. This
    // session adds two new boxes to Home — the expired block and the two-object
    // lifecycle control — so it measures rather than assumes.
    hr('3b. Width sweep with the stale state rendered (D5b: measure, do not argue)');
    for (const w of [320, 380, 640, 700, 1180]) {
      const m = await openHome(cdp, { port, cookie, width: w, height: 800, mobile: w <= 640 });
      const over = await evaluate(cdp, m.sessionId, `(() => {
        const bar = document.querySelector('.top');
        const ctl = document.querySelector('.golive--stale');
        const pill = document.querySelector('.lc--stale');
        const b = document.querySelector('[data-recheck]');
        return {
          doc: document.documentElement.scrollWidth, win: window.innerWidth,
          expired: !!document.querySelector('.readiness__expired'),
          btn: b ? Math.round(b.getBoundingClientRect().height) : 0,
          barH: Math.round(bar.getBoundingClientRect().height),
          ctlH: Math.round(ctl.getBoundingClientRect().height),
          pill: pill ? pill.getBoundingClientRect().width > 0 : false,
          goLive: (document.querySelector('[data-lifecycle="activate"]') || {}).innerText,
        };
      })()`);
      must(over.doc <= over.win, `horizontal overflow at ${w}px: ${over.doc} > ${over.win}`);
      must(over.expired, `the expired block must survive at ${w}px, not be display:none`);
      // 44px is the TOUCH target (D5b), so it is asserted where a finger is.
      if (w <= 640) must(over.btn >= 44, `Check again is ${over.btn}px tall at ${w}px — below the 44px touch target`);
      // The control must fit INSIDE the 56px bar. `.pg-head` sticks to exactly
      // that offset, so a control taller than the bar breaks the page below it.
      must(over.ctlH <= over.barH, `the lifecycle control (${over.ctlH}px) overflows the ${over.barH}px top bar at ${w}px`);
      must(over.goLive === 'Check & go live', `the button must name the re-check at ${w}px, got "${over.goLive}"`);
      ok(`${w}px — no overflow (${over.doc}≤${over.win}), block present, button ${over.btn}px, ` +
         `control ${over.ctlH}≤${over.barH}px, pill ${over.pill ? 'shown' : 'hidden'}, "${over.goLive}"`);
      if (w === 380) await capture(cdp, m.sessionId, path.join(OUT, 'f1-before-mobile.png'));
      await cdp.send('Target.closeTarget', { targetId: m.targetId });
    }

    hr('4. The owner clicks "Check again" — a real click on the rendered button');
    await evaluate(cdp, page.sessionId, "document.querySelector('[data-recheck]').click()");
    await waitFor(cdp, page.sessionId, "!document.querySelector('.readiness__expired')");
    await sleep(1400);
    const afterUi = await evaluate(cdp, page.sessionId, `(() => ({
      ring: (document.querySelector('.ring') || {}).ariaLabel,
      headline: (document.querySelector('.readiness__headline') || {}).innerText,
      expired: !!document.querySelector('.readiness__expired'),
      ran: (document.querySelector('.readiness__ran') || {}).innerText,
      lifecycle: (document.querySelector('#lifecycle') || {}).innerText,
      goLiveBtn: !!document.querySelector('[data-lifecycle="activate"]'),
      staleWrapper: !!document.querySelector('.golive--stale'),
    }))()`);
    console.log(JSON.stringify(afterUi, null, 2));
    must(!afterUi.expired, 'the expired block is gone');
    must(afterUi.goLiveBtn && !afterUi.staleWrapper, 'Go live is available, and no longer the stale variant');
    await capture(cdp, page.sessionId, path.join(OUT, 'f1-after.png'));
    await cdp.send('Target.closeTarget', { targetId: page.targetId });

    // ── ASSERTIONS ───────────────────────────────────────────────────────────
    hr('ASSERTION 3 — stale flips true for every write path outside tenant_configs');
    const freshen = async () => {
      await validationService.validateTenant(tenantId);
      const r = (await call(port, { method: 'GET', path: '/portal/api/readiness', cookie })).body;
      must(r.run.stale === false, 'a run taken after every write must be fresh');
      return r;
    };
    await freshen();
    await post('/portal/api/config/identity', {
      display_name: 'F1 Dental Care', address: 'Plot 44, Jubilee Hills, Hyderabad',
      landmark: 'Opposite Peddamma Temple', phone_numbers: ['+919000000010'],
      languages: ['te', 'hi', 'en'],
    });
    let s = (await call(port, { method: 'GET', path: '/portal/api/readiness', cookie })).body;
    must(s.run.stale === true, 'a tenant_configs write must expire the run');
    ok('tenant_configs  (config/identity)  → stale = true');

    await freshen();
    await post('/portal/api/faqs', { question: 'Do you do teeth whitening?', answer: 'Yes, we offer in-clinic whitening.' });
    s = (await call(port, { method: 'GET', path: '/portal/api/readiness', cookie })).body;
    must(s.run.stale === true, 'a knowledge_chunks write must expire the run');
    ok('knowledge_chunks (FAQ create)      → stale = true   ← the F1 defect');

    await freshen();
    await post('/portal/api/doctors', {
      name: 'Dr. Anitha Rao', specialization: 'Endodontist',
      languages: ['te', 'en'], days: ['Mon', 'Tue', 'Wed'], start: '10:00', end: '17:00',
    });
    s = (await call(port, { method: 'GET', path: '/portal/api/readiness', cookie })).body;
    must(s.run.stale === true, 'a tenant_entities write must expire the run');
    ok('tenant_entities  (doctor create)   → stale = true');

    hr('ASSERTION 4 — the re-check route cannot activate');
    await freshen();
    const statusBefore = (await db.query('SELECT status, active FROM tenants WHERE id=$1', [tenantId])).rows[0];
    const checkRes = await call(port, { method: 'POST', path: '/portal/api/readiness/check', cookie, body: {} });
    const statusAfter = (await db.query('SELECT status, active FROM tenants WHERE id=$1', [tenantId])).rows[0];
    must(checkRes.status === 200 && checkRes.body.run.passed === true, 'the re-check passed');
    must(statusBefore.status === statusAfter.status && statusBefore.active === statusAfter.active,
      `status moved: ${JSON.stringify(statusBefore)} → ${JSON.stringify(statusAfter)}`);
    ok(`a PASSING re-check left status='${statusAfter.status}' active=${statusAfter.active}, unchanged`);

    hr('ASSERTION 5 — tenant isolation');
    const other = await call(port, {
      method: 'POST', path: '/admin/api/tenants', cookie: adminCookie,
      headers: { [CSRF]: '1' }, body: { business_name: 'Someone Else Dental' },
    });
    const otherId = other.body.id || (other.body.tenant && other.body.tenant.id);
    const crafted = await call(port, {
      method: 'POST',
      path: `/portal/api/readiness/check?tenantId=${otherId}&tenant_id=${otherId}`,
      cookie, body: { tenantId: otherId, tenant_id: otherId, id: otherId },
    });
    must(crafted.status === 200, 'the crafted request should succeed — against the SESSION tenant');
    const theirs = await db.query('SELECT count(*)::int n FROM validation_runs WHERE tenant_id = $1', [otherId]);
    must(theirs.rows[0].n === 0, 'a run landed on the other tenant');
    ok(`tenantId in body AND query → 0 runs on ${otherId.slice(0, 8)}…, all on the session tenant`);

    hr('ASSERTION 6 — checkKbPopulated boundary intact (untouched this session)');
    const { rows: ids } = await db.query(
      'SELECT id FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]);
    const kb = (r) => r.checks.find((c) => c.name === 'kb.populated');
    await db.query('DELETE FROM knowledge_chunks WHERE id = ANY($1::uuid[])',
      [ids.slice(0, ids.length - 5).map((r) => r.id)]);
    const at5 = await validationService.validateTenant(tenantId);
    console.log('  5 chunks →', kb(at5).severity, '—', kb(at5).detail);
    must(kb(at5).severity === 'pass', '5 must pass');
    await db.query('DELETE FROM knowledge_chunks WHERE id = $1', [ids[ids.length - 5].id]);
    const at4 = await validationService.validateTenant(tenantId);
    console.log('  4 chunks →', kb(at4).severity, '—', kb(at4).detail);
    must(kb(at4).severity === 'fail', '4 must fail');
    ok('5 passes, 4 fails — unchanged');

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
