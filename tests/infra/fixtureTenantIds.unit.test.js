'use strict';

// FIXTURE TENANT IDs MUST BE DISJOINT ACROSS SUITES — RAG Session 3 §6.3.
//
// RAG Session 2 wrote `tests/voice/voiceStreamRagSignal.integration.test.js` with
// `TENANT_ID = '…aaaa00000029'`, an id already owned by
// `tests/voice/voiceCancellation.integration.test.js`. Both suites `cleanup()`
// that id, and `node --test` runs files in parallel processes against ONE shared
// database — so the new file deleted the other's tenant mid-run: 4 failures in
// `voiceCancellation`, 0 when that file ran alone. The loudest symptom was a
// `customers_tenant_id_fkey` violation, which names the VICTIM and not the cause.
// That is what made it expensive, and it is the whole reason this file exists:
// the assertion below names BOTH files and the id they share.
//
// Same class as the `zyon_test_%` scratch-DB race F3-R1 found by perturbing the
// schedule, one layer up. Scratch-DB prefixes are disjoint by discipline *and* by
// a check. Fixture tenant ids had the discipline and no check.
//
// ── SCOPE, and why it is not "no uuid literal may appear in two files" ────────
// Five uuid literals already appear in more than one file at HEAD, and not one of
// them is a collision (enumerated in Session 3's Phase 0):
//   • `…-000000000000` (6 files) — the nil id, used only as a tenant that must NOT
//     resolve. No suite ever creates it.
//   • `…0000000000ff` (2 files) — likewise a "no such tenant" probe, and both of
//     those suites mint their own scratch database anyway.
//   • `…00000000000a` / `…00000000000b` (configService.unit + tenantCache) and
//     `…000000000099` (tenantHydrationVoice + workflowEngine) — on the overlapping
//     side sits a suite that REPLACES `src/db/db` in `require.cache` before
//     requiring anything under test. Its "tenant" is a key in an object literal;
//     no query it issues reaches Postgres, so it cannot collide with a row.
//
// So the guard is scoped to the declaration form the incident actually took — a
// TENANT-named `const` bound to a uuid literal — in files that can reach the
// shared database at all. A guard that starts life red teaches the next session to
// delete it, so the exemption is expressed as the PROPERTY that makes those files
// safe (they stub the db module), not as a list of filenames: a suite that stops
// stubbing comes back into scope on its own.
//
// KNOWN LIMIT, asserted rather than hoped for: this is a scan, so a fixture id
// that is not a plain literal is invisible to it. The second test below fails on
// any in-scope declaration this file cannot resolve statically, which turns that
// hole into a loud one. (`voiceLifecycle.integration.test.js:23` is exactly such a
// declaration — a literal followed by `.replace(/b/g, 'a')` — and is resolved to
// its real runtime value, not to the literal on the page.)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(TESTS_DIR, '..');

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const DECL_LINE = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/;
const UUID_LITERAL = new RegExp(`^(['"])(${UUID})\\1`);

