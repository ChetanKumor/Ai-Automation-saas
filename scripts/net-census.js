'use strict';

// net-census — what does the test suite actually talk to?
//
// A preload that records EVERY outbound network attempt the process makes, so
// "the default arm makes no live external calls" is a MEASUREMENT and not a
// reading of the code. It exists because the claim it replaces was wrong: the
// header of tests/portal/portalFaqs.integration.test.js asserted that real
// Gemini calls were "reserved for ONE test", and a census over `npm test` found
// twelve, in three files.
//
//   # measure (bash). npm's own launcher rejects NODE_OPTIONS on Windows, so
//   # this runs `node --test` with the same arguments the `test` script uses.
//   CENSUS_OUT="$PWD/census.jsonl" node --test \
//     --require ./tests/_support/testEnv.js \
//     --require ./tests/_support/embedTransport.js \
//     --require ./scripts/net-census.js \
//     "tests/**/*.test.js"
//
//   # report
//   node scripts/net-census.js census.jsonl
//
// The report names every non-loopback host with a count and the test files that
// produced it. Zero external rows is the property the default arm must hold.
//
// WHAT IT RECORDS: hostname, path, the test file argv, and a trimmed stack.
// It deliberately drops the query string and never touches headers or bodies —
// an API key rides in a header or a query parameter on exactly these calls, and
// a census artifact that leaks one is worse than no census.
//
// It hooks three layers because one is not enough: `fetch` (what the Gemini SDK
// and undici use), `http`/`https` `request`/`get` (what pg's HTTP paths and the
// WhatsApp wrapper use), and `net.Socket.prototype.connect` (which catches
// anything dispatched below both, and is the reason a TLS connect shows up
// alongside the fetches that shared it).

const fs = require('fs');

const LOOPBACK = /^(127\.|::1|localhost|\[::1\])/;

function isPreload() { return !!process.env.CENSUS_OUT && require.main !== module; }

// ── recorder ────────────────────────────────────────────────────────────────
function installRecorder(out) {
  const stack = () => (new Error().stack || '').split('\n').slice(1)
    .map((l) => l.trim()).filter((l) => !/net-census\.js/.test(l)).slice(0, 8);

  const testFiles = () => process.argv.slice(1)
    .filter((a) => /\.test\.js$/.test(a))
    .map((a) => a.split(/[\\/]/).slice(-2).join('/'));

  const record = (kind, host, pathname) => {
    let line;
    try {
      line = JSON.stringify({
        pid: process.pid,
        kind,
        host,
        path: String(pathname || '').split('?')[0],   // query string DROPPED — may carry a key
        files: testFiles(),
        frames: stack(),
        t: Date.now(),
      });
    } catch (_) { return; }
    try { fs.appendFileSync(out, line + '\n'); } catch (_) { /* never break the suite */ }
  };

  if (typeof globalThis.fetch === 'function') {
    const orig = globalThis.fetch;
    globalThis.fetch = function (input) {
      try {
        const u = new URL(typeof input === 'string' ? input : (input && input.url) || String(input));
        record('fetch', u.host, u.pathname);
      } catch (_) { record('fetch', '(unparseable)', ''); }
      return orig.apply(this, arguments);
    };
  }

  for (const mod of ['http', 'https']) {
    const m = require(mod);
    for (const fn of ['request', 'get']) {
      const orig = m[fn];
      m[fn] = function (a) {
        try {
          if (typeof a === 'string' || a instanceof URL) {
            const u = new URL(String(a));
            record(`${mod}.${fn}`, u.host, u.pathname);
          } else if (a && typeof a === 'object') {
            record(`${mod}.${fn}`, a.host || a.hostname || '(none)', a.path || a.pathname || '');
          } else {
            record(`${mod}.${fn}`, '(unknown)', '');
          }
        } catch (_) { record(`${mod}.${fn}`, '(unparseable)', ''); }
        return orig.apply(this, arguments);
      };
    }
  }

  const net = require('net');
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (opts) {
    try {
      const o = (opts && typeof opts === 'object') ? opts : {};
      if (o.host && !LOOPBACK.test(String(o.host))) record('socket', `${o.host}:${o.port || ''}`, '');
    } catch (_) { /* ignore */ }
    return origConnect.apply(this, arguments);
  };
}

// ── report ──────────────────────────────────────────────────────────────────
function report(file) {
  const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);

  const external = recs.filter((r) => !LOOPBACK.test(String(r.host)));
  console.log(`${recs.length} outbound attempt(s) recorded, ${external.length} of them EXTERNAL\n`);

  if (!external.length) {
    console.log('  no non-loopback traffic — the default arm is clean.');
    return 0;
  }

  const byKey = new Map();
  for (const r of external) {
    const key = `${r.host}${r.path} [${r.kind}]  ${(r.files || []).join(',') || '(no test file in argv)'}`;
    byKey.set(key, (byKey.get(key) || 0) + 1);
  }
  for (const [k, v] of [...byKey].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  return external.length;
}

if (isPreload()) {
  installRecorder(process.env.CENSUS_OUT);
} else if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/net-census.js <census.jsonl>   (see the header for how to produce one)');
    process.exit(2);
  }
  report(file);
}

module.exports = { report, LOOPBACK };
