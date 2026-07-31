'use strict';

/* ============================================================================
 * D4 Verbatim panel — screenshot + assertion evidence. Dev tooling, not shipped.
 *
 * Same machinery as shoot.js / shootD3.js (throwaway scratch DB -> genesis ->
 * real routers -> CDP). What is different here:
 *
 *   1. ONE tenant, deliberately: Telugu + English enabled with Telugu as the
 *      DEFAULT, real Hyderabad prices including a lakh-scale one (Crown fitting
 *      ₹1,50,000) so Indian digit grouping is exercised, and seven days of
 *      real hours. The panel is a per-tenant surface; a second fixture would
 *      not test anything the first does not.
 *
 *   2. The Telugu greeting is NOT written for this file. It is lifted verbatim
 *      from public/demo/fixture.json — DEMO-00's captured brain output, with
 *      the English gloss the fixture itself carries. See the comment at the
 *      seeding site. D4 ships zero product-authored vernacular by design.
 *
 *   3. CSS.getPlatformFontsForNode is used to assert which font family actually
 *      rasterised U+20B9, rather than eyeballing a screenshot. That is the only
 *      way to close F-V001 with evidence instead of an opinion.
 *
 *   4. probe() gained a viewport and awaitPromise (see the function): the panel
 *      has three responsive forms and a debounced live region, and D3's probe
 *      could assert neither.
 *
 * Usage:  node scripts/portal/shootD4.js
 * Output: scripts/portal/shots/d4-*.png
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
const DEVPORT = 9336; // not shoot.js's 9333 nor shootD3's 9334 — all three run back to back

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
/**
 * D4 additions:
 * `collapsed`      — pin the panel's localStorage preference for this shot.
 *                    Every target shares one Chrome profile, so the assertion
 *                    pass above (which collapses the sheet, opens the rail, and
 *                    so on) leaves `portal.verbatim.collapsed` set — and the
 *                    docked shots then silently photographed a rail. Stating the
 *                    intended state per shot is the only way these are stable.
 * `clipToViewport` — capture the viewport rather than the full content height.
 *                    The panel is position:sticky/100vh, so a full-page capture
 *                    of a 2960px document shows it filling only the first
 *                    screen, which reads as a rendering bug rather than as the
 *                    scroll artefact it is.
 */
