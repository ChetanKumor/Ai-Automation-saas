'use strict';

// Four surfaces declare their own :root and none imports another's. That is
// deliberate, and it is also how a fifth source of truth appears without anyone
// noticing (finding F-F008: web/'s --accent had silently become a different
// hue from the portal's). docs/design/brand-values.md is the record of which
// shared values are the same on purpose and which differ on purpose; this test
// is what makes that record binding.
//
// Deliberately ONE test() block: the suite total is a tracked number, and a
// per-token block would move it by 30 every time a token is added.
//
// No dependency — readFileSync + regex, same as every other test here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TABLE = path.join(ROOT, 'docs', 'design', 'brand-values.md');

const SURFACES = {
  portal: 'public/portal/tokens.css',
  'demo/shared': 'public/demo/shared.css',
  'demo/styles': 'public/demo/styles.css',
  web: 'web/app/globals.css',
};

// ── parsing ─────────────────────────────────────────────────────────────────

function rootBlock(css) {
  const m = css.match(/:root\s*{([\s\S]*?)\n}/);
  return m ? m[1].replace(/\/\*[\s\S]*?\*\//g, '') : '';
}

function declarations(css) {
  const out = {};
  for (const line of rootBlock(css).split('\n')) {
    const d = line.match(/(--[\w-]+)\s*:\s*([^;]+);/);
    if (d) out[d[1]] = d[2].trim();
  }
  return out;
}

// A surface's alias chain is internal to it: portal's `--accent: var(--teal-700)`
// must be compared as #0f766e, not as the literal text.
function resolve(map, name, depth = 0) {
  if (depth > 12) return '<cycle>';
  const v = map[name];
  if (v === undefined) return undefined;
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(map, ref[1], depth + 1) : v;
}

// Case, spacing and a leading zero are not drift. `cubic-bezier(0.16, 1, 0.3, 1)`
// and `cubic-bezier(.16, 1, .3, 1)` are the same easing curve.
function norm(v) {
  return String(v)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(^|[^\w.])0\./g, '$1.')
    .trim();
}

