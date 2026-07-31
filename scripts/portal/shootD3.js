'use strict';

/* ============================================================================
 * D3 screenshot evidence — dev tooling, not shipped runtime.
 *
 * The truth strip, the regrouped readiness checks, the restyled ring, and the
 * empty / loading / error sweep. Same machinery as scripts/portal/shoot.js
 * (throwaway scratch DB → genesis → real routers → CDP) with three differences
 * that matter:
 *
 *   1. A LEGACY-PROMPT tenant. `tenants.ai_prompt` is set at INSERT, which is
 *      how a legacy tenant actually came to exist — Issue 34 removed the admin
 *      form that could create one after the fact, and no service writes the
 *      column. This is the fixture that produces F-F001's closing evidence.
 *
 *   2. Lifecycle states are driven through lifecycleService.transition(), never
 *      a raw `UPDATE tenants SET status`. That statement has exactly one
 *      legitimate home (lifecycleService.writeStatus) and Issue 17's
 *      single-writer guard greps `scripts/` as well as `src/` — it is right to
 *      fire, so this script goes through the front door.
 *
 *   3. Chrome runs WITHOUT --force-prefers-reduced-motion. shoot.js forces it
 *      globally for determinism; D3 has to photograph both sides of that
 *      preference, so it is emulated per-shot via Emulation.setEmulatedMedia.
 *
 * Usage:  node scripts/portal/shootD3.js
 * Output: scripts/portal/shots/d3-*.png
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
const DEVPORT = 9334; // not shoot.js's 9333 — the two must be runnable back to back

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

/**
 * `reduced`  — emulate prefers-reduced-motion for this shot only.
 * `preload`  — script injected BEFORE the page's own scripts run (skeleton and
 *              failed-request shots patch window.fetch from here; doing it in
 *              afterReady would be far too late).
 * `settle`   — override the post-ready wait. The skeleton shots deliberately
 *              wait past the 300ms reveal without waiting for content that is
 *              never coming.
 */
