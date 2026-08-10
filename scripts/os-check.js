'use strict';

// os-check — is docs/os/state.md still true at HEAD?
//
// A commit cannot record its own sha, so `Verified-at` always names an ancestor.
// The rule that makes that sound: a verification stays valid while nothing
// OUTSIDE the exempt paths below has changed since. Any src/, tests/ or
// package.json commit invalidates it immediately, which is the drift this exists
// to catch.
//
// ── WHAT "GREEN" MEANS HERE (RAG Session 3, D-011) ───────────────────────────
// It used to mean `# fail 0`, and that was not enough. `# fail` counts ONE of
// the three ways a test can end without passing, and the other two are the ones
// a broken run actually produces:
//
//   • CANCELLED. A per-test timeout is reported `not ok` and counted under
//     `# cancelled`, not `# fail` — verified this session. So is every sibling
//     of a failed `before` hook (`failureType: 'cancelledByParent'`): a hook
//     that throws yields `# fail 0, # cancelled N`. Session 2 hit this for real
//     — an unbounded call draining the event loop reported `# cancelled 4,
//     # fail 0`. A gate reading only `# fail` calls that run green.
//   • SKIPPED. A skipped `it()` is reported `ok … # SKIP` and counted under
//     `# skipped`, again never `# fail`, and it still counts toward `# tests` —
//     so even the recorded total cannot see it.
//
// Both are now gate conditions, and both are NAMED rather than counted, for the
// same reason the failure names were added below.
//
// ONE ASYMMETRY WORTH KNOWING, because it is not guessable: a skipped SUITE
// (`describe(name, { skip })` — the shape every DB-dependent suite here uses
// when DATABASE_URL is unset) does NOT increment `# skipped`. Its children are
// not reported at all, so they vanish from `# tests` instead. That case is
// caught by the recorded-total comparison further down, not by the counter —
// but a run that silently drops 600 tests deserves to be named, so SKIP
// directives are gated whether they sit on a test or on a suite.

