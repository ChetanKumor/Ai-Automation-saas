#!/usr/bin/env node
'use strict';
/* ============================================================================
 * scripts/admin/measure.js — the admin panel's measuring instrument (A1)
 *
 * WHY THIS FILE IS IN THE REPO AT ALL.
 *
 * It was written as a scratchpad throwaway during A1's Phase A, because both
 * existing shooters were red at HEAD (`scripts/portal/shoot.js` does not
 * complete; `shootD5a.js` has been red since before S4) and the admin panel had
 * to be measured anyway. It is committed because that is exactly the shape of
 * thing F-H003 was filed about, and because D-016's "532 pairs" is
 * unreproducible today for precisely this reason: the number was real, the
 * instrument that produced it was not kept, and so the number cannot be
 * checked, re-run, or disproved by anyone who comes after.
 *
 * A measurement whose instrument was deleted is an assertion, not evidence.
 *
 * WHAT IT DOES. Serves `public/` over a loopback port, drives headless Chrome
 * over CDP, and reads geometry, horizontal overflow, focus rings and tab order
 * off the four admin pages at whatever widths you name, and prints numbers.
 *
 * It will also capture a PNG on demand (`--mode shot`), for a human to look at.
 * What it will NEVER do is COMPARE one against a baseline. That is the whole
 * distinction: the byte-comparison shot corpus is the thing that has proven
 * undependable twice — 16 of 54 shots moved between IDENTICAL runs at S3a, and
 * 4 of 69 at S5, at an unchanged tree — so a PNG here is evidence for a person,
 * never a gate. A number that can be read and argued with is worth more than a
 * picture that can only be equal or unequal.
 *
 * WHAT IT NEEDS. Nothing. No database, no server process, no session, no
 * environment variable. The admin pages' own fetches 404 against the static
 * server and the pages render their empty state, which is the state every
 * geometry assertion below is about anyway. `tenant-detail.html` is the one
 * page whose body is behind a JS gate; --show-detail forces it visible and the
 * output labels every such row FORCED.
 *
 * USAGE
 *   node scripts/admin/measure.js                     # geometry, all four, default widths
 *   node scripts/admin/measure.js --widths 1440,768   # pick the viewports
 *   node scripts/admin/measure.js --pages tenant-detail,tenants
 *   node scripts/admin/measure.js --mode overflow     # scrollWidth vs viewport
 *   node scripts/admin/measure.js --mode focus        # tab order + computed rings
 *   node scripts/admin/measure.js --mode all
 *   node scripts/admin/measure.js --json out.json     # machine-readable too
 *   node scripts/admin/measure.js --mode shot --pages tenants --widths 1900 --out dir
 *   CHROME_PATH=/path/to/chrome node scripts/admin/measure.js
 *
 * A2-A5 measure with this file. If a run of it disagrees with a number in
 * docs/design/brand-values.md or docs/os/state.md, the document is wrong.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', 'public');
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEVPORT = Number(process.env.ADMIN_MEASURE_PORT || 9420);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The pages, named below rather than counted. login.html is not one of them:
 * it is the signed-out door, has no nav, and moved onto tokens at S4 under a
 * different set of rules. */
const ALL_PAGES = [
  'tenants.html', 'tenant-new.html', 'tenant-detail.html', 'conversations.html',
];

/* 1440 and 1024 are the pair Phase A reported and the pair the founder scores
 * against. 1280 is the commonest real laptop. 768 is where the eight-item bar
 * stops fitting on one row and the wrap rule has to take over, so it is the
 * width every alignment claim is most likely to be wrong at. */
const DEFAULT_WIDTHS = [1440, 1280, 1024, 768];
/* The overflow mode's widths go further down, because the defect it exists to
 * catch — a horizontal scrollbar on the whole document — was invisible above
 * 480 and is what the pre-A1 bar did at 380 on every page. */
const OVERFLOW_WIDTHS = [768, 640, 380, 320];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json',
};

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel);
      if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
        res.writeHead(403).end(); return;
      }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

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
  /* Unlike scripts/portal/shoot.js's CDP.send, this one has a deadline on every
   * call. That file's `send` has none, which is how it wedged for 33 minutes. */
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP timeout: ' + method));
      }, 30000);
    });
  }
}

async function connectBrowser() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEVPORT}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint never came up on ' + DEVPORT);
}

const openWs = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.onopen = () => resolve(ws);
  ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));
});

/* ── The probes. Each is a self-contained expression evaluated in the page. ── */