async function shoot(cdp, { url, out, width, height, mobile, cookie, port, waitFor, afterReady, reduced, preload, settle }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
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
    });
  }
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: !!mobile }, sessionId);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }],
  }, sessionId);
  if (cookie) {
    await cdp.send('Network.setCookie',
      { name: cookie.name, value: cookie.value, url: `http://127.0.0.1:${port}/` }, sessionId);
  }
  if (preload) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preload }, sessionId);
  }

  const loaded = new Promise((res) => {
    cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  if (waitFor) await waitForSelector(cdp, sessionId, waitFor);
  if (afterReady) await afterReady(cdp, sessionId);
  await sleep(settle == null ? 1400 : settle); // ring draw (600ms) + fonts settle

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

/**
 * Assert a DOM fact in a freshly loaded page and report it. This is how
 * verification 3b ("exactly ONE notice, not two") is established: eyeballing a
 * screenshot cannot distinguish one amber block from two when the second is
 * below the fold, and the whole point of folding the strip and the per-page
 * notice into one component is that a duplicate must be impossible.
 */
async function probe(cdp, { url, cookie, port, waitFor, checks }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  if (cookie) {
    await cdp.send('Network.setCookie',
      { name: cookie.name, value: cookie.value, url: `http://127.0.0.1:${port}/` }, sessionId);
  }
  const loaded = new Promise((res) => {
    cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  if (waitFor) await waitForSelector(cdp, sessionId, waitFor);
  await sleep(400);
  let failed = 0;
  for (const [label, expr, expected] of checks) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
    const got = r.result && r.result.value;
    const ok = got === expected;
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

// Hold a GET open forever so the page stays in its loading state. Used for the
// skeleton shots — the skeleton is the page's real first paint, not a mock.
const HANG = (frag) => `(function(){var f=window.fetch;window.fetch=function(u,o){
  if(String(u).indexOf('${frag}')!==-1) return new Promise(function(){});
  return f.apply(this,arguments);};})();`;

// Fail a GET the way a 5xx does, so the page takes its real error branch.
const FAIL = (frag) => `(function(){var f=window.fetch;window.fetch=function(u,o){
  if(String(u).indexOf('${frag}')!==-1) return Promise.resolve(new Response('{"error":"boom"}',
    {status:500,headers:{'Content-Type':'application/json'}}));
  return f.apply(this,arguments);};})();`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const scratchName = 'zyon_d3_' + crypto.randomBytes(5).toString('hex');
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
    const validationService = require('../../src/modules/validation/validationService');
    const lifecycleService = require('../../src/modules/tenant/lifecycleService');
    const faqService = require('../../src/modules/knowledge/faqService');
    const knowledgeService = require('../../src/modules/knowledge/knowledgeService');
    const aiService = require('../../src/modules/ai/aiService');

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

    // A config that passes the FULL catalog with nothing skipped — the only
    // kind of "ready" the owner path can produce (INV-3: no skip power at all).
    // whatsapp/voice off removes the operator-credential checks; booking off
    // removes doctor.schedule and turn.scripted.
    const readyConfig = (name) => ({
      business: {
        display_name: name,
        address: 'Road No. 12, Banjara Hills, Hyderabad 500034',
        phone_numbers: ['+919876543210'],
      },
      languages: { supported: ['te', 'en'], default: 'en' },
      notifications: { owner_numbers: ['+919000000001'], on_booking: true, on_escalation: true },
      escalation: { enabled: true, phone_numbers: ['+919000000002'] },
      pricing: {
        consultation_fee: 500,
        follow_up_fee: 300,
        payment_methods: ['upi', 'cash', 'card'],
        treatments: [
          { name: 'Root canal', price: 4000, price_from: true, duration_minutes: 45 },
          { name: 'Teeth cleaning', price: 1500, duration_minutes: 30, notes: 'includes polishing' },
          { name: 'Tooth extraction', price: 2500, duration_minutes: 20 },
        ],
      },
      hours: { wed: { open: '09:00', close: '13:00' }, sat: { closed: true } },
      personality: { display_name: 'Asha', style: 'formal', response_length: 'concise' },
      greeting: { en: 'Hello! This is the front desk, how can I help you today?' },
      whatsapp: { enabled: false }, voice: { enabled: false }, tools: { booking: false },
    });

    const mkTenant = async (name, email, password, opts = {}) => {
      // ai_prompt at INSERT: a legacy clinic was PROVISIONED with a hand-written
      // script, never switched to one afterwards. No service writes this column
      // and (since Issue 34) no admin form does either, so INSERT is both the
      // honest fixture and the only remaining way to produce one.
      const t = await db.query(
        'INSERT INTO tenants (business_name, active, ai_prompt) VALUES ($1, false, $2) RETURNING id',
        [name, opts.aiPrompt || null]);
      const tenantId = t.rows[0].id;
      await db.query(
        'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
        [tenantId, email, hashPassword(password), 'owner']);
      if (opts.config) await configService.writeTenantConfig(tenantId, opts.config, 'shoot');
      await configService.writeTenantConfigMeta(tenantId, { onboarding_step: 6, onboarding_completed: true });
      if (opts.faqs) {
        for (let i = 0; i < opts.faqs; i += 1) {
          await faqService.createFaq(tenantId,
            { question: `${name} question ${i + 1}?`, answer: `Answer ${i + 1}: we are open 9am to 6pm on weekdays.` },
            { languages: ['te', 'en'] });
        }
      }
      return { id: tenantId, email, password };
    };

    const PW = 'demo-portal-pass';

    // 1. LEGACY — the F-F001 fixture. Fully configured, fully passing, LIVE, and
    //    carrying a hand-written script. Live on purpose: it isolates the legacy
    //    condition, so the strip in its shot cannot be mistaken for the not-live
    //    one. (`tenant.legacy_prompt` is a warn, never a fail — it does not and
    //    must not block go-live.)
    const legacy = await mkTenant('Sunrise Dental', 'owner@sunrise.test', PW, {
      config: readyConfig('Sunrise Dental'),
      faqs: 5,
      aiPrompt: 'You are the receptionist at Sunrise Dental. Always greet warmly, '
        + 'never quote a price, and take a callback number for anything clinical.',
    });

    // 2. CLEAN — identical, minus the script. Goes live for the no-condition
    //    shot, then is paused for the paused-condition shot. Order is
    //    load-bearing: the strip must be photographed absent BEFORE the pause.
    const clean = await mkTenant('Meadow Dental', 'owner@meadow.test', PW, {
      config: readyConfig('Meadow Dental'),
      faqs: 5,
    });

    // 3. DRAFT — mid-setup, and the fixture for the empty states. Deliberately
    //    thin: no treatments, no holidays, no doctors, no FAQs, no history.
    const draft = await mkTenant('Fresh Clinic', 'owner@fresh.test', PW, {
      config: { business: { display_name: 'Fresh Clinic' } },
    });

    // 4. NEVER VALIDATED — a clinic on its first day. Distinct from `draft` on
    //    purpose: /api/readiness reads the latest PERSISTED run and never
    //    triggers one, so a tenant that has never been checked has `run: null`
    //    and Home takes its empty branch. Once `draft` has a failing run behind
    //    it (it needs one, for the partial ring) it can no longer produce that
    //    state, and reusing it would have quietly photographed the wrong thing.
    //    It also carries NO config write, so `config_revisions` is genuinely
    //    empty and History takes its own empty branch. (writeTenantConfigMeta
    //    below records no revision by design, so marking onboarding complete
    //    does not put a phantom first entry in the timeline.)
    const virgin = await mkTenant('First Day Clinic', 'owner@firstday.test', PW, {});

    // Lifecycle THROUGH THE SERVICE — validate → activate, which is exactly the
    // pair the portal's own Go-live button runs (routes.js runGoLiveChain). No
    // `skip` is passed and no raw status write happens anywhere in this file:
    // `activate` re-reads the latest run and enforces the freshness invariant,
    // so these tenants pass the same gate a real owner's click does.
    //
    // No `deps` overrides either. The Gemini SDK is stubbed at the top of this
    // file, so `kb.retrieval` genuinely embeds its probe query and genuinely
    // retrieves the seeded FAQs. (An earlier draft passed
    // `getRelevantChunks: async () => []` as a "stub" — which does not stub the
    // check, it FAILS it: retrieving nothing is precisely what kb.retrieval
    // exists to catch.)
    const goLive = async (t) => {
      await lifecycleService.transition(t.id, 'validate');
      await lifecycleService.transition(t.id, 'activate');
    };
    await goLive(legacy);
    await goLive(clean);

    // The draft clinic validates too — it must have a REAL failing run behind
    // it, or Home would render the never-checked empty state instead of the
    // partial ring these shots are of.
    //
    // `validate` THROWS on a failing run (VALIDATION_FAILED:<check>) while
    // still persisting it and leaving status alone — the same thing the portal
    // sees when an owner presses Go live and is refused. The throw is the
    // expected outcome here, so it is caught rather than treated as an error.
    try {
      await lifecycleService.transition(draft.id, 'validate');
      console.log('  note: the draft fixture unexpectedly PASSED validation');
    } catch (err) {
      if (!String(err.code || '').startsWith('VALIDATION_FAILED')) throw err;
    }

    for (const t of [legacy, clean, draft]) {
      const run = await validationService.getLatestValidation(t.id);
      const checks = (run.result && run.result.checks) || [];
      const bad = checks.filter((c) => c.severity !== 'pass').map((c) => `${c.name}:${c.severity}`);
      const { rows } = await db.query('SELECT status FROM tenants WHERE id = $1', [t.id]);
      console.log(`  ${t.email.padEnd(22)} status=${rows[0].status.padEnd(9)} passed=${run.passed}`
        + (bad.length ? `  not-pass: ${bad.join(', ')}` : ''));
    }

    const express = require('express');
    const app = express();
    app.use('/portal', require('../../src/portal/routes'));
    app.use(express.static(path.join(__dirname, '../../public')));
    server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const port = server.address().port;
    console.log('server on', port);

    const legacyCk = await loginCookie(port, legacy.email, PW);
    const cleanCk = await loginCookie(port, clean.email, PW);
    const draftCk = await loginCookie(port, draft.email, PW);
    const virginCk = await loginCookie(port, virgin.email, PW);

    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-d3-'));
    chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${DEVPORT}`, `--user-data-dir=${udd}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      'about:blank',
    ], { stdio: 'ignore' });

    ws = await openWs(await connectBrowser());
    const cdp = new CDP(ws);
    const base = `http://127.0.0.1:${port}/portal`;

    const W = 1440, H = 900;         // desktop, per the D3 brief
    const MW = 380, MH = 820;        // mobile
    const strip = "document.querySelector('#truthStrip .ts')";
    const homeReady = "document.querySelector('#checks .check, #readinessCard .emp, #readinessCard .pg-err')";
    const px = (n) => path.join(OUT, n);

    // ── Invariants, asserted before anything is photographed ───────────────
    console.log('asserting:');
    console.log('  shadowed page, legacy clinic — ONE notice, not two (3b):');
    await probe(cdp, { url: `${base}/pricing.html`, cookie: legacyCk, port, waitFor: strip, checks: [
      ['truth strips on the page', "document.querySelectorAll('.ts').length", 1],
      ['legacy inline notices left behind', "document.querySelectorAll('.shadow-notice').length", 0],
      ['amber blocks total', "document.querySelectorAll('.ts--warn, .shadow-notice').length", 1],
      ['strip is between .top and .content',
        "(function(){var s=document.getElementById('truthStrip');return s.previousElementSibling.className==='top'"
        + " && s.nextElementSibling.className.indexOf('content')===0;})()", true],
      ['live region is polite', "document.getElementById('truthStrip').getAttribute('aria-live')", 'polite'],
    ] });
    console.log('  clean live clinic — strip ABSENT, not empty-and-collapsed:');
    await probe(cdp, { url: `${base}/pricing.html`, cookie: cleanCk, port,
      waitFor: "document.getElementById('pricingForm') && !document.getElementById('pricingForm').hidden", checks: [
        ['truth strips on the page', "document.querySelectorAll('.ts').length", 0],
        ['host exists (so it can announce later)', "!!document.getElementById('truthStrip')", true],
        ['host renders zero height', "document.getElementById('truthStrip').getBoundingClientRect().height", 0],
        ['host paints no border', "getComputedStyle(document.getElementById('truthStrip')).borderBottomWidth", '0px'],
      ] });
    console.log('  Home, legacy clinic — ring aria + score live region:');
    await probe(cdp, { url: `${base}/index.html`, cookie: legacyCk, port, waitFor: homeReady, checks: [
      ['ring role', "document.querySelector('.ring').getAttribute('role')", 'img'],
      // 8, not 9: the ring scores MATERIAL checks, and tenant.legacy_prompt is
      // advisory. Its absence from both the numerator and the denominator is
      // the same decision as its absence from the checklist.
      ['ring label', "document.querySelector('.ring').getAttribute('aria-label')", '8 of 8 checks complete'],
      ['score live regions', "document.querySelectorAll('[role=\"status\"].vh').length", 1],
      ['score live region text', "document.querySelector('[role=\"status\"].vh').textContent", '8 of 8 checks complete'],
      ['strip sits directly under the 56px top bar',
        "document.querySelector('#truthStrip .ts').getBoundingClientRect().top", 56],
      ['strip is 40px tall', "document.querySelector('#truthStrip .ts').getBoundingClientRect().height", 40],
      ['legacy check is NOT a checklist row',
        "Array.from(document.querySelectorAll('.check__label')).some(function(e){return /custom script|latest instruction|instructions$/i.test(e.textContent);})", false],
      ['group headers', "Array.from(document.querySelectorAll('.checks__group-label')).map(function(e){return e.textContent;}).join('|')",
        'Needed to go live|Handled by Prantivo'],
    ] });
    console.log('  Home, draft clinic — strip does not re-announce on a re-render:');
    await probe(cdp, { url: `${base}/index.html`, cookie: draftCk, port, waitFor: homeReady, checks: [
      ['strip present', "document.querySelectorAll('.ts').length", 1],
      ['re-dispatching the same readiness does not rewrite the region',
        "(function(){var h=document.getElementById('truthStrip');var before=h.innerHTML;"
        + "document.dispatchEvent(new CustomEvent('portal:readiness',{detail:{status:'draft',run:{checks:[],skipped:[]}}}));"
        + "return h.innerHTML===before && h.querySelectorAll('.ts').length===1;})()", true],
    ] });

    console.log('capturing:');

    // ── 1. THE EVIDENCE THAT CLOSES F-F001 ─────────────────────────────────
    // A real tenant carrying a real `tenants.ai_prompt`, on the page whose
    // settings that script overrides. Exactly ONE amber block: the strip. The
    // inline notice that used to sit below the header is gone — it is now what
    // the strip says, and its full text lives in the modal.
    await shoot(cdp, { url: `${base}/pricing.html`, out: px('d3-legacy-strip-pricing.png'),
      width: W, height: 1100, cookie: legacyCk, port, waitFor: strip });
    await shoot(cdp, { url: `${base}/pricing.html`, out: px('d3-legacy-strip-pricing-380.png'),
      width: MW, height: 1000, mobile: true, cookie: legacyCk, port, waitFor: strip });
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-legacy-strip-home.png'),
      width: W, height: H, cookie: legacyCk, port, waitFor: strip });
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-legacy-strip-home-380.png'),
      width: MW, height: MH, mobile: true, cookie: legacyCk, port, waitFor: strip });

    // The strip's modal: every section the script shadows, not just this page's.
    await shoot(cdp, { url: `${base}/pricing.html`, out: px('d3-legacy-affects-modal.png'),
      width: W, height: 1000, cookie: legacyCk, port, waitFor: strip,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: "document.querySelector('[data-ts-modal]').click();" }, sid);
        await waitForSelector(c, sid, "document.querySelector('.modal-host .modal')");
      },
    });

    // ── 2. NO CONDITION — the strip is ABSENT, not empty ───────────────────
    // Same page, same layout, live clinic with no script: #truthStrip exists as
    // an empty live region and renders nothing. Nothing collapses, nothing
    // reserves space, no border.
    await shoot(cdp, { url: `${base}/pricing.html`, out: px('d3-no-condition-pricing.png'),
      width: W, height: 1100, cookie: cleanCk, port,
      waitFor: "document.getElementById('pricingForm') && !document.getElementById('pricingForm').hidden" });
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-no-condition-home.png'),
      width: W, height: H, cookie: cleanCk, port, waitFor: homeReady });

    // ── 3. DRAFT ───────────────────────────────────────────────────────────
    // The condition that tests §2.9's own warning about wallpaper: it renders on
    // every page for the whole setup period. Shot at both widths so the call can
    // be made from evidence rather than argument.
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-draft-strip-home.png'),
      width: W, height: H, cookie: draftCk, port, waitFor: homeReady });
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-draft-strip-home-380.png'),
      width: MW, height: MH, mobile: true, cookie: draftCk, port, waitFor: homeReady });
    await shoot(cdp, { url: `${base}/hours.html`, out: px('d3-draft-strip-hours.png'),
      width: W, height: 1100, cookie: draftCk, port, waitFor: strip });
    await shoot(cdp, { url: `${base}/hours.html`, out: px('d3-draft-strip-hours-380.png'),
      width: MW, height: 1100, mobile: true, cookie: draftCk, port, waitFor: strip });

    // ── 4. PAUSED — after the clean shots above, never before ──────────────
    await lifecycleService.transition(clean.id, 'pause');
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-paused-strip-home.png'),
      width: W, height: H, cookie: cleanCk, port, waitFor: strip });
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-paused-strip-home-380.png'),
      width: MW, height: MH, mobile: true, cookie: cleanCk, port, waitFor: strip });
    await shoot(cdp, { url: `${base}/faqs.html`, out: px('d3-paused-strip-faqs.png'),
      width: W, height: 900, cookie: cleanCk, port, waitFor: strip });

    // ── 5. RING + GROUPED CHECKS ───────────────────────────────────────────
    // 132px/10px, tabular numeral, and the two headers over the existing rows.
    // The clean tenant is paused now, so this is also the ring beside a strip.
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-ring-groups-complete.png'),
      width: W, height: H, cookie: cleanCk, port, waitFor: homeReady });
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-ring-groups-partial.png'),
      width: W, height: 1000, cookie: draftCk, port, waitFor: homeReady });
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-ring-groups-partial-380.png'),
      width: MW, height: 1000, mobile: true, cookie: draftCk, port, waitFor: homeReady });

    // ── 6. REDUCED MOTION ──────────────────────────────────────────────────
    // The ring must stand at its final value (animateRing never starts) and the
    // live dot must not pulse. Nothing may be left mid-animation and invisible.
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-reduced-motion-home.png'),
      width: W, height: 1000, cookie: draftCk, port, waitFor: homeReady, reduced: true });
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-reduced-motion-live.png'),
      width: W, height: H, cookie: legacyCk, port, waitFor: homeReady, reduced: true });

    // ── 7. EMPTY STATES ────────────────────────────────────────────────────
    // All against the draft tenant, which genuinely has none of these things.
    const empties = [
      ['doctors.html', 'd3-empty-doctors.png', "document.getElementById('emptyCard') && !document.getElementById('emptyCard').hidden", 900],
      ['faqs.html', 'd3-empty-faqs.png', "document.getElementById('emptyCard') && !document.getElementById('emptyCard').hidden", 1000],
      ['pricing.html', 'd3-empty-pricing-treatments.png', "document.getElementById('treatmentsEmpty') && !document.getElementById('treatmentsEmpty').hidden", 1200],
      ['hours.html', 'd3-empty-hours-holidays.png', "document.getElementById('holidaysEmpty') && !document.getElementById('holidaysEmpty').hidden", 1200],
    ];
    for (const [page, out, waitFor, h] of empties) {
      await shoot(cdp, { url: `${base}/${page}`, out: px(out), width: W, height: h, cookie: draftCk, port, waitFor });
    }
    // Home's and History's empty states both need the first-day clinic — see above.
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-empty-home.png'),
      width: W, height: 800, cookie: virginCk, port, waitFor: "document.querySelector('#readinessCard .emp')" });
    await shoot(cdp, { url: `${base}/history.html`, out: px('d3-empty-history.png'),
      width: W, height: 800, cookie: virginCk, port,
      waitFor: "document.getElementById('emptyCard') && !document.getElementById('emptyCard').hidden" });
    // Test page: a real turn on a clinic with no saved settings, so the
    // provenance line takes its warning branch (the test.js:68 rewrite).
    await shoot(cdp, { url: `${base}/test.html`, out: px('d3-empty-test-noconfig.png'),
      width: W, height: 900, cookie: draftCk, port, waitFor: "document.body.dataset.testReady === '1'",
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.querySelector('.starter').click();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.msg__prov')");
      },
    });
    await shoot(cdp, { url: `${base}/test.html`, out: px('d3-empty-test-starters.png'),
      width: W, height: 860, cookie: draftCk, port, waitFor: "document.body.dataset.testReady === '1'" });

    // ── 8. SKELETONS ───────────────────────────────────────────────────────
    // The page's REAL first paint with its GET held open — not a mock. `settle`
    // waits past the 300ms reveal; `waitFor` is omitted because the thing these
    // shots are of is the state before anything arrives.
    const skels = [
      ['index.html', 'd3-skeleton-home.png', '/api/readiness', 700],
      ['pricing.html', 'd3-skeleton-pricing.png', '/api/config/pricing', 700],
      ['history.html', 'd3-skeleton-history.png', '/api/history', 700],
      ['faqs.html', 'd3-skeleton-faqs.png', '/api/faqs', 700],
    ];
    for (const [page, out, frag, h] of skels) {
      await shoot(cdp, { url: `${base}/${page}`, out: px(out), width: W, height: h,
        cookie: cleanCk, port, preload: HANG(frag), settle: 900 });
    }

    // ── 9. FAILED VALIDATION RUN ───────────────────────────────────────────
    // The ring is NOT drawn and no score is shown. A false green here would be
    // worse than the error.
    await shoot(cdp, { url: `${base}/index.html`, out: px('d3-error-home-validation.png'),
      width: W, height: 700, cookie: cleanCk, port,
      preload: FAIL('/api/readiness'),
      waitFor: "document.querySelector('#readinessCard .pg-err')" });
    await shoot(cdp, { url: `${base}/pricing.html`, out: px('d3-error-page-pricing.png'),
      width: W, height: 700, cookie: cleanCk, port,
      preload: FAIL('/api/config/pricing'),
      waitFor: "document.querySelector('#loadCard .pg-err')" });

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
})().catch((e) => { console.error('shootD3 failed:', e); process.exit(1); });
