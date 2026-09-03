#!/usr/bin/env node
'use strict';
/* ============================================================================
 * scripts/admin/trace-capture.js — the Issue 27 page's own instrument (S4)
 *
 * WHY IT IS A SECOND FILE AND NOT A MODE ON measure.js.
 *
 * `scripts/admin/measure.js` needs NOTHING: no database, no server process, no
 * session, no environment variable. That guarantee is why its geometry figures
 * have been a stable preservation check across four sessions — a number it
 * prints cannot be wrong because of migration state, because migration state
 * cannot reach it. Giving it a scratch database to satisfy one page would
 * couple every future geometry run to whether the schema happened to apply.
 * So measure.js keeps its empty-state, no-database job (and it is still what
 * captures this page EMPTY), and the two states that genuinely need rows —
 * populated, and detail — live here, with the database.
 *
 * WHAT IT DOES
 *   --mode probe    (default) K6: mints a scratch DB, mounts the REAL admin
 *                   router on a bare express app, and drives the PAGE'S OWN
 *                   call path — traces.js's listUrl()/detailUrl(), not a
 *                   hand-written URL — for a correct tenant, another tenant,
 *                   and no tenant.
 *   --mode capture  K5: the same app plus static public/, driven by headless
 *                   Chrome, writing PNGs of the list (populated) and the
 *                   detail view.
 *
 * ⚠ NEVER server.js. reminderCron sends real WhatsApp messages, and reaching
 *   Issue 20 with a clean WABA matters more than a screenshot. This mounts the
 *   router directly, exactly as tests/traces/tracesRoutes.test.js does.
 *
 * ⚠ --disable-lcd-text from birth. F-A002 (subpixel antialiasing making shots
 *   host-dependent) remains OPEN on measure.js and is deliberately not fixed
 *   there by this session; it is simply never inherited here.
 *
 * ── THE INTERLOCKS ──────────────────────────────────────────────────────────
 * A capture is only evidence if you can say which bytes it is of. web/'s
 * BUILD_ID interlock does not transfer: this surface has no build step, so
 * there is no build id to compare. Two things are checked instead.
 *
 *   (i)  CONTENT. After navigation the page re-fetches its own URL and the
 *        sha256 of what the browser received is compared to the sha256 of the
 *        file on disk AT THAT MOMENT. A mismatch means the bytes rendered are
 *        not the bytes in the working tree, and the run refuses.
 *   (ii) TREE. `treeId` is sha256 over the sorted (path, content-hash) pairs
 *        of everything under public/admin/. A before/after pixel comparison is
 *        only evidence when the tree actually moved between them, so a match
 *        reported with before.treeId === after.treeId is REFUSED rather than
 *        believed.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const ADMIN_DIR = path.join(PUBLIC, 'admin');
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEVPORT = Number(process.env.TRACE_CAPTURE_PORT || 9421);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name, dflt = '') => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** (ii) The tree interlock. Everything under public/admin/, sorted, hashed. */
function treeId() {
  const rows = fs.readdirSync(ADMIN_DIR).sort()
    .map((f) => [f, sha(fs.readFileSync(path.join(ADMIN_DIR, f)))]);
  return { id: sha(Buffer.from(JSON.stringify(rows))).slice(0, 16), files: rows.length };
}

/* ── Scratch database, exactly the tracesRoutes.test.js idiom ─────────────── */
const PREFIX = 'zyon_cap_tr_';
const ADMIN_URL = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const swapDb = (cs, name) => { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); };