// `'…'.replace(/b/g, 'a')` and `'…'.replace('x', 'y')`, chainable. Deliberately
// the ONLY transform understood: anything else is reported rather than guessed.
const REPLACE_CALL =
  /^\s*\.replace\(\s*(?:\/((?:[^/\\]|\\.)+)\/([a-z]*)|(['"])((?:[^'"\\]|\\.)*)\3)\s*,\s*(['"])((?:[^'"\\]|\\.)*)\5\s*\)/;

// A file that replaces src/db/db in require.cache never reaches Postgres, so its
// fixture identifiers cannot collide with anyone's ROW. That is the property, not
// the filename.
function stubsDbModule(src) {
  return src.includes('require.cache[') &&
    /require\.resolve\((['"])(?:\.\.\/)+src\/db\/db\1\)/.test(src);
}

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * The value a uuid-literal declaration actually holds at runtime.
 * Returns null when the right-hand side is not a uuid literal at all (e.g.
 * `const TENANT_ID = row.id`) — those are simply not fixture declarations.
 * Returns `{ value, rest }` otherwise; a non-empty `rest` means the scan could
 * not account for the whole expression and must not trust `value`.
 */
function resolveUuidDecl(rhsRaw) {
  const rhs = rhsRaw.replace(/\s*\/\/.*$/, '').trim().replace(/;+$/, '').trim();
  const lit = rhs.match(UUID_LITERAL);
  if (!lit) return null;

  let value = lit[2];
  let rest = rhs.slice(lit[0].length);
  for (;;) {
    const m = rest.match(REPLACE_CALL);
    if (!m) break;
    const pattern = m[1] !== undefined ? new RegExp(m[1], m[2]) : m[4];
    value = value.replace(pattern, m[6]);
    rest = rest.slice(m[0].length);
  }
  return { value: value.toLowerCase(), rest: rest.trim() };
}

// Every TENANT-named declaration in a file that can reach the shared database.
function collectFixtureTenantDecls() {
  const decls = [];
  for (const file of jsFilesUnder(TESTS_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    if (stubsDbModule(src)) continue;
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    src.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(DECL_LINE);
      if (!m || !/TENANT/i.test(m[1])) return;
      const resolved = resolveUuidDecl(m[2]);
      if (!resolved) return;
      decls.push({ file: rel, line: i + 1, name: m[1], ...resolved });
    });
  }
  return decls;
}

describe('fixture tenant ids are disjoint across suites (RAG Session 3 §6.3)', () => {
  it('no two suites declare the same fixture tenant uuid', () => {
    const decls = collectFixtureTenantDecls();

    // A scan that silently matched nothing would pass forever. Two self-checks
    // before the verdict, because a broken scan is indistinguishable from a clean
    // repo otherwise.
    assert.ok(decls.length >= 12,
      `expected the scan to find the repo's fixture tenant declarations, found ${decls.length}. ` +
      'The declaration form probably changed — fix this scan before trusting it.');

    // The one declaration in the repo that is NOT a plain literal. Its value on
    // the page is …bbbb00000007; its value at runtime is …aaaa00000007. Comparing
    // literals would compare the wrong string.
    const lifecycle = decls.find((d) => d.file.endsWith('voiceLifecycle.integration.test.js'));
    assert.equal(lifecycle && lifecycle.value, '00000000-0000-0000-0000-aaaa00000007',
      'the scan must compare the RUNTIME value, not the literal on the page — ' +
      'voiceLifecycle.integration.test.js:23 declares …bbbb00000007 and transforms it ' +
      'with .replace(/b/g, \'a\')');

    const byValue = new Map();
    for (const d of decls) {
      if (!byValue.has(d.value)) byValue.set(d.value, []);
      byValue.get(d.value).push(d);
    }

    const collisions = [...byValue.entries()]
      .map(([value, ds]) => [value, ds, new Set(ds.map((d) => d.file))])
      .filter(([, , files]) => files.size > 1);

    assert.deepEqual(collisions.map(([v]) => v), [],
      'Two or more suites share a fixture tenant id. Under `node --test` they run in ' +
      'parallel against ONE database, so whichever cleans up first deletes the other\'s ' +
      'rows — and the failure surfaces in the VICTIM (Session 2 saw a ' +
      'customers_tenant_id_fkey violation in a file it had not touched). Give the NEW ' +
      'suite an unused id.\n' +
      collisions.map(([value, ds]) =>
        `  ${value}\n` + ds.map((d) => `    ${d.file}:${d.line}  ${d.name}`).join('\n')
      ).join('\n'));
  });

  it('every in-scope tenant declaration is statically resolvable by this scan', () => {
    const unresolved = collectFixtureTenantDecls().filter((d) => d.rest !== '');
    assert.deepEqual(unresolved.map((d) => `${d.file}:${d.line} ${d.name} …${d.rest}`), [],
      'A fixture tenant id starts as a uuid literal but is then transformed by an ' +
      'expression this scan does not understand, so the value it compared is NOT the ' +
      'value the suite uses — the guard above is blind to that declaration. Either ' +
      'declare the id as a plain literal, or teach resolveUuidDecl the transform.');
  });
});
