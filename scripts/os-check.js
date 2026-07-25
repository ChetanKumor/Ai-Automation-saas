'use strict';

// os-check — is docs/os/state.md still true at HEAD?
//
// A commit cannot record its own sha, so `Verified-at` always names an ancestor.
// The rule that makes that sound: a verification stays valid while nothing
// OUTSIDE docs/os/ has changed since. Any src/, tests/ or package.json commit
// invalidates it immediately, which is the drift this exists to catch.

const { execSync, spawnSync } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8' }).trim();

const state = readFileSync(join(root, 'docs/os/state.md'), 'utf8');
const fail = [];

const verifiedAt = (state.match(/^Verified-at:\s*([0-9a-f]{40})\s*$/m) || [])[1];
const head = git('rev-parse HEAD');

if (!verifiedAt) {
  fail.push('state.md has no `Verified-at: <40-char sha>` line');
} else if (verifiedAt !== head) {
  const changed = git(`diff --name-only ${verifiedAt}..${head}`)
    .split('\n').filter((f) => f && !f.startsWith('docs/os/'));
  if (changed.length) {
    fail.push(
      `state.md verified at ${verifiedAt.slice(0, 8)}, HEAD is ${head.slice(0, 8)}; ` +
      `${changed.length} file(s) changed outside docs/os/:\n    ` +
      changed.slice(0, 10).join('\n    ')
    );
  }
}

const recorded = state.match(/\*\*(\d+) tests \/ (\d+) suites \/ (\d+) fail\*\*/);
if (!recorded) {
  fail.push('state.md has no `**N tests / N suites / N fail**` line');
} else {
  console.log('running the suite...');
  const out = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8', shell: true }).stdout || '';
  const got = (re) => (out.match(re) || [])[1];
  const actual = { tests: got(/^# tests (\d+)$/m), suites: got(/^# suites (\d+)$/m), fails: got(/^# fail (\d+)$/m) };
  if (actual.tests === undefined) {
    fail.push('could not parse `# tests N` from the suite output');
  } else {
    if (actual.fails !== '0') fail.push(`suite is red: ${actual.fails} failing`);
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
