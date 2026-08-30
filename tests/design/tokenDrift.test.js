'use strict';

// Four surfaces declare their own :root and none imports another's. That is
// deliberate, and it is also how a fifth source of truth appears without anyone
// noticing (finding F-F008: web/'s --accent had silently become a different
// hue from the portal's). docs/design/brand-values.md is the record of which
// shared values are the same on purpose and which differ on purpose; this test
// is what makes that record binding.
//
// TWO test() blocks, and deliberately no more. The suite total is a tracked
// number, so a per-token block would move it by 30 every time a token is added.
// The second block is not per-token: it pins the PARSER against synthetic CSS,
// because everything the first block asserts is downstream of the parser being
// right, and for a long time it was not.
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

// How many distinct custom-property names the parser must find in each surface,
// and how many top-level :root blocks it must find them in.
//
// EXACT counts, which reverses the judgement this file used to carry. It said a
// count "would red the suite every time anyone adds a token" and used a floor of
// 15 declarations instead. The floor was measured against the two defects the
// parser note below describes, and it caught neither: the real portal parse was
// 93 names where it should have been 99, and 93 >= 15 is green. Everything the
// floor did catch, the stale-canonical-row and stale-divergence-row checks at
// the bottom of this file were already catching.
//
// The two counts divide the work, because the two defects do different damage:
//
//   Losing the second declaration on a shared line costs NAMES — five of them,
//   93 against 99 — and only EXPECTED_NAMES can see that.
//
//   Losing a whole :root block costs one name (--save-bar-h) and five VALUES:
//   --bg, --line, --line-2, --r-md and --r-lg are all redeclared in block #2,
//   so dropping it leaves the map the right size and five entries wrong. A name
//   count is nearly blind to that — 98 against 99 — which is why
//   EXPECTED_ROOT_BLOCKS is a separate assertion rather than a nicety.
//
// The price is one number to bump when a token is added. That is not a cost
// worth avoiding: adding a token to a surface someone else shares is exactly
// the moment to look at brand-values.md.
//
// portal is 99, not the 102 names the portal surface owns. public/portal/
// verbatim.css declares three more — --vp-sheet-h in its own :root, --field-3
// and --field-line-2 under .vp — and that file is not in SURFACES; two of the
// three are not in a :root at all. 99 is every portal name this parser can
// reach: 104 declarations across three :root blocks, five of them shadowed.
//
// web is 55, from one base :root. The five redeclarations at globals.css:441
// sit inside @media (prefers-contrast: more) and are deliberately not counted —
// see rootBodies().
const EXPECTED_NAMES = {
  portal: 99,
  'demo/shared': 25,
  'demo/styles': 21,
  web: 55,
};

// All four surfaces declare :root exactly once. The portal declared it THREE
// times until the blocks were collapsed — a base block, a five-token override
// pass 160 lines below it, and --save-bar-h alone near the bottom — which is the
// history the rest of this file is written against.
//
// 1 is an assertion, not a formality. It fails in BOTH directions: a fourth
// surface growing an override pass reds here, and so does the portal growing a
// second block again. That is the point — a second block at equal specificity
// silently overrides the first, so every token it redeclares reads one value in
// the file and paints another, which is exactly the state this number now
// forbids. If a block is ever added on purpose, update EXPECTED_ROOT_BLOCKS and
// EXPECTED_NAMES together and re-derive the canonical values from what the
// BROWSER resolves, not from what the first block reads.
const EXPECTED_ROOT_BLOCKS = {
  portal: 1,
  'demo/shared': 1,
  'demo/styles': 1,
  web: 1,
};

// ── parsing ─────────────────────────────────────────────────────────────────

