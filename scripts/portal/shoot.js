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
      escalation: { enabled: true, phone_numbers: ['+919000000002'] },
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
    }, 'shoot');

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