async function shoot(cdp, { url, out, width, height, mobile, cookie, port, waitFor, afterReady, reduced, preload, settle, collapsed, clipToViewport }) {
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
  if (collapsed !== undefined) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try{localStorage.setItem('portal.verbatim.collapsed','"
        + (collapsed ? '1' : '0') + "');}catch(e){}",
    }, sessionId);
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
  // The REAL visual viewport, not the requested height. Mobile emulation can
  // hand back an innerHeight larger than the metrics asked for (842 for a
  // requested 820), and clipping to the request then cuts the bottom-docked
  // sheet in half — which looks exactly like a layout bug in the product.
  // Ask the PAGE, not the metrics: under mobile emulation cssVisualViewport
  // still reports the requested 820 while window.innerHeight is 842, and the
  // bottom-docked sheet lives in the 22px difference.
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
 * Assert a DOM fact in a freshly loaded page and report it. This is how
 * verification 3b ("exactly ONE notice, not two") is established: eyeballing a
 * screenshot cannot distinguish one amber block from two when the second is
 * below the fold, and the whole point of folding the strip and the per-page
 * notice into one component is that a duplicate must be impossible.
 */
// D4 additions to D3's probe: a viewport (the panel has three forms, so an
// assertion that cannot pick a width can only ever test one of them), and
// awaitPromise, because a warning's focus effect is only observable after the
// debounce has run.
async function probe(cdp, { url, cookie, port, waitFor, checks, width, height, mobile }) {
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
  const loaded = new Promise((res) => {
    cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  if (waitFor) await waitForSelector(cdp, sessionId, waitFor);
  await sleep(400);
  let failed = 0;
  for (const [label, expr, expected] of checks) {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
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
  const scratchName = 'zyon_d4_' + crypto.randomBytes(5).toString('hex');
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

    // ── The Telugu the panel renders is NOT invented for this harness ───────
    // D4 Phase 0 check 0.6 recorded that the PRODUCT ships zero Telugu strings.
    // The fixture clinic still needs one, and hand-typing Telugu without a
    // native reader is exactly the failure mode the native-review gate exists
    // to stop. So the greeting below is lifted VERBATIM from
    // public/demo/fixture.json — DEMO-00's captured brain output, whose
    // provenance block records it as "REAL. Output of aiService.generateReply
    // (channel='voice') ... Verbatim, never edited" — with the English gloss
    // the fixture itself carries. It reads as an availability answer rather
    // than a greeting, which is honest: what it proves is glyph fidelity —
    // conjuncts, matras, and Latin digits inside a Telugu run — at 19/34 on
    // the ink ground.
    const FIXTURE = require('../../public/demo/fixture.json');
    const TE_LINE = FIXTURE.call.find((t) => t.speaker === 'ai');

    const config = {
      business: {
        display_name: 'Sri Dental Care',
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
          { name: 'Tooth extraction', price: 2500, duration_minutes: 20 },
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
    };

    const t = await db.query(
      'INSERT INTO tenants (business_name, active) VALUES ($1, false) RETURNING id', ['Sri Dental Care']);
    const tenantId = t.rows[0].id;
    const PW = 'demo-portal-pass';
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [tenantId, 'owner@sri.test', hashPassword(PW), 'owner']);
    await configService.writeTenantConfig(tenantId, config, 'shootD4');
    await configService.writeTenantConfigMeta(tenantId, { onboarding_step: 6, onboarding_completed: true });
    for (let i = 0; i < 3; i += 1) {
      await faqService.createFaq(tenantId,
        { question: 'Do you do same-day appointments ' + (i + 1) + '?', answer: 'Yes, call before 11am.' },
        { languages: ['te', 'en'] });
    }
    console.log('seeded Sri Dental Care — te+en, default te, 4 treatments, 3 FAQs');

    const express = require('express');
    const app = express();
    app.use('/portal', require('../../src/portal/routes'));
    app.use(express.static(path.join(__dirname, '../../public')));
    server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const port = server.address().port;
    const ck = await loginCookie(port, 'owner@sri.test', PW);

    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-d4-'));
    chrome = spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=' + DEVPORT, '--user-data-dir=' + udd,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      'about:blank',
    ], { stdio: 'ignore' });

    ws = await openWs(await connectBrowser());
    const cdp = new CDP(ws);
    const base = 'http://127.0.0.1:' + port + '/portal';
    const px = (n) => path.join(OUT, n);
    // The panel is mounted AND filled — the greeting bubble has real text in it.
    const ready = "document.querySelector('#vpLive .vp__bub')";

    console.log('\nasserting:');

    // ── 1. THE RUPEE. Asserted, never eyeballed. ───────────────────────────
    // CSS.getPlatformFontsForNode reports the families Chrome ACTUALLY used to
    // rasterise the node, split per glyph run — the rendered truth, not a
    // restatement of the stylesheet.
    console.log('  the rupee sign and the digits beside it:');
    {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sid);
      await cdp.send('Network.enable', {}, sid);
      // 1440, explicitly. Without a viewport this target gets the default small
      // one, where the panel is a COLLAPSED bottom sheet — `.vp__b` is
      // display:none, #vpLive has no layout, and getPlatformFontsForNode
      // correctly reports nothing. That reads identically to "the font failed to
      // resolve", which is how this check quietly lied on its first two runs.
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
      await cdp.send('Network.setCookie',
        { name: ck.name, value: ck.value, url: 'http://127.0.0.1:' + port + '/' }, sid);

      // A unicode-range-scoped face is downloaded ONLY when the page actually
      // needs a glyph in that range. So the presence of noto-rupee-*.woff2 on
      // the wire is itself proof that the rupee is being served from it.
      const fontReqs = [];
      cdp.on((m) => {
        if (m.sessionId === sid && m.method === 'Network.requestWillBeSent'
          && /\.woff2/.test(m.params.request.url)) fontReqs.push(m.params.request.url.split('/').pop());
      });

      await cdp.send('Page.navigate', { url: base + '/pricing.html' }, sid);
      await waitForSelector(cdp, sid, ready);
      await sleep(900);

      // Insert the probe nodes BEFORE enabling the DOM/CSS agents. The DOM agent
      // caches the document it first walked; nodes created afterwards are not in
      // that tree, DOM.querySelector answers nodeId 0, and
      // getPlatformFontsForNode returns an empty list — which reads exactly like
      // "the font did not resolve" rather than "you asked the wrong question".
      //
      // Long-hand style properties, not the `font` shorthand: a shorthand
      // containing var() becomes a pending-substitution value, and if it fails
      // to resolve the probe silently renders in the default face — i.e. the
      // measurement would report the fallback this check exists to rule out.
      await cdp.send('Runtime.evaluate', {
        expression: "(function(){"
          + "var cs=getComputedStyle(document.documentElement);"
          + "function mk(id,fam,after){var p=document.createElement('p');p.id=id;"
          + "p.style.fontFamily=fam;p.style.fontWeight='600';p.style.fontSize='19px';"
          + "p.style.lineHeight='34px';p.style.color='#e8edf2';"
          + "p.textContent='\\u20B91,50,000';after.appendChild(p);return p;}"
          + "var live=document.querySelector('#vpLive');"
          + "mk('rupeeProbe', cs.getPropertyValue('--sans').trim(), live);"
          + "mk('rupeeCtl', 'NoNotoHere, system-ui', live);"
          + "var rows=Array.from(document.querySelectorAll('#vpLive .vp__fact-v'));"
          + "var r=rows.filter(function(e){return e.textContent.indexOf('\\u20B9')!==-1;})[0];"
          + "if(r){r.id='realPrice';window.__rp=r.textContent;}"
          + "})()",
      }, sid);
      await sleep(500); // let the newly-needed faces load and paint

      await cdp.send('DOM.enable', {}, sid);
      await cdp.send('CSS.enable', {}, sid);

      const fontsFor = async (selector) => {
        const d = await cdp.send('DOM.getDocument', { depth: -1 }, sid);
        const q = await cdp.send('DOM.querySelector', { nodeId: d.root.nodeId, selector }, sid);
        if (!q.nodeId) return null;
        const f = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: q.nodeId }, sid);
        return f.fonts || [];
      };

      // (a) A price exactly as the panel sets one: 19px / 600, ink ground.
      const probeFonts = await fontsFor('#rupeeProbe');
      console.log('    probe "\u20B91,50,000" @600 19px/34px:');
      (probeFonts || []).forEach((f) => console.log('      ' + f.familyName
        + '  [' + f.postScriptName + ']  custom=' + f.isCustomFont + '  x' + f.glyphCount + ' glyphs'));

      // The two runs report DIFFERENT familyName strings \u2014 "Noto Sans SemiBold"
      // for the rupee face and "Noto Sans" for the latin one \u2014 because Chrome
      // echoes each woff2's internal name record, and Google's text= subsetter
      // writes a different one from its unicode-range subsetter. Comparing
      // familyName would therefore fail on two files of the SAME typeface.
      // What actually matters, and what F-V001 was about, is: does any run fall
      // out of the self-hosted Noto Sans SemiBold and onto a system face?
      const norm = (s) => String(s || '').replace(/-/g, '').toLowerCase();
      const allNoto = (probeFonts || []).length > 0
        && probeFonts.every((f) => f.isCustomFont === true && norm(f.postScriptName) === 'notosanssemibold');
      console.log('      every run is self-hosted Noto Sans SemiBold: '
        + (allNoto ? 'PASS - sign and digits share one typeface at one weight' : 'FAIL - a run fell back'));

      // (b) A REAL panel price row, not a synthetic probe.
      const realText = (await cdp.send('Runtime.evaluate', { expression: 'window.__rp', returnByValue: true }, sid)).result.value;
      const realFonts = await fontsFor('#realPrice');
      console.log('    real panel row "' + realText + '":');
      (realFonts || []).forEach((f) => console.log('      ' + f.familyName
        + '  [' + f.postScriptName + ']  x' + f.glyphCount + ' glyphs'));

      // (c) The CONTROL — the same string with Noto taken out of the stack, so
      // the fix is measured against the defect rather than merely asserted.
      // This is what every ₹ in the product rendered as before this session.
      const ctlFonts = await fontsFor('#rupeeCtl');
      console.log('    control — same string, Noto removed from the stack:');
      (ctlFonts || []).forEach((f) => console.log('      ' + f.familyName
        + '  [' + f.postScriptName + ']  custom=' + f.isCustomFont + '  x' + f.glyphCount + ' glyphs'));

      // (d) Corroboration that does not depend on the platform-font API at all.
      console.log('    woff2 the browser actually fetched: ' + (fontReqs.join(', ') || '(none)'));
      const rupeeFaces = (await cdp.send('Runtime.evaluate', {
        expression: "Array.from(document.fonts).filter(function(f){return /20B9/i.test(f.unicodeRange);})"
          + ".map(function(f){return f.family+' w'+f.weight+' '+f.status;}).join(' | ')",
        returnByValue: true,
      }, sid)).result.value;
      console.log('    faces declaring U+20B9: ' + rupeeFaces);

      await cdp.send('Target.closeTarget', { targetId }, sid);
    }

    // ── 2. Panel semantics ─────────────────────────────────────────────────
    console.log('  panel semantics:');
    await probe(cdp, { url: base + '/pricing.html', cookie: ck, port, waitFor: ready, checks: [
      ['panel is a complementary landmark', "document.getElementById('verbatim').tagName", 'ASIDE'],
      ['the landmark is named', "document.getElementById('verbatim').getAttribute('aria-label')", 'Live preview'],
      ['preview region is aria-live=polite', "document.getElementById('vpLive').getAttribute('aria-live')", 'polite'],
      ['exactly one panel on the page', "document.querySelectorAll('.vp').length", 1],
      ['Hear it ships disabled', "document.querySelector('.vp__f .vp__btn').disabled", true],
      ['its reason is adjacent and visible',
        "(function(){var w=document.querySelector('.vp__why');"
        + "return w.textContent.trim().length>0 && getComputedStyle(w).display!=='none';})()", true],
      ['no write path: zero inputs/forms inside the panel',
        "document.querySelectorAll('#verbatim form, #verbatim input, #verbatim textarea').length", 0],
      ['the gloss is never aria-hidden', "document.querySelectorAll('.vp__gloss[aria-hidden]').length", 0],
      ['the gloss is present under the vernacular bubble',
        "!!document.querySelector('#vpLive .vp__bub + .vp__gloss')", true],
      ['every vernacular string carries lang',
        "(function(){var n=document.querySelectorAll('#vpLive .vp__te, #vpLive .vp__hi');"
        + "return n.length>0 && Array.from(n).every(function(e){return !!e.getAttribute('lang');});})()", true],
      ['the Telugu bubble is set at 19px/34px',
        "(function(){var s=getComputedStyle(document.querySelector('#vpLive .vp__te'));"
        + "return s.fontSize+'/'+s.lineHeight;})()", '19px/34px'],
      ['the bubble resolves the Telugu face first',
        "getComputedStyle(document.querySelector('#vpLive .vp__te')).fontFamily"
        + ".replace(/[\"']/g,'').indexOf('Noto Sans Telugu')===0", true],
      ['the ink ground is the panel, not the page',
        "getComputedStyle(document.getElementById('verbatim')).backgroundColor", 'rgb(12, 20, 32)'],
    ] });

    // ── 3. Debounce, measured ──────────────────────────────────────────────
    console.log('  debounce — FACTS move within one window, previous value readable throughout:');
    {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sid);
      await cdp.send('Network.enable', {}, sid);
      await cdp.send('Network.setCookie',
        { name: ck.name, value: ck.value, url: 'http://127.0.0.1:' + port + '/' }, sid);
      await cdp.send('Page.navigate', { url: base + '/pricing.html' }, sid);
      await waitForSelector(cdp, sid, ready);
      await sleep(800);

      const read = async (expr) => (await cdp.send('Runtime.evaluate',
        { expression: expr, returnByValue: true }, sid)).result.value;
      const FEE = "Array.from(document.querySelectorAll('#vpLive .vp__fact')).filter("
        + "function(r){return /Consultation/.test(r.textContent);})[0]"
        + ".querySelector('.vp__fact-v').textContent";

      const before = await read(FEE);
      await cdp.send('Runtime.evaluate', {
        expression: "(function(){var f=document.getElementById('consultation_fee');"
          + "f.value='850';f.dispatchEvent(new Event('input',{bubbles:true}));})()",
      }, sid);

      await sleep(150);
      const midVal = await read(FEE);
      const midBusy = await read("document.getElementById('verbatim').classList.contains('is-busy')");
      const midProg = await read("getComputedStyle(document.querySelector('.vp__prog')).height");

      await sleep(950);
      const after = await read(FEE);
      const afterProg = await read("getComputedStyle(document.querySelector('.vp__prog')).height");

      console.log('    before edit                  : ' + before);
      console.log('    +150ms  (mid-debounce)       : ' + midVal + '   busy=' + midBusy + '  progress=' + midProg);
      console.log('    +1100ms (one debounce later) : ' + after + '   progress=' + afterProg);
      console.log('    previous value readable throughout : ' + (midVal === before ? 'PASS' : 'FAIL'));
      console.log('    FACTS updated within one debounce  : ' + (after !== before ? 'PASS' : 'FAIL')
        + '  (' + before + ' -> ' + after + ')');
      console.log('    progress line 2px while busy       : ' + (midProg === '2px' ? 'PASS' : 'FAIL')
        + ' ; collapses to 0px after: ' + (afterProg === '0px' ? 'PASS' : 'FAIL'));

      // Identical regeneration must not rewrite the live region (D3's lesson).
      await cdp.send('Runtime.evaluate', {
        expression: "(function(){var f=document.getElementById('consultation_fee');"
          + "f.value='500';f.dispatchEvent(new Event('input',{bubbles:true}));})()",
      }, sid);
      await sleep(950);
      const settled = await read("document.getElementById('vpLive').innerHTML");
      await cdp.send('Runtime.evaluate', {
        expression: "(function(){window.__n=0;"
          + "var o=new MutationObserver(function(ms){window.__n+=ms.length;});"
          + "o.observe(document.getElementById('vpLive'),{childList:true,subtree:true,characterData:true});"
          + "var f=document.getElementById('consultation_fee');"
          + "f.dispatchEvent(new Event('input',{bubbles:true}));})()",
      }, sid);
      await sleep(950);
      const muts = await read('window.__n');
      const same = (await read("document.getElementById('vpLive').innerHTML")) === settled;
      console.log('    identical regeneration -> live-region mutations: ' + muts
        + '  (' + (muts === 0 && same ? 'PASS - region untouched, no re-announce' : 'FAIL') + ')');
      await cdp.send('Target.closeTarget', { targetId }, sid);
    }

    // ── 4. Keyboard ────────────────────────────────────────────────────────
    console.log('  keyboard:');
    await probe(cdp, { url: base + '/pricing.html', cookie: ck, port, waitFor: ready, checks: [
      ['panel controls are in the tab order',
        "(function(){var n=document.querySelectorAll('#verbatim button:not([disabled]), #verbatim select, #verbatim a[href]');"
        + "return n.length>0 && Array.from(n).every(function(e){return e.tabIndex>=0;});})()", true],
      ['the panel follows main content in DOM order (Tab reaches it last)',
        "(function(){var m=document.querySelector('.main');var v=document.getElementById('verbatim');"
        + "return !!(m.compareDocumentPosition(v) & Node.DOCUMENT_POSITION_FOLLOWING);})()", true],
    ] });

    console.log('  a warning focuses the field it names:');
    await probe(cdp, { url: base + '/pricing.html', cookie: ck, port, waitFor: ready, checks: [
      ['clearing the consultation fee raises a warning, and it focuses that input',
        "(function(){"
        + "var f=document.getElementById('consultation_fee');f.value='';"
        + "f.dispatchEvent(new Event('input',{bubbles:true}));"
        + "return new Promise(function(res){setTimeout(function(){"
        + "var w=Array.from(document.querySelectorAll('#vpLive [data-warn]')).filter("
        + "function(b){return /consultation fee/i.test(b.textContent);})[0];"
        + "if(!w) return res('no-warning-rendered');"
        + "w.click(); res(document.activeElement && document.activeElement.id);"
        + "},800);});})()", 'consultation_fee'],
    ] });

    console.log('  Escape collapses the sheet; the docked panel is left alone:');
    await probe(cdp, { url: base + '/pricing.html', cookie: ck, port, waitFor: ready, width: 380, mobile: true, checks: [
      ['the sheet starts collapsed', "document.getElementById('verbatim').classList.contains('is-collapsed')", true],
      ['the handle carries the greeting, with lang',
        "(function(){var g=document.getElementById('vpGrip');"
        + "return g.textContent.trim().length>0 && g.getAttribute('lang')==='te';})()", true],
      ['tapping the handle opens it',
        "(function(){document.querySelector('.vp__grip').click();"
        + "return !document.getElementById('verbatim').classList.contains('is-collapsed');})()", true],
      ['Escape collapses it again',
        "(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"
        + "return document.getElementById('verbatim').classList.contains('is-collapsed');})()", true],
    ] });
    await probe(cdp, { url: base + '/pricing.html', cookie: ck, port, waitFor: ready, width: 1440, checks: [
      ['docked at 1440: Escape does NOT collapse it (it covers nothing)',
        "(function(){var v=document.getElementById('verbatim');v.classList.remove('is-collapsed');"
        + "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"
        + "return v.classList.contains('is-collapsed');})()", false],
      ['docked width is --panel-w',
        "Math.round(document.getElementById('verbatim').getBoundingClientRect().width)", 360],
    ] });

    console.log('  the rail at 1024 is 44px:');
    await probe(cdp, { url: base + '/pricing.html', cookie: ck, port, width: 1024,
      waitFor: "document.querySelector('.vp')", checks: [
        ['collapsed by default below 1280', "document.getElementById('verbatim').classList.contains('is-collapsed')", true],
        ['rail width', "Math.round(document.getElementById('verbatim').getBoundingClientRect().width)", 44],
        ['the rail label reads Preview', "document.querySelector('.vp__rail-t').textContent.trim()", 'Preview'],
      ] });

    // ── 5. Mount coverage ──────────────────────────────────────────────────
    console.log('  mounts — nine, and nowhere else:');
    const MOUNTED = ['clinic-profile', 'hours', 'pricing', 'doctors', 'booking-rules',
      'faqs', 'receptionist', 'safety', 'test'];
    const NOT_MOUNTED = ['index', 'history', 'knows'];
    for (const p of MOUNTED) {
      await probe(cdp, { url: base + '/' + p + '.html', cookie: ck, port,
        waitFor: "document.querySelector('#vpLive .vp__bub')", checks: [
          [(p + '                ').slice(0, 16) + 'panel present, greeting rendered',
            "document.querySelectorAll('.vp').length", 1],
        ] });
    }
    for (const p of NOT_MOUNTED) {
      await probe(cdp, { url: base + '/' + p + '.html', cookie: ck, port,
        waitFor: 'document.readyState==="complete"', checks: [
          [(p + '                ').slice(0, 16) + 'panel ABSENT', "document.querySelectorAll('.vp').length", 0],
        ] });
    }

    console.log('  no retired vocabulary anywhere in the panel:');
    await probe(cdp, { url: base + '/pricing.html', cookie: ck, port, waitFor: ready, checks: [
      ['AI Employee / AI Operating System / Submit',
        "/AI Employee|AI Operating System|Submit/.test(document.getElementById('verbatim').textContent)", false],
    ] });

    // ── 6. The collapsed sheet's geometry ──────────────────────────────────
    // The handle is the ONLY part of the panel a phone owner sees until they
    // tap it, and it carries a vernacular line. Both failure modes are silent:
    // a sheet taller than it claims pushes the line under the fold, and a
    // Latin-sized line box clips Telugu matras and conjuncts without wrapping
    // or scrolling. Measure both rather than reading them off a screenshot.
    console.log('  the collapsed sheet at 380 fits, and does not clip Telugu:');
    {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sid);
      await cdp.send('Network.enable', {}, sid);
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: 380, height: 820, deviceScaleFactor: 1, mobile: true }, sid);
      await cdp.send('Network.setCookie',
        { name: ck.name, value: ck.value, url: 'http://127.0.0.1:' + port + '/' }, sid);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument',
        { source: "try{localStorage.setItem('portal.verbatim.collapsed','1');}catch(e){}" }, sid);
      await cdp.send('Page.navigate', { url: base + '/pricing.html' }, sid);
      await waitForSelector(cdp, sid, ready);
      await sleep(900);
      const read = async (e) => (await cdp.send('Runtime.evaluate',
        { expression: e, returnByValue: true }, sid)).result.value;

      const vh = await read('window.innerHeight');
      const rect = await read("(function(){var r=document.getElementById('verbatim')"
        + ".getBoundingClientRect();return [Math.round(r.top),Math.round(r.bottom),Math.round(r.height)].join(',');})()");
      // scrollHeight will NOT catch this: with overflow:hidden and a fixed
      // line-height, Telugu matras and conjuncts paint outside the line box and
      // are clipped as ink without ever making the box scrollable. So measure
      // what the same string at the same font actually needs, by cloning it
      // with line-height:normal and no clipping.
      const te = await read("(function(){"
        + "var e=document.getElementById('vpGrip');var s=getComputedStyle(e);"
        + "var c=document.createElement('span');"
        + "c.style.cssText='position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;'"
        + "+'font-family:'+s.fontFamily+';font-size:'+s.fontSize+';font-weight:'+s.fontWeight;"
        + "c.setAttribute('lang','te');c.textContent=e.textContent;"
        + "document.body.appendChild(c);"
        + "var need=Math.ceil(c.getBoundingClientRect().height);c.remove();"
        + "return [Math.round(e.getBoundingClientRect().height),need,s.lineHeight].join(',');})()");
      const [rTop, rBot] = rect.split(',').map(Number);
      const [teH, teNeed, teLH] = te.split(',');
      console.log('    viewport height              : ' + vh);
      console.log('    panel top,bottom,height      : ' + rect);
      console.log('    handle box / Telugu needs    : ' + teH + 'px / ' + teNeed + 'px  (line-height ' + teLH + ')');
      console.log('    sheet sits fully on screen   : '
        + (rBot <= vh && rTop >= 0 ? 'PASS' : 'FAIL — bottom ' + rBot + ' vs viewport ' + vh));
      console.log('    vernacular ink not clipped   : '
        + (Number(teNeed) <= Number(teH) ? 'PASS'
          : 'FAIL — Telugu needs ' + teNeed + 'px, box is ' + teH + 'px'));
      await cdp.send('Target.closeTarget', { targetId }, sid);
    }

    console.log('\ncapturing:');
    const W = 1440, H = 950;

    // Docked. clipToViewport, because the panel is sticky/100vh and these pages
    // run to ~3000px — a full-page capture would show it covering the top third
    // and read as a bug rather than as the unscrolled position it is.
    for (const p of ['pricing', 'receptionist', 'hours']) {
      await shoot(cdp, { url: base + '/' + p + '.html', out: px('d4-docked-1440-' + p + '.png'),
        width: W, height: H, cookie: ck, port, waitFor: ready, settle: 1000,
        collapsed: false, clipToViewport: true });
    }

    await shoot(cdp, { url: base + '/pricing.html', out: px('d4-rail-1024.png'),
      width: 1024, height: 900, cookie: ck, port, waitFor: "document.querySelector('.vp')",
      settle: 1000, collapsed: true, clipToViewport: true });
    await shoot(cdp, { url: base + '/pricing.html', out: px('d4-rail-1024-open.png'),
      width: 1024, height: 900, cookie: ck, port, waitFor: "document.querySelector('.vp')",
      settle: 1000, collapsed: true, clipToViewport: true,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: "document.querySelector('.vp__rail').click();" }, sid);
        await sleep(400);
      } });

    await shoot(cdp, { url: base + '/pricing.html', out: px('d4-sheet-380-handle.png'),
      width: 380, height: 820, mobile: true, cookie: ck, port, waitFor: ready,
      settle: 1000, collapsed: true, clipToViewport: true });
    await shoot(cdp, { url: base + '/pricing.html', out: px('d4-sheet-380-open.png'),
      width: 380, height: 820, mobile: true, cookie: ck, port, waitFor: ready,
      settle: 1000, collapsed: true, clipToViewport: true,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: "document.querySelector('.vp__grip').click();" }, sid);
        await sleep(500);
      } });

    // The rupee at the size the panel sets it, plus the same string with the
    // rupee faces defeated — the defect and the fix, side by side.
    await shoot(cdp, { url: base + '/pricing.html', out: px('d4-rupee-19px-600.png'),
      width: 900, height: 460, cookie: ck, port, waitFor: ready, settle: 1000,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "(function(){document.body.innerHTML="
            + "'<div style=\"background:#0c1420;color:#e8edf2;padding:36px\">'"
            + "+'<div style=\"font:600 11px/1 var(--sans);letter-spacing:.075em;text-transform:uppercase;color:#94a3b8\">FIXED &mdash; Noto Sans carries U+20B9</div>'"
            + "+'<div style=\"font:600 19px/34px var(--sans);margin-top:10px\">Consultation \\u20B9500 \\u00b7 Root canal from \\u20B94,500 \\u00b7 Crown \\u20B91,50,000</div>'"
            + "+'<div style=\"font:600 52px/1.35 var(--sans)\">\\u20B91,50,000</div>'"
            + "+'<div style=\"font:600 11px/1 var(--sans);letter-spacing:.075em;text-transform:uppercase;color:#94a3b8;margin-top:26px\">BEFORE &mdash; rupee served by system-ui</div>'"
            + "+'<div style=\"font:600 19px/34px NoNotoHere, system-ui;margin-top:10px\">Consultation \\u20B9500 \\u00b7 Root canal from \\u20B94,500 \\u00b7 Crown \\u20B91,50,000</div>'"
            + "+'<div style=\"font:600 52px/1.35 NoNotoHere, system-ui\">\\u20B91,50,000</div>'"
            + "+'</div>';})()",
        }, sid);
        await sleep(400);
      } });

    // Telugu at 19/34 and again at 34/58, so conjuncts and matras can be read.
    await shoot(cdp, { url: base + '/receptionist.html', out: px('d4-telugu-19-34.png'),
      width: 940, height: 660, cookie: ck, port, waitFor: ready, settle: 1000,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "(function(){"
            + "var te=document.querySelector('#vpLive .vp__te').textContent;"
            + "var g=document.querySelector('#vpLive .vp__gloss');"
            + "var gl=g?g.textContent:'';"
            + "document.body.innerHTML='<div style=\"background:#0c1420;padding:36px\">'"
            + "+'<p lang=\"te\" style=\"font:600 19px/34px var(--te);color:#e8edf2;margin:0 0 24px\">'+te+'</p>'"
            + "+'<p lang=\"te\" style=\"font:600 34px/58px var(--te);color:#e8edf2;margin:0 0 24px\">'+te+'</p>'"
            + "+'<p style=\"font:400 12.5px/1.6 var(--sans);color:#94a3b8;margin:0\">'+gl+'</p></div>';})()",
        }, sid);
        await sleep(500);
      } });

    console.log('done ->', OUT);
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
})().catch((e) => { console.error('shootD4 failed:', e); process.exit(1); });