// Three parser defects made this guard green on drift it could not see, all
// three found by the surface-A–D manifest and all three repaired here.
//
//   1. The old /:root\s*{([\s\S]*?)\n}/ was NON-global: it returned the FIRST
//      :root block and stopped. public/portal/tokens.css has THREE — block #2
//      at :177 is a five-token override pass that shadows --bg, --line,
//      --line-2, --r-md and --r-lg, and block #3 at :1194 holds --save-bar-h.
//      Both were invisible, so the test compared the SHADOWED values and the
//      browser used different ones.
//   2. It also stopped at the first line-initial `}` — including one inside a
//      comment — silently truncating the map.
//   3. declarations() matched one declaration PER LINE, non-globally. Five
//      rows in tokens.css carry two declarations each (--t-display/--ls-display
//      and four more), so the second of every pair was never parsed.
//
// The replacement blanks comments first (length- and newline-preserving, so
// offsets still line up), then brace-matches. A `}` inside a comment or a
// string can no longer terminate a block early.
function blankComments(css) {
  let out = '';
  let i = 0;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      // An unterminated comment runs to EOF — that is what a browser does too.
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += css[k] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Strings are kept VERBATIM — --sans is a quoted font stack, and blanking
      // it would destroy the value. They are only skipped so that a brace or a
      // /* inside one cannot be mistaken for syntax.
      const q = ch;
      out += ch;
      i += 1;
      while (i < n && css[i] !== q) {
        if (css[i] === '\\' && i + 1 < n) { out += css[i] + css[i + 1]; i += 2; continue; }
        out += css[i];
        i += 1;
      }
      if (i < n) { out += css[i]; i += 1; }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Bodies of every TOP-LEVEL `:root` block, in source order.
//
// Top-level is the point. web/app/globals.css:441 declares :root again inside
// @media (prefers-contrast: more) — those five values are CONDITIONAL, not
// shadowing. Under default conditions the base block wins, and the base block
// is what this table is about. A depth-0 filter is what keeps a high-contrast
// override out of the canonical comparison.
function rootBodies(css) {
  const src = blankComments(css);
  const n = src.length;
  const bodies = [];
  let i = 0;
  let depth = 0;
  let selStart = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i += 1;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
      i += 1;
      continue;
    }
    if (ch === '{') {
      const isRoot = depth === 0 &&
        src.slice(selStart, i).split(',').some((s) => s.trim() === ':root');
      i += 1;
      if (!isRoot) { depth += 1; selStart = i; continue; }
      const start = i;
      let d = 1;
      while (i < n && d > 0) {
        const c = src[i];
        if (c === '"' || c === "'") {
          const q = c;
          i += 1;
          while (i < n && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
          i += 1;
          continue;
        }
        if (c === '{') d += 1;
        else if (c === '}') d -= 1;
        i += 1;
      }
      bodies.push(src.slice(start, i - 1));
      selStart = i;
      continue;
    }
    if (ch === '}') { depth -= 1; i += 1; selStart = i; continue; }
    if (ch === ';' && depth === 0) { i += 1; selStart = i; continue; }
    i += 1;
  }
  return bodies;
}

