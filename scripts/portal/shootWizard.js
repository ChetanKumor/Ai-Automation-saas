'use strict';

/* ============================================================================
 * PORTAL-P6-S16 screenshot evidence — dev tooling, not shipped runtime.
 *
 * Same pattern as scripts/portal/shoot.js (throwaway genesis DB, real /portal
 * router + express.static, driven over the Chrome DevTools Protocol — no new
 * dependency). This script additionally proves the wizard's embedding actually
 * works in a REAL browser, not just in the node:test route-level suite:
 *   • "live-advance" shot — navigates to the wizard fresh, fills the REAL
 *     clinic-profile.html form INSIDE the embedded iframe, clicks the
 *     wizard's own "Save & continue", and captures the post-advance state
 *     (Step 2 of 7 · Hours & holidays) — i.e. the same-origin iframe, the
 *     SAMEORIGIN framing header, requestSubmit() into the embedded page's own
 *     form, and the save-detection poll all actually functioned together.
 *   • profile / doctors / review shots — desktop + 380px, at different steps
 *     (meta.onboarding_step seeded directly via configService so each shot
 *     lands exactly where it needs to without scripting every click).
 *
 * Usage:  node scripts/portal/shootWizard.js
 * Output: scripts/portal/shots/wizard-*.png
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
const DEVPORT = 9334; // distinct from shoot.js's 9333 — safe to run alongside it

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }

// ── Minimal CDP client (mirrors shoot.js) ────────────────────────────────────
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
  if (afterReady) await afterReady(cdp, sessionId);
  await sleep(1300); // ring fill (.9s) + fonts + iframe height settle

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

function loginCookieVia(port, p, cookieName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method: 'POST', path: p,
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

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const scratchName = 'zyon_shotwiz_' + crypto.randomBytes(5).toString('hex');
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

    process.env.DATABASE_URL = scratchCs;
    process.env.LOG_LEVEL = 'silent';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shoot-admin-pass';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');
    const { hashPassword } = require('../../src/portal/auth');
    const configService = require('../../src/modules/config/configService');
    const validationService = require('../../src/modules/validation/validationService');

    // Tenant A — fresh, never touched the wizard. Used for the "live-advance"
    // shot (real click-through, step 0 → step 1) and the standalone Profile shot.
    const freshEmail = 'owner@newclinic.test';
    const freshPassword = 'wizard-shot-pass-1';
    const fresh = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id", ['New Clinic']);
    const freshId = fresh.rows[0].id;
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [freshId, freshEmail, hashPassword(freshPassword), 'owner']);

    // Tenant B — mid-wizard (parked on the Doctors step) with a couple of
    // doctors already added, for the Doctors-step shot.
    const midEmail = 'owner@midsetup.test';
    const midPassword = 'wizard-shot-pass-2';
    const mid = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id", ['Midway Clinic']);
    const midId = mid.rows[0].id;
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [midId, midEmail, hashPassword(midPassword), 'owner']);
    await configService.writeTenantConfig(midId, {
      business: { display_name: 'Midway Clinic', phone_numbers: ['+919812345670'] },
      meta: { onboarding_step: 2, onboarding_completed: false },
    }, 'shoot');
    const seedDoctor = (data, type = 'schedule') => db.query(
      'INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1,$2,$3)',
      [midId, type, JSON.stringify(data)]);
    await seedDoctor({ doctor: 'Dr. Iyer', specialization: 'General physician', languages: ['en'],
      days: ['Mon', 'Wed', 'Fri'], start: '10:00', end: '17:00' });

    // Tenant C — fully configured (mirrors shoot.js's Sunrise Dental), parked
    // on Review so the ring/checks show a real, mostly-green readiness state.
    const readyEmail = 'owner@readyclinic.test';
    const readyPassword = 'wizard-shot-pass-3';
    const ready = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id", ['Ready Dental']);
    const readyId = ready.rows[0].id;
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [readyId, readyEmail, hashPassword(readyPassword), 'owner']);
    await configService.writeTenantConfig(readyId, {
      business: { display_name: 'Ready Dental', address: '12 MG Road', phone_numbers: ['+919876543211'] },
      languages: { supported: ['en'], default: 'en' },
      notifications: { owner_numbers: ['+919000000001'] },
      escalation: { enabled: true, phone_numbers: ['+919000000002'] },
      whatsapp: { enabled: false },
      meta: { onboarding_step: 6, onboarding_completed: true },
    }, 'shoot');
    await db.query(
      'INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1,$2,$3)',
      [readyId, 'schedule', JSON.stringify({ doctor: 'Dr. Menon', specialization: 'Dentist', languages: ['en'],
        days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], start: '09:00', end: '17:00' })]);
    const faqService = require('../../src/modules/knowledge/faqService');
    for (let i = 0; i < 5; i++) {
      await faqService.createFaq(readyId, { question: `Sample question ${i + 1}?`, answer: `Sample answer ${i + 1}.` }, { languages: ['en'] });
    }
    await validationService.validateTenant(readyId, {
      skip: ['turn.scripted'],
      deps: { getRelevantChunks: async () => [{ id: 1 }], pingNumber: async () => 'stub' },
    });

    const express = require('express');
    const app = express();
    app.use('/portal', require('../../src/portal/routes'));
    app.use(express.static(path.join(__dirname, '../../public')));
    server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const port = server.address().port;
    console.log('server on', port);

    const freshCookie = await loginCookie(port, freshEmail, freshPassword);
    const midCookie = await loginCookie(port, midEmail, midPassword);
    const readyCookie = await loginCookie(port, readyEmail, readyPassword);

    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-shotwiz-'));
    chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${DEVPORT}`, `--user-data-dir=${udd}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      '--force-prefers-reduced-motion=reduce', 'about:blank',
    ], { stdio: 'ignore' });

    ws = await openWs(await connectBrowser());
    const cdp = new CDP(ws);
    const base = `http://127.0.0.1:${port}/portal`;
    const wizReady = "document.getElementById('wiz') && !document.getElementById('wiz').hidden";

    console.log('capturing:');

    // S16-a: fresh tenant lands on Step 1 of 7 (Profile) — desktop + 380px.
    await shoot(cdp, { url: `${base}/wizard.html`, out: path.join(OUT, 'wizard-s16-profile-desktop.png'),
      width: 1280, height: 1000, cookie: freshCookie, port, waitFor: wizReady });
    await shoot(cdp, { url: `${base}/wizard.html`, out: path.join(OUT, 'wizard-s16-profile-mobile.png'),
      width: 380, height: 1000, mobile: true, cookie: freshCookie, port, waitFor: wizReady });

    // S16-b: mid-setup tenant resumes exactly at the Doctors step (persisted
    // meta.onboarding_step=2) — proves resumability, and shows the embedded
    // Doctors page (a multi-card, non-form step) inside the wizard frame.
    const doctorsReady = wizReady + " && document.getElementById('wizFrame').src.indexOf('doctors.html')!==-1";
    await shoot(cdp, { url: `${base}/wizard.html`, out: path.join(OUT, 'wizard-s16-doctors-desktop.png'),
      width: 1280, height: 1100, cookie: midCookie, port, waitFor: doctorsReady });
    await shoot(cdp, { url: `${base}/wizard.html`, out: path.join(OUT, 'wizard-s16-doctors-mobile.png'),
      width: 380, height: 1100, mobile: true, cookie: midCookie, port, waitFor: doctorsReady });

    // S16-c: fully-configured tenant, Review step — the readiness ring + check
    // rows reused from window.PortalHome, plus the Go-live control.
    const reviewReady = "document.getElementById('wizReview') && !document.getElementById('wizReview').hidden && document.querySelector('#wizReadinessCard .ring, #wizReadinessCard .empty')";
    await shoot(cdp, { url: `${base}/wizard.html`, out: path.join(OUT, 'wizard-s16-review-desktop.png'),
      width: 1280, height: 1200, cookie: readyCookie, port, waitFor: reviewReady });
    await shoot(cdp, { url: `${base}/wizard.html`, out: path.join(OUT, 'wizard-s16-review-mobile.png'),
      width: 380, height: 1300, mobile: true, cookie: readyCookie, port, waitFor: reviewReady });

    // S16-d: LIVE click-through proof — fill the real embedded clinic-profile
    // form and click the wizard's own "Save & continue"; capture the result
    // AFTER it advances to Step 2 of 7 (Hours & holidays). If the iframe
    // embedding, the SAMEORIGIN header, or the save-detection poll were
    // broken, this shot would still show Step 1 with no error.
    await shoot(cdp, {
      url: `${base}/wizard.html`, out: path.join(OUT, 'wizard-s16-live-advance.png'),
      width: 1280, height: 1000, cookie: freshCookie, port, waitFor: wizReady,
      afterReady: async (c, sid) => {
        // Wait for the embedded page's own boot to finish (its #loadCard hides
        // once main() has wired the real save() — the exact same signal
        // wizard.js itself waits for before calling requestSubmit()).
        await waitForSelector(c, sid,
          "document.getElementById('wizFrame').contentDocument && document.getElementById('wizFrame').contentDocument.getElementById('loadCard') && document.getElementById('wizFrame').contentDocument.getElementById('loadCard').hidden");
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){var d=document.getElementById('wizFrame').contentDocument;"
            + "d.getElementById('display_name').value='Live Advance Clinic';"
            // A genuinely fresh (never-configured) tenant starts with zero
            // languages toggled — at least one is required to pass validation,
            // exactly like a real first-time owner would need to set.
            + "d.querySelector('.lang-toggle--en').click();"
            + "document.getElementById('wizContinue').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.getElementById('wizStepLabel').textContent.indexOf('Step 2 of 7')!==-1");
      },
    });

    console.log('all shots captured →', OUT);
  } finally {
    if (ws) try { ws.close(); } catch (_) {}
    if (chrome) chrome.kill();
    if (server) server.close();
    if (db) await db.close();
    process.env.DATABASE_URL = ADMIN;
    const c1 = new Client({ connectionString: ADMIN, ssl: SSL });
    await c1.connect();
    try {
      await c1.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c1.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c1.end(); }
  }
})().catch((err) => { console.error(err); process.exit(1); });
