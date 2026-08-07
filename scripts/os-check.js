'use strict';

// os-check — is docs/os/state.md still true at HEAD?
//
// A commit cannot record its own sha, so `Verified-at` always names an ancestor.
// The rule that makes that sound: a verification stays valid while nothing
// OUTSIDE the exempt paths below has changed since. Any src/, tests/ or
// package.json commit invalidates it immediately, which is the drift this exists
// to catch.

const { execSync, spawnSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const { join, relative } = require('path');

const root = join(__dirname, '..');
const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8' }).trim();

const LOG_FILE = '.os-check-last.log';

const state = readFileSync(join(root, 'docs/os/state.md'), 'utf8');
const fail = [];

const verifiedAt = (state.match(/^Verified-at:\s*([0-9a-f]{40})\s*$/m) || [])[1];
const head = git('rev-parse HEAD');

// Paths whose contents cannot invalidate a verification.
//   docs/os/      — IS the record being verified.
//   docs/prompts/ — an issue prompt is an input to a FUTURE session, not a
//                   description of current state, so it cannot move a test count
//                   or falsify a line in state.md. Committing one turned this
//                   script red on a file that asserts nothing (a797d144).
// Deliberately NOT all of docs/: an audit or architecture doc DOES describe
// current state and must keep invalidating. See D-008 in docs/os/decisions.md.
const EXEMPT = ['docs/os/', 'docs/prompts/'];

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

function failingTests(tap) {
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
    });
  }
  return found;
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

  const got = (re) => (out.match(re) || [])[1];
  const actual = { tests: got(/^# tests (\d+)$/m), suites: got(/^# suites (\d+)$/m), fails: got(/^# fail (\d+)$/m) };
  if (actual.tests === undefined) {
    fail.push('could not parse `# tests N` from the suite output' + (logged ? ` — read ${logged}` : ''));
  } else {
    if (actual.fails !== '0') {
      const named = failingTests(out);
      const lines = named.map((f) =>
        `${f.where ? `${f.where} — ` : ''}${[...f.under, f.name].join(' › ')}`);
      // Names and count come from the same stream, so they normally agree. A
      // cancelled test is `not ok` without being `# fail`, so say which is which
      // rather than let the list quietly outrank the number.
      if (named.length !== Number(actual.fails)) {
        lines.push(`(${named.length} named, ${actual.fails} counted as failing` +
          `${logged ? `; full output in ${logged}` : ''})`);
      }
      if (!lines.length) lines.push(logged ? `(no names parsed — read ${logged})` : '(no names parsed)');
      fail.push(`suite is red: ${actual.fails} failing\n    ` + lines.join('\n    '));
    }
    if (actual.tests !== recorded[1]) fail.push(`tests: state.md says ${recorded[1]}, suite reports ${actual.tests}`);
    if (actual.suites !== recorded[2]) fail.push(`suites: state.md says ${recorded[2]}, suite reports ${actual.suites}`);
  }
}

if (fail.length) {
  console.error('\nos-check FAILED\n' + fail.map((f) => `  - ${f}`).join('\n') +
    '\n\nUpdate docs/os/state.md and refresh Verified-at.\n');
  process.exit(1);
}
console.log('os-check OK — state.md matches HEAD.');