// Every declaration in every :root block, in source order. Equal specificity,
// so the LAST one written wins — which is what the browser does and what the
// old per-line, first-block parser did not.
function declarations(css) {
  const out = {};
  for (const body of rootBodies(css)) {
    const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let m;
    // The trailing `;` lets a final declaration written without one still parse.
    const text = `${body};`;
    while ((m = re.exec(text)) !== null) out[m[1]] = m[2].trim();
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
    const css = fs.readFileSync(file, 'utf8');
    maps[key] = declarations(css);

    // Two exact counts, and between them they cover all three parser defects.
    // The floor they replace (`>= 15`) was green on every one of them.
    const blocks = rootBodies(css).length;
    assert.strictEqual(
      blocks,
      EXPECTED_ROOT_BLOCKS[key],
      `${rel} has ${blocks} top-level :root block(s), expected ` +
      `${EXPECTED_ROOT_BLOCKS[key]}. If a block was added or removed on purpose, ` +
      'update EXPECTED_ROOT_BLOCKS and EXPECTED_NAMES together — a new block is ' +
      'usually an override pass, and an override pass moves canonical values.'
    );

    const names = Object.keys(maps[key]);
    assert.strictEqual(
      names.length,
      EXPECTED_NAMES[key],
      `${rel} yields ${names.length} custom-property names, expected ` +
      `${EXPECTED_NAMES[key]}. Fewer means the parser lost declarations — a \`}\` ` +
      'in column zero inside the block, a :root block it stopped seeing, or two ' +
      'declarations on one line where it reads only the first. More means tokens ' +
      'were added: bump the number here, and check whether brand-values.md needs ' +
      'a row.'
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

// A second bare test(), and the only one this file will grow. The block above
// compares real stylesheets, so it can only fail once they have already drifted;
// these assertions pin the parser itself against synthetic CSS, so the three
// defects it was repaired for cannot come back looking like a pass.
test('the :root parser survives what the old one silently truncated', () => {
  // Defect (2): a `}` in column zero INSIDE a comment. The old regex,
  // /:root\s*{([\s\S]*?)\n}/, ended the block there and returned a map holding
  // --a alone — short, plausible, and green. The comment is deliberately left
  // hanging over that line: the `}` is the first thing after it that a
  // line-anchored parser would accept as the end of the rule.
  const braceInComment = [
    ':root {',
    '  --a: 1px;',
    '  /* the closing brace in the example below sits in column zero:',
    '}',
    '     ...and this line is still inside the comment */',
    '  --b: 2px;',
    '}',
  ].join('\n');
  assert.deepStrictEqual(
    declarations(braceInComment),
    { '--a': '1px', '--b': '2px' },
    'a `}` in column zero inside a comment truncated the map — the old failure, ' +
    'and the one that reads as a pass because a short map is still a map'
  );

  // Defect (3): two declarations on one line. tokens.css writes the type scale
  // that way on five rows, so the old per-line, non-global match lost five names.
  assert.deepStrictEqual(
    declarations(':root {\n  --t: 600 30px/1.2 var(--sans);   --ls: -.025em;\n}'),
    { '--t': '600 30px/1.2 var(--sans)', '--ls': '-.025em' },
    'the second declaration on a shared line was dropped'
  );

  // Defect (1): more than one top-level :root. Equal specificity, so the later
  // block wins — declaration by declaration, not wholesale. That is what the
  // browser does with tokens.css:177, and it is the whole of the --radius case:
  // the alias at tokens.css:111 points at a --r-md declared four lines above it
  // as 10px, and resolves to the 8px block #2 gives --r-md 70 lines below.
  assert.deepStrictEqual(
    declarations(':root { --x: 10px; --y: 1px; }\n:root { --x: 8px; }'),
    { '--x': '8px', '--y': '1px' },
    'a second :root block was ignored, or it replaced the first wholesale'
  );

  // The other half of defect (1): a :root nested in an at-rule is CONDITIONAL,
  // not shadowing. globals.css:441 redeclares five tokens under
  // @media (prefers-contrast: more); counting those would make the canonical
  // table describe a display mode almost nobody is in.
  assert.deepStrictEqual(
    declarations(
      ':root { --x: 1px; }\n' +
      '@media (prefers-contrast: more) {\n' +
      '  .card { border-color: red; }\n' +   // forces selStart to reset before :root
      '  :root { --x: 9px; }\n}'
    ),
    { '--x': '1px' },
    'an @media-nested :root leaked into the base map'
  );

  // A brace inside a quoted value must not end the block either, and the value
  // has to survive verbatim: --sans, --te and --hi are quoted font stacks, so a
  // parser that blanked strings the way it blanks comments would compare four
  // surfaces on an empty font list and call them identical.
  assert.deepStrictEqual(
    declarations(':root { --q: "a}b"; --s: \'Noto Sans\', system-ui; }'),
    { '--q': '"a}b"', '--s': "'Noto Sans', system-ui" },
    'a brace inside a string ended the block, or blanking comments ate a string'
  );
});