async function sweep() {
  const c = new Client({ connectionString: ADMIN_URL, ssl: SSL });
  await c.connect();
  try {
    const { rows } = await c.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_cap\\_tr\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

async function mintScratch() {
  await sweep();
  const name = PREFIX + crypto.randomBytes(6).toString('hex');
  const c = new Client({ connectionString: ADMIN_URL, ssl: SSL });
  await c.connect();
  await c.query('CREATE DATABASE ' + name);
  await c.end();

  const url = swapDb(ADMIN_URL, name);
  const runner = require('../../src/db/migrate');
  await runner.genesis({ connectionString: url, logger: { log() {}, error() {} } });
  return { name, url };
}

async function dropScratch(name) {
  const c = new Client({ connectionString: ADMIN_URL, ssl: SSL });
  await c.connect();
  try {
    await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
    await c.query('DROP DATABASE IF EXISTS ' + name);
  } finally { await c.end(); }
}

/** Two tenants and the seed's OWN six fixtures on the first. One fixture set,
 * one home: `scripts/seed-turn-traces.js` exports them. */
async function seed(url) {
  const { fixtures, SEED_PREFIX } = require('../seed-turn-traces');
  const c = new Client({ connectionString: url, ssl: SSL });
  await c.connect();
  try {
    const mk = async (name, pnid) => (await c.query(
      `INSERT INTO tenants (business_name, phone_number_id, wa_token, ai_enabled, active)
       VALUES ($1, $2, 'x', true, true) RETURNING id`, [name, pnid])).rows[0].id;

    const tenantId = await mk('Smile Dental (capture)', 'pnid_capture_1');
    const otherId = await mk('Other Clinic (capture)', 'pnid_capture_2');

    const { rows: [cust] } = await c.query(
      `INSERT INTO customers (tenant_id, phone, name) VALUES ($1, '+919000000123', 'Seed Patient')
       RETURNING id`, [tenantId]);
    const { rows: [conv] } = await c.query(
      `INSERT INTO conversations (tenant_id, customer_id, status, mode)
       VALUES ($1, $2, 'open', 'ai') RETURNING id`, [tenantId, cust.id]);

    const turnIds = [];
    let n = 0;
    for (const r of fixtures(conv.id)) {
      const j = (v) => (v == null ? null : JSON.stringify(v));
      const { rows: [row] } = await c.query(
        `INSERT INTO turn_traces
           (tenant_id, conversation_id, channel, correlation_id,
            stage_timings, retrieval, prompt, llm, tool_calls, error, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() - ($11 || ' minutes')::interval)
         RETURNING turn_id`,
        [tenantId, r.conversation_id, r.channel, SEED_PREFIX + crypto.randomBytes(8).toString('hex'),
          j(r.stage_timings), j(r.retrieval), j(r.prompt), j(r.llm), j(r.tool_calls), j(r.error),
          String(n * 7)]);
      turnIds.push(row.turn_id);
      n++;
    }
    return { tenantId, otherId, conversationId: conv.id, turnIds };
  } finally { await c.end(); }
}

/* ── The app: the REAL admin router, never server.js ──────────────────────── */
function buildApp(withStatic) {
  const express = require('express');
  const session = require('express-session');
  const app = express();
  app.use(session({ secret: 'trace-capture', resave: false, saveUninitialized: false }));
  // Pre-authenticated: this instrument is about the page, not about the door.
  app.use((req, _res, next) => { req.session.admin = true; next(); });
  app.use('/admin', require('../../src/admin/adminRoutes'));
  if (withStatic) app.use(express.static(PUBLIC));
  return app;
}
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

/* ── CDP, with a deadline on every call ───────────────────────────────────── */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
  }
  /* A DEADLINE, unlike scripts/portal/shoot.js's send, which has none and
   * wedged a session for 33 minutes. */
  send(method, params = {}, sessionId, ms = 20000) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${ms}ms`));
      }, ms);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }
}

async function connectBrowser() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEVPORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('Chrome DevTools endpoint never came up on ' + DEVPORT);
}
const openWs = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.onopen = () => resolve(ws);
  ws.onerror = (e) => reject(new Error('ws failed: ' + (e.message || 'unknown')));
});

/* ── K6: the probe ────────────────────────────────────────────────────────── */
async function probe() {
  const scratch = await mintScratch();
  process.env.DATABASE_URL = scratch.url;
  let server;
  try {
    const ids = await seed(scratch.url);
    server = await listen(buildApp(false));
    const base = `http://127.0.0.1:${server.address().port}`;

    // THE PAGE'S OWN CALL PATH. Not a URL written here — the exact functions
    // traces.js hands the browser, so the probe cannot pass while the page
    // builds something else.
    const T = require('../../public/admin/traces.js');
    const get = async (url) => {
      const res = await fetch(base + url);
      return { status: res.status, text: await res.text() };
    };

    const out = [];
    const listOk = await get(T.listUrl({ tenantId: ids.tenantId, limit: 50 }));
    out.push(['list, correct tenant', listOk.status, `${JSON.parse(listOk.text).length} rows`]);

    const listOther = await get(T.listUrl({ tenantId: ids.otherId, limit: 50 }));
    out.push(['list, other tenant', listOther.status, `${JSON.parse(listOther.text).length} rows`]);

    const detailOk = await get(T.detailUrl(ids.turnIds[0], ids.tenantId));
    out.push(['detail, owning tenant', detailOk.status, JSON.parse(detailOk.text).turn_id === ids.turnIds[0] ? 'the row' : 'WRONG ROW']);

    const detailForeign = await get(T.detailUrl(ids.turnIds[0], ids.otherId));
    out.push(['detail, OTHER tenant', detailForeign.status, JSON.stringify(detailForeign.text)]);

    const detailAbsent = await get(T.detailUrl(crypto.randomUUID(), ids.otherId));
    out.push(['detail, absent row', detailAbsent.status, JSON.stringify(detailAbsent.text)]);

    // No tenant: the page REFUSES to build a URL, so the 400 is shown by asking
    // the route directly for what the page declines to send.
    const noTenantUrl = T.listUrl({ tenantId: '' });
    const raw400 = await get('/admin/api/traces?limit=50');
    out.push(['list, no tenant (page)', noTenantUrl === null ? 'no request built' : 'BUILT A URL', '—']);
    out.push(['list, no tenant (route)', raw400.status, raw400.text]);

    console.log('\nK6 PROBE — page call path, scratch DB, bare express app, no server.js');
    console.log('─'.repeat(78));
    for (const [what, status, detail] of out) {
      console.log(`  ${String(what).padEnd(24)} ${String(status).padEnd(18)} ${detail}`);
    }

    const denyIdentical = detailForeign.status === 404 && detailForeign.text === detailAbsent.text;
    console.log('─'.repeat(78));
    console.log(`  cross-tenant deny === absent deny : ${denyIdentical ? 'YES' : 'NO'}  (${detailForeign.text.length} bytes)`);
    if (!denyIdentical) { process.exitCode = 1; console.error('  ✗ the deny shape is an oracle'); }
  } finally {
    if (server) server.close();
    // Close the app pool BEFORE dropping the database it is connected to, or the
    // drop terminates a live backend and pino logs a pool error after the report.
    await require('../../src/db/db').close().catch(() => {});
    await dropScratch(scratch.name);
  }
}