const GEOMETRY = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return {
    l: +r.left.toFixed(2), r: +r.right.toFixed(2), t: +r.top.toFixed(2),
    b: +r.bottom.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; };
  const out = { vw: window.innerWidth, scrollW: document.documentElement.scrollWidth };

  const nav = document.querySelector('nav');
  const cs = getComputedStyle(nav);
  out.nav = { box: R(nav), h: +nav.getBoundingClientRect().height.toFixed(2),
              padL: cs.paddingLeft, padR: cs.paddingRight, gap: cs.gap,
              bg: cs.backgroundColor, wrap: cs.flexWrap };
  const items = [...nav.querySelectorAll('a')];
  let prev = null;
  out.navItems = items.map((a) => {
    const b = R(a); const c = getComputedStyle(a);
    const gapBefore = prev === null ? null : +(b.l - prev).toFixed(2);
    prev = b.r;
    return { text: a.textContent.trim(), cls: a.className || null,
             current: a.getAttribute('aria-current') || null, box: b,
             gapBefore, color: c.color, fs: c.fontSize, fw: c.fontWeight };
  });
  out.brandL = out.navItems[0].box.l;
  out.logoutR = out.navItems[out.navItems.length - 1].box.r;

  /* The content column, under either of its two names. */
  const col = document.querySelector('main.content') || document.querySelector('.container');
  const ccs = getComputedStyle(col);
  const padL = parseFloat(ccs.paddingLeft), padR = parseFloat(ccs.paddingRight);
  const cb = R(col);
  out.content = { cls: col.className || col.tagName.toLowerCase(), box: cb,
                  maxW: ccs.maxWidth, padL, padR,
                  railL: +(cb.l + padL).toFixed(2), railR: +(cb.r - padR).toFixed(2) };

  /* The page title: the .page-head__title that is actually rendered.
   * conversations.html carries more than one (a header per view), so this
   * takes the visible one rather than the first. */
  const titles = [...document.querySelectorAll('.page-head__title')];
  const t = titles.find((h) => h.getClientRects().length) || titles[0] || null;
  if (t) {
    const tcs = getComputedStyle(t);
    out.title = { tag: t.tagName, id: t.id || null, text: t.textContent.trim().slice(0, 60),
                  box: R(t), fs: tcs.fontSize, fw: tcs.fontWeight, color: tcs.color };
  }
  const heads = [...document.querySelectorAll('.page-head')];
  const ph = heads.find((h) => h.getClientRects().length) || heads[0] || null;
  if (ph) out.head = { box: R(ph), children: [...ph.children].map((c) =>
    c.tagName.toLowerCase() + (c.className ? '.' + String(c.className).trim().split(/\\s+/).join('.') : '')) };

  /* The two numbers the whole shell exists to make zero. */
  out.alignBrand = out.title ? +(out.brandL - out.title.box.l).toFixed(2) : null;
  out.alignLogout = +(out.logoutR - out.content.railR).toFixed(2);
  return out;
})()`;

const OVERFLOW = `(() => ({
  vw: window.innerWidth,
  scrollW: document.documentElement.scrollWidth,
  bodyScrollW: document.body.scrollWidth,
  navH: +document.querySelector('nav').getBoundingClientRect().height.toFixed(2),
  overflow: document.documentElement.scrollWidth > window.innerWidth,
}))()`;

/* ── Focus ───────────────────────────────────────────────────────────────────
 * Read the way a keyboard operator meets it: walk the page with real Tab
 * keystrokes dispatched through the browser's input pipeline, and at each stop
 * read what actually paints on the element that actually has focus.
 *
 * Two things this gets right that the obvious version does not.
 *
 * SCRIPTED .focus() IS NOT KEYBOARD FOCUS. :focus-visible has a heuristic, and
 * an element focused from script does not reliably match it. Dispatching Tab
 * does, so the ring this reads is the ring a person sees.
 *
 * AN OUTLINE IS NOT THE ONLY RING. tokens.css deliberately suppresses the
 * outline on .input (tokens.css:295) because the field sits in a flex row where
 * an outline would overlap its neighbour, and paints a box-shadow glow instead.
 * A probe that only looks at outline scores those fields BARE when they are
 * fully dressed — it read "4 BARE" on tenant-new before this was fixed, all
 * four of them .input. So an element counts as ringed if its outline paints OR
 * its box-shadow CHANGES from its own resting value. That is also the model
 * core.js judgeRing uses: an outline layer and a glow layer, either of which
 * can carry the indicator. */

/* Pass 1: tag every visible focusable and record what it looks like at rest. */
const TAG_RESTING = `(() => {
  const SEL = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),summary';
  const vis = (e) => {
    const s = getComputedStyle(e);
    return s.display !== 'none' && s.visibility !== 'hidden' && !e.disabled
      && e.getClientRects().length > 0;
  };
  const els = [...document.querySelectorAll(SEL)].filter(vis);
  window.__fx = [];
  els.forEach((el, i) => {
    el.setAttribute('data-fx', String(i));
    const s = getComputedStyle(el);
    window.__fx.push({
      i, tag: el.tagName.toLowerCase(), id: el.id || null,
      label: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 26),
      inNav: !!el.closest('nav'),
      restShadow: s.boxShadow, restOutline: s.outlineStyle + ' ' + s.outlineWidth,
      seen: false, authored: false, ring: null,
    });
  });
  return els.length;
})()`;

/* Pass 2, once per Tab: score whatever now holds focus. */
const READ_ACTIVE = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || !el.hasAttribute('data-fx')) return null;
  const i = Number(el.getAttribute('data-fx'));
  const rec = window.__fx[i];
  if (!rec || rec.seen) return { i, dup: true };
  const s = getComputedStyle(el);
  const outline = s.outlineStyle !== 'none' && s.outlineWidth !== '0px' && s.outlineStyle !== 'auto';
  const glow = s.boxShadow !== rec.restShadow && s.boxShadow !== 'none';
  rec.seen = true;
  rec.authored = outline || glow;
  rec.ring = (outline ? 'outline ' + s.outlineWidth + ' ' + s.outlineColor + ' @' + s.outlineOffset : '')
    + (outline && glow ? ' | ' : '')
    + (glow ? 'glow ' + s.boxShadow : '')
    + (!outline && !glow ? (s.outlineStyle === 'auto' ? 'UA default (outline:auto)' : 'NONE') : '');
  return { i, tag: rec.tag, id: rec.id, authored: rec.authored, ring: rec.ring };
})()`;