// Rows of a GitHub-flavoured markdown table under a given `## heading`, as
// arrays of cell strings with `code` fences stripped.
function tableRows(md, heading) {
  const start = md.indexOf(`## ${heading}`);
  assert.ok(start !== -1, `brand-values.md is missing the "## ${heading}" section`);
  const rest = md.slice(start);
  const end = rest.indexOf('\n## ', 3);
  const section = end === -1 ? rest : rest.slice(0, end);
  return section
    .split('\n')
    .filter((l) => l.trim().startsWith('|') && !/^\s*\|[\s|:-]+\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
    .filter((cells) => cells[0] && cells[0].startsWith('`--'))
    .map((cells) => cells.map((c) => c.replace(/^`|`$/g, '')));
}

// ── the test ────────────────────────────────────────────────────────────────

test('design tokens do not drift between the four surfaces', () => {
  const maps = {};
  for (const [key, rel] of Object.entries(SURFACES)) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `${rel} is missing — update SURFACES or restore the file`);
    maps[key] = declarations(fs.readFileSync(file, 'utf8'));
    // A FLOOR, not a count. An exact count would red the suite every time anyone
    // adds a token, and a check that fires on ordinary work gets deleted rather
    // than maintained. The smallest real surface declares 21, so 15 leaves room
    // to grow or shed one without a false red.
    //
    // What it guards: rootBlock()'s /:root\s*{([\s\S]*?)\n}/ stops at the FIRST
    // line-initial `}`, so a `}` at column zero anywhere inside :root — in code
    // or inside a comment — silently truncates the map.
    //
    // What it is NOT, measured rather than assumed. Both cases were run:
    //
    //   brace ABOVE the shared tokens (2 survive) — already failed before this
    //     floor existed, because dropping --accent/--ease-out/--r-* trips the
    //     stale-canonical-row and stale-divergence-row checks at the bottom of
    //     this file. The floor adds no detection there. What it adds is the
    //     diagnosis: one line naming truncation, instead of nine "stale row"
    //     messages that read as though brand-values.md were wrong when in fact
    //     the stylesheet is malformed.
    //
    //   brace BELOW the shared tokens (36 survive) — GREEN before this floor and
    //     GREEN after it, because 36 >= 15. This blind spot is still open. A
    //     count-based floor cannot close it; closing it needs the parser to
    //     verify that :root's closing brace is the last one in the block rather
    //     than the first line-initial `}` it meets.
    //
    // So: this catches a severe truncation and explains it. It does not catch
    // every truncation, and the comment saying otherwise would be a lie the
    // suite is not able to contradict.
    assert.ok(
      Object.keys(maps[key]).length >= 15,
      `${rel} declares only ${Object.keys(maps[key]).length} custom properties — ` +
      'expected at least 15. The :root regex probably stopped early at a `}` in ' +
      'column zero inside the block (a comment line counts).'
    );
  }

  const md = fs.readFileSync(TABLE, 'utf8');

  // canonical: token -> value
  const canonical = new Map();
  for (const cells of tableRows(md, 'Canonical values')) {
    canonical.set(cells[0], cells[1]);
  }
  assert.ok(canonical.size > 0, 'brand-values.md records no canonical values');

  // divergences: "token@surface" -> { value, why }
  const diverge = new Map();
  for (const cells of tableRows(md, 'Recorded divergences')) {
    const [token, surface, value, why] = cells;
    assert.ok(
      Object.prototype.hasOwnProperty.call(SURFACES, surface),
      `brand-values.md records a divergence for unknown surface "${surface}" (${token})`
    );
    assert.ok(
      why && why.length > 20,
      `divergence ${token}@${surface} has no explanation — a divergence without a reason is drift`
    );
    diverge.set(`${token}@${surface}`, value);
  }

  // Which tokens are shared? Only those are anyone else's business.
  const surfacesOf = new Map();
  for (const [key, map] of Object.entries(maps)) {
    for (const token of Object.keys(map)) {
      if (!surfacesOf.has(token)) surfacesOf.set(token, []);
      surfacesOf.get(token).push(key);
    }
  }
  const shared = [...surfacesOf.entries()]
    .filter(([, keys]) => keys.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));

  const problems = [];

  for (const [token, keys] of shared) {
    if (!canonical.has(token)) {
      problems.push(
        `${token} is declared by ${keys.join(', ')} but has no row in the ` +
        '"Canonical values" table — add it, or the surfaces can drift silently'
      );
      continue;
    }
    const want = norm(canonical.get(token));
    for (const key of keys) {
      const actual = norm(resolve(maps[key], token));
      const recorded = diverge.get(`${token}@${key}`);
      if (recorded !== undefined) {
        if (norm(recorded) !== actual) {
          problems.push(
            `${token} on ${key}: stylesheet says ${actual}, but brand-values.md ` +
            `records the divergence as ${norm(recorded)}`
          );
        }
        continue;
      }
      if (actual !== want) {
        problems.push(
          `${token} on ${key}: ${actual} != canonical ${want} — either fix the ` +
          'stylesheet or record it in the "Recorded divergences" table'
        );
      }
    }
  }

  // A canonical row for something no longer shared is a stale row.
  for (const token of canonical.keys()) {
    if (!surfacesOf.has(token) || surfacesOf.get(token).length < 2) {
      problems.push(`${token} has a canonical row but is no longer declared by more than one surface`);
    }
  }
  // A divergence row whose surface no longer declares the token is stale too.
  for (const key of diverge.keys()) {
    const [token, surface] = key.split('@');
    if (!(token in maps[surface])) {
      problems.push(`divergence ${token}@${surface} is recorded but ${surface} no longer declares ${token}`);
    }
  }

  assert.deepStrictEqual(problems, [], `\n  - ${problems.join('\n  - ')}\n`);
});