/* ── K5: the capture ──────────────────────────────────────────────────────── */
async function capture() {
  const widths = arg('widths', '1440,768').split(',').map(Number);
  const outDir = arg('out', path.join(ROOT, 'scripts', 'out', 'traces'));
  const tree = treeId();
  console.log(`treeId ${tree.id}  (${tree.files} files under public/admin/)`);

  const scratch = await mintScratch();
  process.env.DATABASE_URL = scratch.url;
  const ids = await seed(scratch.url);
  const server = await listen(buildApp(true));
  const port = server.address().port;

  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-capture-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${DEVPORT}`, `--user-data-dir=${udd}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--force-prefers-reduced-motion=reduce',
    // F-A002 is not inherited: subpixel antialiasing makes a shot depend on the
    // host's font rendering, so it is off from this file's first commit.
    '--disable-lcd-text',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  const shots = [];
  try {
    ws = await openWs(await connectBrowser());
    const cdp = new CDP(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);

    const consoleErrors = [];
    await cdp.send('Log.enable', {}, sid).catch(() => {});
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        consoleErrors.push({ text: m.params.entry.text, url: m.params.entry.url || null });
      }
    });

    for (const w of widths) {
      for (const view of ['list', 'detail']) {
        await cdp.send('Emulation.setDeviceMetricsOverride',
          { width: w, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
        const url = `http://127.0.0.1:${port}/admin/traces.html?tenant_id=${ids.tenantId}`;
        await cdp.send('Page.navigate', { url }, sid);
        for (let i = 0; i < 120; i++) {
          const r = await cdp.send('Runtime.evaluate',
            { expression: 'document.readyState === "complete"', returnByValue: true }, sid);
          if (r.result.value) break;
          await sleep(70);
        }
        await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }, sid);
        await sleep(600);

        // (i) THE CONTENT INTERLOCK. The page re-fetches its own document and
        // we hash what the browser received against the file on disk right now.
        const got = await cdp.send('Runtime.evaluate', {
          expression: `(async()=>{const r=await fetch('/admin/traces.html');return await r.text();})()`,
          awaitPromise: true, returnByValue: true,
        }, sid);
        const served = sha(Buffer.from(got.result.value, 'utf8'));
        const disk = sha(fs.readFileSync(path.join(ADMIN_DIR, 'traces.html')));
        if (served !== disk) {
          throw new Error(`CONTENT INTERLOCK FAILED: browser saw ${served.slice(0, 16)}, disk has ${disk.slice(0, 16)}`);
        }

        // ⚠ GATE THE STATE, NEVER SLEEP AND HOPE. The first version of this
        // slept 700ms after the click and captured whatever was on screen: at
        // 1440 that was the detail view, at 768 it was still the LIST, saved
        // under the name traces-detail-768.png. A capture labelled with a state
        // it never reached is worse than no capture, so each view now waits for
        // a condition that is only true in that state and FAILS if it never
        // becomes true.
        const settle = async (expr, what) => {
          for (let i = 0; i < 100; i++) {
            const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
            if (r.result.value) return;
            await sleep(100);
          }
          throw new Error(`never reached the ${what} state at ${w}px — refusing to save a shot of something else`);
        };

        await settle("document.querySelectorAll('tr.trace-row').length > 0", 'populated list');

        if (view === 'detail') {
          await cdp.send('Runtime.evaluate',
            { expression: "document.querySelector('tr.trace-row').click()", returnByValue: true }, sid);
          await settle(
            "getComputedStyle(document.getElementById('traceDetail')).display === 'block'"
            + " && document.getElementById('dStages').children.length > 0"
            + " && getComputedStyle(document.getElementById('traceList')).display === 'none'",
            'detail');
        }

        const m = await cdp.send('Page.getLayoutMetrics', {}, sid);
        const h = Math.ceil(m.cssContentSize ? m.cssContentSize.height : m.contentSize.height);
        await cdp.send('Emulation.setDeviceMetricsOverride',
          { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sid);
        await sleep(250);
        const png = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
        fs.mkdirSync(outDir, { recursive: true });
        const file = path.join(outDir, `traces-${view}-${w}.png`);
        fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
        shots.push({ view, width: w, height: h, file, contentSha: served.slice(0, 16) });
        console.log(`  ${view.padEnd(7)} ${String(w).padStart(5)}x${String(h).padEnd(6)} content ${served.slice(0, 16)}  ${file}`);
      }
    }

    console.log(`\nK7 console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log('  ' + e.text + '   ' + e.url);
    fs.writeFileSync(path.join(outDir, 'manifest.json'),
      JSON.stringify({ treeId: tree.id, shots, consoleErrors }, null, 2));
    console.log(`\nwrote ${path.join(outDir, 'manifest.json')}`);
  } finally {
    try { if (ws) ws.close(); } catch (_) { /* dead socket */ }
    try { chrome.kill(); } catch (_) { /* already gone */ }
    server.close();
    await require('../../src/db/db').close().catch(() => {});
    await dropScratch(scratch.name);
  }
}

/* ── (ii) The tree interlock, as a comparison of two manifests ────────────── */
function compare() {
  const a = JSON.parse(fs.readFileSync(arg('before'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(arg('after'), 'utf8'));
  console.log(`before.treeId ${a.treeId}`);
  console.log(`after.treeId  ${b.treeId}`);
  if (a.treeId === b.treeId) {
    console.error('\n✗ REFUSED: before.treeId === after.treeId. Both captures are of the SAME '
      + 'tree, so any match between them is a tautology, not evidence that the page survived '
      + 'a change.');
    process.exitCode = 1;
    return;
  }
  console.log('\n✓ the tree moved between the two captures — a pixel comparison is meaningful.');
}

async function main() {
  const mode = arg('mode', 'probe');
  if (mode === 'probe') return probe();
  if (mode === 'capture') return capture();
  if (mode === 'compare') return compare();
  throw new Error(`unknown --mode ${mode} (probe | capture | compare)`);
}

if (require.main === module) {
  require('dotenv').config();
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { treeId, buildApp, seed, mintScratch, dropScratch };
