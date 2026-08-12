'use strict';

// Issue 39 — a listen failure must be loud, not logged as a successful boot.
//
// REAL RUNTIME EVIDENCE, NOT A MOCK. Every assertion below reads the output and
// exit status of an actual `node server.js` child process. Nothing is stubbed;
// the only thing this file fakes is the environment the child is given.
//
// ── WHY THIS TEST EXISTS ─────────────────────────────────────────────────────
// Express 5 registers the callback passed to `app.listen` on BOTH outcomes
// (node_modules/express/lib/application.js:598-606):
//
//     var done = args[args.length - 1] = once(args[args.length - 1])
//     server.once('error', done)
//
// so `app.listen(PORT, HOST, () => logger.info('server started'))` logged a
// successful boot on a FAILED bind, and the `once('error')` swallowed the event
// so node's unhandled-'error' throw never fired and the process never exited.
// Measured at c222006: a second `node server.js` on a held port logged
// `server started`, was still running after 45,015 ms, and never named
// EADDRINUSE — while netstat showed one listener, owned by the FIRST process,
// which answered every request.
//
// ── WHY THE CONTROL RUN IS NOT OPTIONAL ──────────────────────────────────────
// The headline assertion is a NEGATIVE one: the success log must be ABSENT. A
// child that dies for any unrelated reason — a missing env var, a bad cwd, a
// syntax error — satisfies it vacuously. Two things stand against that:
//   • the clean-port control run, which proves this harness CAN boot the server
//     and see its success log, so absence in the blocked run means something;
//   • an explicit assertion that the blocked child failed on the BIND and not
//     on its environment.
//
// ── HERMETIC CHILD ───────────────────────────────────────────────────────────
// `server.js:1` is `require('dotenv').config()`, whose default path is
// `path.resolve(process.cwd(), '.env')` (node_modules/dotenv/lib/main.js). The
// children therefore run with cwd set to a FRESH EMPTY DIRECTORY, so a
// developer's `.env` cannot reach them and the environment is exactly what this
// file passes. Nothing in `src/` reads `process.cwd()`, and every require in
// server.js is relative to `__dirname`, so moving cwd changes nothing else.
//
// EMBED_WARMUP=false because a booted child otherwise fires a live embedding
// call against a dev Gemini key documented at ~20/day. DATABASE_URL points
// nowhere on purpose: the pg Pool is lazy and nothing on the boot path queries.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '../../server.js');

// Generous: the child loads express, pg and the whole module graph. The blocked
// child exits in ~823 ms and the clean one logs success in ~700 ms, both
// measured. This is the bound that turns a hang into a NAMED failure rather
// than letting node:test cancel the test — a cancelled test never reaches
// `# fail` (scripts/os-check.js).
const BOOT_TIMEOUT_MS = 30_000;

// Copied through from the real environment so the child can start at all;
// everything else it sees is declared below. Windows needs SystemRoot for
// process startup, and node needs a PATH to resolve nothing in particular but
// its absence has surprised us before.
const OS_PASSTHROUGH = [
  'PATH', 'Path', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'LANG',
];

function childEnv(extra) {
  const env = {
    // env.js REQUIRES all seven. A child missing one exits 1 before it ever
    // reaches app.listen, which would pass the negative assertion for the wrong
    // reason — see `failed on the bind, not on its environment` below.
    DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/zyon_listen_test',
    GEMINI_API_KEY: 'test-key',
    WEBHOOK_VERIFY_TOKEN: 'test-verify',
    META_APP_SECRET: 'test-secret',
    ENCRYPTION_KEY: 'a'.repeat(64),
    ADMIN_PASSWORD: 'admin123',
    SESSION_SECRET: 's'.repeat(32),
    EMBED_WARMUP: 'false',
    ...extra,
  };
  for (const key of OS_PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Hold a port for real, on the same wildcard address the server binds. */
function holdPort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '0.0.0.0', () => resolve(socket));
  });
}

/** An ephemeral port nothing is listening on. */
async function freePort() {
  const socket = await holdPort();
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

/**
 * Spawn `node server.js` and watch it.
 *
 * @param {number} port
 * @param {'exit'|'started'} until  'exit' waits for the process to end;
 *                                  'started' waits for the success log, then kills.
 */
function runServer(port, until, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SERVER], {
      cwd,
      env: childEnv({ PORT: String(port), HOST: '0.0.0.0' }),
    });

    let out = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ out, ms: Date.now() - started, ...result });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, signal: null, exited: false, timedOut: true });
    }, BOOT_TIMEOUT_MS);

    const onData = (buf) => {
      out += buf.toString();
      if (until === 'started' && out.includes('server started')) {
        // Give the process a moment to emit anything that would follow the
        // success line before we take it away, so `exactly once` is a real
        // count rather than a race against the kill.
        setTimeout(() => child.kill(), 250);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => finish({ code: null, signal: null, exited: false, spawnError: err.message }));
    child.on('exit', (code, signal) => finish({ code, signal, exited: true, timedOut: false }));
  });
}

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * The argument text of the real `app.listen(...)` CALL, to its matching close
 * paren. Two ways this went wrong before it worked, both caught by running the
 * mutations rather than by reading it:
 *
 *  1. A naive /app\.listen\(([^)]*)\)/ stops at the FIRST `)`, so
 *     `app.listen(PORT, HOST, () => {` captures `PORT, HOST, () ` — the arrow
 *     falls outside the group. Hence the balanced scan.
 *  2. The first `app.listen(` in the file is inside the comment above the call
 *     — including the literal `app.listen()`, whose balanced scan returns the
 *     empty string, which contains no callback and passes VACUOUSLY. Hence
 *     skipping comment lines. The assertion below that the args mention PORT is
 *     what keeps that failure mode from coming back silently.
 */