const { execSync, spawnSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const { join, relative } = require('path');

const root = join(__dirname, '..');
const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8' }).trim();

const LOG_FILE = '.os-check-last.log';

// Paths whose contents cannot invalidate a verification.
//   docs/os/      — IS the record being verified.
//   docs/prompts/ — an issue prompt is an input to a FUTURE session, not a
//                   description of current state, so it cannot move a test count
//                   or falsify a line in state.md. Committing one turned this
//                   script red on a file that asserts nothing (a797d144).
// Deliberately NOT all of docs/: an audit or architecture doc DOES describe
// current state and must keep invalidating. See D-008 in docs/os/decisions.md.
const EXEMPT = ['docs/os/', 'docs/prompts/'];

// The `failureType` values node:test attaches to a `not ok` leaf that was
// CANCELLED rather than failed. Both observed directly this session on
// v22.17.1: a per-test `{ timeout }` expiry gives `testTimeoutFailure`, and a
// throwing `before` hook gives every sibling `cancelledByParent`. Neither is
// counted by `# fail`.
const CANCELLED_FAILURE_TYPES = new Set(['testTimeoutFailure', 'cancelledByParent']);

// --- naming the failures -----------------------------------------------------
//
// `# fail N` is a count and nothing else, and this script used to discard the
// stream it was counted from — so a red run said "2 failing" and the two names
// were unrecoverable. They are in the same output. The TAP reporter (node:test
// runs under it here because stdout is a pipe, not a TTY) prints every failure
// as `not ok <n> - <name>` followed by a YAML block carrying `type` and
// `location`.
//
// `type: 'test'` is a leaf; `type: 'suite'` is an ancestor that failed only
// because a child did, and `# fail` does not count those — so neither do we, or
// one broken test would be reported three times over.

const unTap = (s) => s.replace(/\\(.)/g, '$1');            // TAP escapes \ and #
const unYaml = (s) => s.replace(/''/g, "'").replace(/\\\\/g, '\\');

// The key: value pairs at exactly `indent`, up to the block's `...` terminator.
// Anything deeper is the body of an `error: |-` or `stack: |-` block and is skipped.
function yamlBlock(lines, start, indent) {
  const pad = ' '.repeat(indent);
  const meta = {};
  if (lines[start + 1] !== `${pad}---`) return meta;
  for (let i = start + 2; i < lines.length; i++) {
    if (lines[i] === `${pad}...`) break;
    if (!lines[i].startsWith(pad) || lines[i][indent] === ' ') continue;
    const kv = lines[i].slice(indent).match(/^(\w+): '(.*)'$/);
    if (kv && !(kv[1] in meta)) meta[kv[1]] = unYaml(kv[2]);
  }
  return meta;
}

// Every `not ok` LEAF — which is both the failures and the cancellations, since
// node reports them identically and separates them only by `failureType`.
function notOkLeaves(tap) {
  const lines = tap.split(/\r?\n/);
  const enclosing = [];   // `# Subtest:` names, indexed by nesting depth
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const sub = lines[i].match(/^( *)# Subtest: (.*)$/);
    if (sub) {
      const depth = sub[1].length / 4;
      enclosing.length = depth;
      enclosing[depth] = unTap(sub[2]);
      continue;
    }
    const bad = lines[i].match(/^( *)not ok \d+ - (.*)$/);
    if (!bad) continue;
    const meta = yamlBlock(lines, i, bad[1].length + 2);
    if (meta.type !== 'test') continue;
    found.push({
      name: unTap(bad[2]),
      where: meta.location ? relative(root, meta.location).replace(/\\/g, '/') : '',
      under: enclosing.slice(0, bad[1].length / 4).filter(Boolean),
      failureType: meta.failureType || '',
      cancelled: CANCELLED_FAILURE_TYPES.has(meta.failureType),
    });
  }
  return found;
}

// Every line carrying a `# SKIP` directive, on a test OR a suite. The negative
// lookbehind matters: TAP escapes a `#` inside a test NAME as `\#`, so an
// unescaped ` # SKIP` is the directive and nothing else is.
function skipDirectives(tap) {
  const lines = tap.split(/\r?\n/);
  const enclosing = [];
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const sub = lines[i].match(/^( *)# Subtest: (.*)$/);
    if (sub) {
      const depth = sub[1].length / 4;
      enclosing.length = depth;
      enclosing[depth] = unTap(sub[2]);
      continue;
    }
    const m = lines[i].match(/^( *)(?:not )?ok \d+ - (.*?)(?<!\\) # SKIP(?: (.*))?$/);
    if (!m) continue;
    const meta = yamlBlock(lines, i, m[1].length + 2);
    found.push({
      name: unTap(m[2]),
      reason: m[3] ? unTap(m[3]) : '',
      kind: meta.type || 'test',
      where: meta.location ? relative(root, meta.location).replace(/\\/g, '/') : '',
      under: enclosing.slice(0, m[1].length / 4).filter(Boolean),
    });
  }
  return found;
}

const label = (f) => `${f.where ? `${f.where} — ` : ''}${[...f.under, f.name].join(' › ')}`;

/**
 * The whole verdict on one suite run, as a list of failure strings (empty ⇒ the
 * run is green). Pure: it reads the captured stdout and nothing else, which is
 * what makes it assertable against a constructed cancelled/skipped run instead
 * of only against whatever `npm test` happens to produce.
 *
 * @param {string} out       the suite's stdout (TAP)
 * @param {{tests: string, suites: string}} expected  the totals state.md records
 * @param {string} [logged]  filename the full output was written to, for messages
 */
function suiteGate(out, expected, logged = '') {
  const fail = [];
  const seeLog = logged ? `; full output in ${logged}` : '';
  const got = (re) => (out.match(re) || [])[1];
  const actual = {
    tests: got(/^# tests (\d+)$/m),
    suites: got(/^# suites (\d+)$/m),
    fails: got(/^# fail (\d+)$/m),
    cancelled: got(/^# cancelled (\d+)$/m),
    skipped: got(/^# skipped (\d+)$/m),
  };

  if (actual.tests === undefined) {
    fail.push('could not parse `# tests N` from the suite output' + (logged ? ` — read ${logged}` : ''));
    return fail;
  }

  const leaves = notOkLeaves(out);

  if (actual.fails !== '0') {
    const named = leaves.filter((f) => !f.cancelled).map(label);
    // Names and count come from the same stream, so they normally agree. A
    // cancelled test is `not ok` without being `# fail`, so say which is which
    // rather than let the list quietly outrank the number.
    if (named.length !== Number(actual.fails)) {
      named.push(`(${named.length} named, ${actual.fails} counted as failing${seeLog})`);
    }
    if (!named.length) named.push(logged ? `(no names parsed — read ${logged})` : '(no names parsed)');
    fail.push(`suite is red: ${actual.fails} failing\n    ` + named.join('\n    '));
  }

  // A counter that cannot be read is not a zero. Refusing here is the whole
  // point of this block: the previous gate was green on conditions it could not
  // see, and an unparseable counter is exactly that condition again.
  if (actual.cancelled === undefined) {
    fail.push('could not parse `# cancelled N` from the suite output' + (logged ? ` — read ${logged}` : ''));
  } else if (actual.cancelled !== '0') {
    const named = leaves.filter((f) => f.cancelled)
      .map((f) => `${label(f)}  [${f.failureType}]`);
    if (named.length !== Number(actual.cancelled)) {
      named.push(`(${named.length} named, ${actual.cancelled} counted as cancelled${seeLog})`);
    }
    if (!named.length) named.push(logged ? `(no names parsed — read ${logged})` : '(no names parsed)');
    fail.push(
      `suite has CANCELLED tests: ${actual.cancelled} (a cancelled test never reaches \`# fail\`)\n    ` +
      named.join('\n    '));
  }

  if (actual.skipped === undefined) {
    fail.push('could not parse `# skipped N` from the suite output' + (logged ? ` — read ${logged}` : ''));
  } else {
    const skips = skipDirectives(out);
    if (actual.skipped !== '0' || skips.length) {
      const named = skips.map((s) =>
        `${label(s)}  [${s.kind}${s.reason ? `: ${s.reason}` : ''}]`);
      if (named.length !== Number(actual.skipped)) {
        // Not necessarily a discrepancy: a skipped SUITE carries a directive but
        // is not counted by `# skipped`. Say so rather than imply a parse bug.
        named.push(`(${named.length} directive(s) named, ${actual.skipped} counted as skipped` +
          ' — a skipped suite is named but never counted' + seeLog + ')');
      }
      fail.push(`suite has SKIPPED tests: ${actual.skipped} counted\n    ` + named.join('\n    '));
    }
  }

  if (actual.tests !== expected.tests) {
    fail.push(`tests: state.md says ${expected.tests}, suite reports ${actual.tests}`);
  }
  if (actual.suites !== expected.suites) {
    fail.push(`suites: state.md says ${expected.suites}, suite reports ${actual.suites}`);
  }
  return fail;
}

function main() {
  const state = readFileSync(join(root, 'docs/os/state.md'), 'utf8');
  const fail = [];

  const verifiedAt = (state.match(/^Verified-at:\s*([0-9a-f]{40})\s*$/m) || [])[1];
  const head = git('rev-parse HEAD');

  if (!verifiedAt) {
    fail.push('state.md has no `Verified-at: <40-char sha>` line');
  } else if (verifiedAt !== head) {
    const changed = git(`diff --name-only ${verifiedAt}..${head}`)
      .split('\n').filter((f) => f && !EXEMPT.some((p) => f.startsWith(p)));
    if (changed.length) {
      fail.push(
        `state.md verified at ${verifiedAt.slice(0, 8)}, HEAD is ${head.slice(0, 8)}; ` +
        `${changed.length} file(s) changed outside ${EXEMPT.join(', ')}:\n    ` +
        changed.slice(0, 10).join('\n    ')
      );
    }
  }

  const recorded = state.match(/\*\*(\d+) tests \/ (\d+) suites \/ (\d+) fail\*\*/);
  if (!recorded) {
    fail.push('state.md has no `**N tests / N suites / N fail**` line');
  } else {
    console.log('running the suite...');
    const run = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8', shell: true });
    const out = run.stdout || '';
    const err = run.stderr || '';

    // Both streams, kept whole. spawnSync pipes them separately so the true
    // interleaving is not recoverable; they are sectioned rather than guessed at.
    let logged = '';
    try {
      writeFileSync(join(root, LOG_FILE), out + (err ? `\n===== stderr =====\n${err}` : ''));
      logged = LOG_FILE;
      console.log(`suite output: ${LOG_FILE}`);
    } catch (e) {
      console.warn(`could not write ${LOG_FILE}: ${e.message}`);
    }

    fail.push(...suiteGate(out, { tests: recorded[1], suites: recorded[2] }, logged));
  }

  if (fail.length) {
    console.error('\nos-check FAILED\n' + fail.map((f) => `  - ${f}`).join('\n') +
      '\n\nUpdate docs/os/state.md and refresh Verified-at.\n');
    process.exit(1);
  }
  console.log('os-check OK — state.md matches HEAD.');
}

module.exports = { notOkLeaves, skipDirectives, suiteGate, CANCELLED_FAILURE_TYPES };

if (require.main === module) main();