const FOCUS_REPORT = `(() => {
  const rows = window.__fx.map((r) => ({
    tag: r.tag, id: r.id, label: r.label, inNav: r.inNav,
    reached: r.seen, authored: r.authored, ring: r.ring,
  }));
  return {
    total: rows.length,
    reached: rows.filter((r) => r.reached).length,
    authored: rows.filter((r) => r.authored).length,
    bare: rows.filter((r) => r.reached && !r.authored).map((r) => r.tag + (r.id ? '#' + r.id : '') + ' — ' + r.ring),
    rows,
  };
})()`;

const SHOW_DETAIL = `(() => {
  const nf = document.getElementById('notFound'); if (nf) nf.style.display = 'none';
  const d = document.getElementById('detail');
  /* The literal string 'block', matching tenant-detail.js:46 and the assertion
   * scripts/portal/shoot.js:2553 makes against it. Never a class. */
  if (d) d.style.display = 'block';
  return !!d;
})()`;

async function main() {
  const mode = arg('mode', 'geometry');
  const pages = arg('pages', '').trim()
    ? arg('pages').split(',').map((p) => (p.endsWith('.html') ? p : p + '.html'))
    : ALL_PAGES;
  const widths = arg('widths', '').trim()
    ? arg('widths').split(',').map(Number)
    : (mode === 'overflow' ? OVERFLOW_WIDTHS : DEFAULT_WIDTHS);
  const showDetail = !process.argv.includes('--no-show-detail');
  const jsonOut = arg('json', '');

  const { server, port } = await serve();
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-measure-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${DEVPORT}`, `--user-data-dir=${udd}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--force-prefers-reduced-motion=reduce', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  const results = {};
  try {
    ws = await openWs(await connectBrowser());
    const cdp = new CDP(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);

    const modes = mode === 'all' ? ['geometry', 'overflow', 'focus'] : [mode];

    for (const m of modes) {
      const ws2 = m === 'overflow' && !arg('widths', '') ? OVERFLOW_WIDTHS : widths;
      console.log('\n' + '='.repeat(78));
      console.log(m.toUpperCase() + '   pages=' + pages.length + '   widths=' + ws2.join(','));
      console.log('='.repeat(78));
      results[m] = {};

      for (const w of ws2) {
        console.log('\n─── viewport ' + w + ' ───');
        for (const page of pages) {
          await cdp.send('Emulation.setDeviceMetricsOverride',
            { width: w, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
          await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/admin/${page}` }, sid);
          for (let i = 0; i < 120; i++) {
            const r = await cdp.send('Runtime.evaluate',
              { expression: 'document.readyState === "complete"', returnByValue: true }, sid);
            if (r.result.value) break;
            await sleep(70);
          }
          await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }, sid);
          await sleep(200);

          let forced = false;
          if (page === 'tenant-detail.html' && showDetail) {
            await cdp.send('Runtime.evaluate', { expression: SHOW_DETAIL, returnByValue: true }, sid);
            await sleep(120);
            forced = true;
          }

          let v;
          if (m === 'focus') {
            v = await focusWalk(cdp, sid);
          } else if (m === 'shot') {
            v = await capture(cdp, sid, page, w, arg('out', '.'));
          } else {
            const expr = m === 'geometry' ? GEOMETRY : OVERFLOW;
            const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
            v = r.result.value;
          }
          v.forced = forced;
          (results[m][page] = results[m][page] || {})[w] = v;
          print(m, page, v);
        }
      }
    }
  } finally {
    try { if (ws) ws.close(); } catch (_) { /* closing a dead socket */ }
    try { chrome.kill(); } catch (_) { /* already gone */ }
    server.close();
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
    console.log('\nwrote ' + jsonOut);
  }
  return results;
}

/* Tab through the page for real. The walk runs a few strides past the tagged
 * count because focus leaves the document at the end of the order and comes
 * back round; duplicates are ignored, so the extra strides cost nothing and a
 * short walk would silently under-report. */
async function focusWalk(cdp, sid) {
  const tagged = await cdp.send('Runtime.evaluate',
    { expression: TAG_RESTING, returnByValue: true }, sid);
  const n = tagged.result.value;
  for (let i = 0; i < n + 4; i++) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent',
        { type, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab' }, sid);
    }
    await cdp.send('Runtime.evaluate', { expression: READ_ACTIVE, returnByValue: true }, sid);
  }
  const rep = await cdp.send('Runtime.evaluate', { expression: FOCUS_REPORT, returnByValue: true }, sid);
  return rep.result.value;
}

/* A picture, for a person. Full-page, so nothing below the fold is hidden from
 * whoever is scoring it. Never diffed against anything — see the file header. */
async function capture(cdp, sid, page, width, outDir) {
  const m = await cdp.send('Page.getLayoutMetrics', {}, sid);
  const h = Math.ceil(m.cssContentSize ? m.cssContentSize.height : m.contentSize.height);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height: h, deviceScaleFactor: 1, mobile: false }, sid);
  await sleep(250);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${page.replace('.html', '')}-${width}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return { file, width, height: h, bytes: fs.statSync(file).size };
}

function print(mode, page, v) {
  const name = page.replace('.html', '').padEnd(15);
  const flag = v.forced ? ' [FORCED #detail]' : '';
  if (mode === 'shot') {
    console.log(`  ${name} ${v.width}x${v.height}  ${(v.bytes / 1024).toFixed(0)}kB  ${v.file}${flag}`);
    return;
  }
  if (mode === 'geometry') {
    const ok = (n) => (n === 0 ? 'OK  ' : 'DIFF');
    console.log(`  ${name} bar h=${String(v.nav.h).padStart(5)}  brand.l=${String(v.brandL).padStart(7)}`
      + `  title.l=${String(v.title ? v.title.box.l : '—').padStart(7)}`
      + `  ${ok(v.alignBrand)} ${String(v.alignBrand).padStart(6)}`
      + `   logout.r=${String(v.logoutR).padStart(7)}  rail.r=${String(v.content.railR).padStart(7)}`
      + `  ${ok(v.alignLogout)} ${String(v.alignLogout).padStart(6)}${flag}`);
  } else if (mode === 'overflow') {
    console.log(`  ${name} vw=${String(v.vw).padStart(5)}  scrollW=${String(v.scrollW).padStart(5)}`
      + `  navH=${String(v.navH).padStart(6)}  ${v.overflow ? '*** H-OVERFLOW ***' : 'clean'}${flag}`);
  } else {
    console.log(`  ${name} focusables=${String(v.total).padStart(3)}`
      + `  reached=${String(v.reached).padStart(3)}`
      + `  authored ring=${String(v.authored).padStart(3)}`
      + `  ${v.authored === v.total ? 'ALL' : '*** ' + (v.total - v.authored) + ' BARE ***'}${flag}`);
    for (const b of v.bare) console.log('        BARE: ' + b);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { main, ALL_PAGES, GEOMETRY, OVERFLOW, TAG_RESTING, READ_ACTIVE };