function listenArgs(src) {
  const lines = src.split('\n');
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    const at = line.indexOf('app.listen(');
    if (at !== -1 && !isComment) {
      const from = offset + at + 'app.listen('.length;
      let depth = 1;
      for (let i = from; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')' && --depth === 0) return src.slice(from, i);
      }
    }
    offset += line.length + 1;
  }
  return null;
}

describe('server.js — a listen failure is loud, not a successful boot (Issue 39)', () => {
  let cwd;
  let holder;
  let heldPort;
  let blocked;   // a child pointed at a port this test process is holding
  let clean;     // the control: a child pointed at a free port

  before(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zyon-listen-'));
    holder = await holdPort();
    heldPort = holder.address().port;

    blocked = await runServer(heldPort, 'exit', cwd);
    clean = await runServer(await freePort(), 'started', cwd);
  });

  after(async () => {
    if (holder) await new Promise((resolve) => holder.close(resolve));
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  // THE ACTUAL BUG. Before the fix this line was emitted by a process that had
  // bound nothing, while a stale process kept serving the port.
  it('does NOT log "server started" when the bind fails', () => {
    assert.equal(
      occurrences(blocked.out, 'server started'), 0,
      `a child that failed to bind :${heldPort} claimed it started:\n${blocked.out}`
    );
  });

  it('exits non-zero, within the timeout', () => {
    assert.equal(blocked.timedOut, false,
      `child never exited within ${BOOT_TIMEOUT_MS} ms — it is the zombie this fixes:\n${blocked.out}`);
    assert.equal(blocked.exited, true, `child did not exit: ${JSON.stringify(blocked)}`);
    assert.notEqual(blocked.code, 0,
      `expected a non-zero exit, got ${blocked.code}:\n${blocked.out}`);
  });

  it('logs the failure, naming the error code and the port', () => {
    assert.match(blocked.out, /server failed to bind/,
      `the failure was not logged at all:\n${blocked.out}`);
    assert.match(blocked.out, /EADDRINUSE/,
      `the log does not name the error code:\n${blocked.out}`);
    assert.ok(blocked.out.includes(String(heldPort)),
      `the log does not name the port ${heldPort}:\n${blocked.out}`);
  });

  // Anti-vacuity. Without this, ANY early death — a missing env var, a bad cwd —
  // would satisfy the two assertions above.
  it('failed on the bind, not on its environment', () => {
    assert.doesNotMatch(blocked.out, /missing required env var/,
      `the child died in env.js, so it never reached app.listen:\n${blocked.out}`);
    assert.ok(blocked.out.includes('reminder cron started'),
      `the child did not reach the end of the boot path, so the bind is not what stopped it:\n${blocked.out}`);
  });

  // The control. This is what makes the negative assertions above mean
  // something: the same harness, the same env, a free port.
  it('control: a free port still boots and logs "server started" exactly once', () => {
    assert.equal(clean.timedOut, false,
      `the control child never logged success — the harness cannot boot the server, ` +
      `so the negative assertions above prove nothing:\n${clean.out}`);
    assert.equal(
      occurrences(clean.out, 'server started'), 1,
      `expected the success log exactly once:\n${clean.out}`
    );
    assert.doesNotMatch(clean.out, /server failed to bind/,
      `a clean boot logged a bind failure:\n${clean.out}`);
  });

  // The runtime tests above would catch a reintroduced callback too, but they
  // would report it as "the success log appeared" and leave the next developer
  // to rediscover why. This one fails naming the mechanism.
  //
  // Residual, stated rather than hidden: this catches an inline callback, which
  // is the shape a reintroduction actually takes (the old line copied back). A
  // callback passed by NAME — `app.listen(PORT, HOST, onListen)` — would slip
  // past it, and is left to the four runtime assertions above.
  it('app.listen is called without a callback (express registers it on error too)', () => {
    const args = listenArgs(fs.readFileSync(SERVER, 'utf8'));
    assert.ok(args !== null, 'server.js no longer calls app.listen(...)');
    // Anti-vacuity: an earlier version of this scan read the COMMENT above the
    // call and asserted against an empty string.
    assert.ok(args.includes('PORT'),
      `the scan did not find the real call — it read \`app.listen(${args})\``);
    assert.doesNotMatch(
      args, /=>|function/,
      'server.js passes a callback to app.listen. Express 5 registers it on the ' +
      "'error' event as well (node_modules/express/lib/application.js:598-606), so it " +
      'fires on a FAILED bind and swallows the error. Attach the ' +
      "'listening' and 'error' listeners separately instead."
    );
  });
});
