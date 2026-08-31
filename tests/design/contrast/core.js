'use strict';

/* ============================================================================
 * CONTRAST CORE — the measurement engine, surface-agnostic.
 *
 * Extracted from tests/design/portalContrast.js in S6a as a PURE refactor: the
 * arithmetic, the DOM walks and the verdicts below are byte-for-byte the ones
 * that produced the portal baseline recorded in docs/os/state.md, and the
 * extraction is only accepted if re-running the live sweep reproduces that
 * baseline's signature md5 exactly.
 *
 * ── WHY IT IS ITS OWN FILE ────────────────────────────────────────────────
 * The engine was bound to one surface. Measuring a SECOND surface — web/, the
 * marketing site, a future admin panel — meant forking it, and a forked
 * instrument is two instruments that disagree the first time either is
 * touched. Nothing below knows a URL, a page list, a readiness gate, or what a
 * Verbatim panel is. Everything surface-specific is the caller's: it hands in
 * the gates, drives the browser, and passes RAW rows back to judge().
 *
 * ── WHAT IT REPLACES, AND BY OPPOSITION ───────────────────────────────────
 * D-016 (`docs/os/decisions.md:801`) closes on "532 colour/backdrop pairs
 * measured on the live DOM, zero failures". That harness is NOT in this
 * repository and is not on this machine: no tracked file outside
 * `scripts/portal/shootD4.js` and `shootD5b.js` so much as names
 * `backgroundColor`, `git log --all -S"backdrop"` finds no such file in any
 * commit on any branch, and every per-session scratchpad still on disk has been
 * enumerated. It was scratchpad tooling and the scratchpads were cleaned. Its
 * number therefore survives as an assertion nobody can re-run — which is the
 * whole reason this file exists.
 *
 * What DID survive in the tree is its descendant, and it is where the backdrop
 * rule below comes from — by opposition, not by copying:
 *
 *   web/app/(marketing)/specimen/SwatchRatio.tsx:66-71
 *       const swatch = node.parentElement;
 *       const cs = getComputedStyle(swatch);
 *       setRatio(contrast(cs.color, cs.backgroundColor));
 *
 *   web/app/(marketing)/specimen/tokens.ts:150-176  contrast(a, b)
 *       "Alpha is composited over WHITE rather than over the true backdrop:
 *        nothing this is asked to measure is translucent."
 *
 * That is ONE element, ONE hop, no ancestor walk, and any alpha resolved
 * against white. It is correct for the two swatches it labels, because those
 * swatches were built opaque on purpose. It is wrong for a whole page, and the
 * five traps that made it wrong are recorded across the D-016 sessions:
 *
 *   1. Start the backdrop walk at `el`, NOT at `el.parentElement`. Starting at
 *      the parent skips the element's own background, and light-on-dark button
 *      labels then read 1:1.
 *   2. `opacity` on an ANCESTOR composites the glyph toward the page, and which
 *      way it washes flips with the ground. A probe reading `color` without
 *      accumulating ancestor opacity scores passes the screen does not show.
 *   3. `transform: scale()` does not move computed `font-size`. Without
 *      accumulating ancestor scale the 24px / 18.66px large-text boundary
 *      cannot be seen at all.
 *   4. A child sitting on its OWN opaque surface must not be scored against the
 *      translucent bar above it — which is just (1) again, and is why the walk
 *      stops at the first opaque layer.
 *   5. Measure settled. A glyph mid-transition composites at fractional opacity
 *      and reads a ratio it never holds at rest.
 *
 * ── WHAT IT MEASURES ──────────────────────────────────────────────────────
 * For every element bearing a glyph: the computed `color`, its alpha multiplied
 * by the accumulated opacity of itself and every ancestor, composited over the
 * ACTUAL backdrop — every ancestor `background-color` alpha-composited in paint
 * order from `el` upward until the stack goes opaque, terminating on the canvas.
 * Never the declared token. Never white-by-assumption.
 *
 * Thresholds: 4.5:1 body, 3:1 large (>=24px, or >=18.66px at weight >=700),
 * 3:1 for a focus indicator (SC 1.4.11), all derived from the measured ratio so
 * a verdict cannot disagree with the number printed beside it.
 *
 * ── REST vs FOCUS IS A SEPARATION, NOT A CONVENIENCE ──────────────────────
 * `blurActive()` and `tagFocusables()` are two exports rather than one because
 * a style read in the same turn as the `blur()` returns the TRANSITION START —
 * i.e. the FOCUSED value. The caller must run them in separate evaluations with
 * a settle (>= --dur-1, 220ms suffices for the portal) between. Collapsing them
 * produced a phantom "glow only, 1.13:1 FAIL" on a ring that is really 5.47:1.
 * The same trap runs the other way when a forced `:focus-visible` is read
 * without sleeping.
 *
 * ── THE D-016 CONTRACT ────────────────────────────────────────────────────
 * `--ink-faint` (#A8A199) is NON-TEXT ONLY by written contract, not by
 * threshold. `judge()` reports it as a contract violation wherever it resolves
 * as a glyph colour, independently of the ratio that glyph happens to score.
 * A caller measuring a surface with a different faint token overrides the hex
 * via `judge(rows, { inkFaint })`; the RULE — a contract is not a threshold —
 * is the part that is not configurable.
 *
 * ── THE SIGNATURE ─────────────────────────────────────────────────────────
 * `signature()` reduces a run to its distinct SHAPES: which colour/backdrop
 * pairs fail, which contract violations exist, which focus indicators were
 * drawn. Counts are deliberately excluded. Across five S2 runs whose row counts
 * read 2302 / 2325 / 2339 / 2347 the distinct-pair signature was byte-identical
 * every time, so the shape is the invariant a refactor must preserve and the
 * row count is not.
 * ========================================================================== */

const crypto = require('crypto');

/* ──────────────────────────────────────────────────────────────────────────
 * Colour math. These five are the single source of truth: they run in Node for
 * judge() and for the unit tests, and the first two are serialised verbatim
 * into the page for the backdrop walk. They are `function` declarations rather
 * than arrows precisely so `Function.prototype.toString()` yields something
 * that can be re-declared inside the injected scope.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Parse a CSS colour into {r,g,b,a} with r/g/b in 0..255 and a in 0..1.
 * Handles what getComputedStyle actually returns (Chrome serialises to
 * `rgb(r, g, b)` / `rgba(r, g, b, a)`, and `color(srgb r g b)` for some
 * inputs), plus the hex forms a stylesheet is authored in. Returns null on
 * anything it cannot parse — never a plausible guess.
 */
function parseColor(input) {
  if (input === null || input === undefined) return null;
  var s = String(input).trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  var m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    var p = m[1].split(/[,\s/]+/).filter(function (x) { return x.length; });
    if (p.length < 3) return null;
    var n = [];
    for (var i = 0; i < 3; i++) {
      var v = p[i].indexOf('%') >= 0 ? parseFloat(p[i]) * 2.55 : parseFloat(p[i]);
      if (!isFinite(v)) return null;
      n.push(v);
    }
    var a = 1;
    if (p.length > 3) {
      a = p[3].indexOf('%') >= 0 ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
      if (!isFinite(a)) return null;
    }
    return { r: n[0], g: n[1], b: n[2], a: Math.max(0, Math.min(1, a)) };
  }
  var c = s.match(/^color\(srgb\s+([^)]+)\)$/);
  if (c) {
    var q = c[1].split(/[\s/]+/).filter(function (x) { return x.length; });
    if (q.length < 3) return null;
    var cn = [];
    for (var j = 0; j < 3; j++) {
      var cv = parseFloat(q[j]);
      if (!isFinite(cv)) return null;
      cn.push(cv * 255);
    }
    var ca = q.length > 3 ? parseFloat(q[3]) : 1;
    if (!isFinite(ca)) return null;
    return { r: cn[0], g: cn[1], b: cn[2], a: Math.max(0, Math.min(1, ca)) };
  }
  var h = s.replace('#', '');
  if (/^[0-9a-f]{3}$/.test(h)) {
    return {
      r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16), a: 1,
    };
  }
  if (/^[0-9a-f]{4}$/.test(h)) {
    return {
      r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16), a: parseInt(h[3] + h[3], 16) / 255,
    };
  }
  if (/^[0-9a-f]{6}$/.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16), a: 1,
    };
  }
  if (/^[0-9a-f]{8}$/.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16), a: parseInt(h.slice(6, 8), 16) / 255,
    };
  }
  return null;
}

/**
 * Source-over compositing: `top` painted onto `bottom`. This is the operation
 * the whole instrument turns on — it is what makes a backdrop the composited
 * one instead of the declared one.
 */
function compositeOver(top, bottom) {
  var ta = top.a;
  var ba = bottom.a === undefined ? 1 : bottom.a;
  var oa = ta + ba * (1 - ta);
  if (oa === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (top.r * ta + bottom.r * ba * (1 - ta)) / oa,
    g: (top.g * ta + bottom.g * ba * (1 - ta)) / oa,
    b: (top.b * ta + bottom.b * ba * (1 - ta)) / oa,
    a: oa,
  };
}

/** WCAG 2.x relative luminance. Expects an opaque colour. */
function relativeLuminance(c) {
  function ch(v) {
    var x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** WCAG 2.x contrast ratio, 1..21. Expects two opaque colours. */
function contrastRatio(a, b) {
  var la = relativeLuminance(a);
  var lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * WCAG "large text": >=24px, or >=18.66px at weight >=700. `px` must already
 * carry any accumulated ancestor scale — computed font-size does not.
 */
function isLargeText(px, weight) {
  return px >= 24 || (px >= 18.66 && Number(weight) >= 700);
}

/**
 * Chrome serialises box-shadow as `rgba(r, g, b, a) Xpx Ypx Bpx Spx` (with an
 * optional leading/trailing `inset`), comma-separated for multiple layers. The
 * focus measurement needs the colour and the spread, so it needs this.
 */
function parseBoxShadow(value) {
  var s = String(value || '').trim();
  if (!s || s === 'none') return [];
  var layers = [];
  var depth = 0;
  var start = 0;
  for (var i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { layers.push(s.slice(start, i)); start = i + 1; }
  }
  layers.push(s.slice(start));
  return layers.map(function (raw) {
    var t = raw.trim();
    var inset = /(^|\s)inset(\s|$)/.test(t);
    t = t.replace(/(^|\s)inset(\s|$)/, ' ').trim();
    var colorMatch = t.match(/^(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]+)/);
    var color = colorMatch ? colorMatch[1] : null;
    var rest = colorMatch ? t.slice(colorMatch[1].length) : t;
    var lens = (rest.match(/-?[\d.]+px/g) || []).map(parseFloat);
    return {
      color: color,
      offsetX: lens[0] === undefined ? 0 : lens[0],
      offsetY: lens[1] === undefined ? 0 : lens[1],
      blur: lens[2] === undefined ? 0 : lens[2],
      spread: lens[3] === undefined ? 0 : lens[3],
      inset: inset,
    };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * The in-page half. These run inside the portal, serialised by buildSource().
 * They collect RAW measurements only — every ratio and every verdict is
 * computed back in Node by judge(), so the arithmetic under test is the
 * arithmetic that shipped.
 *
 * Constraint: no template literals, no closures over module scope, no
 * `const`/`let` shadowing across the concatenation boundary. What they need is
 * passed in.
 * ────────────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────────────────
 * WHAT A GLYPH IS, and the four ways one reaches the screen.
 *
 * S3b-3 widened this from "direct child text nodes" to everything that
 * actually paints. The old rule was not a simplification, it was a blind spot
 * with a measurable cost: S3b moved `--line` and `--line-3` and the sweep
 * reported ZERO change, because the two things those tokens repaint on the
 * portal — a `::before` separator and an `<svg>` stroke — were not in the row
 * set at all. A gate that cannot see the thing that moved is not a gate.
 *
 *   text      a direct child text node, an input's value or placeholder, a
 *             selected <option>.                    (unchanged, byte for byte)
 *   pseudo    ::before / ::after / ::marker, recorded only where `content`
 *             resolves to a NON-EMPTY string. `content: ""` is a decorative
 *             box, not a glyph, and counting it would score a colour nobody
 *             can read.
 *   graphic   an SVG shape's resolved paint. Scored at SC 1.4.11's 3:1, NOT at
 *             4.5 — an icon is a non-text graphic, and a body-text floor would
 *             be the wrong verdict printed with real authority. The <svg> root
 *             is deliberately NOT a paint source: it computes a default
 *             `fill: rgb(0,0,0)` it never paints with, while the shapes that
 *             inherit `stroke="currentColor"` from it resolve the real colour.
 *   state     the same three, re-measured under :hover, :active, :focus-within.
 *
 * ── HOW A STATE IS ENTERED, AND WHY NOT WITH A SLEEP ──────────────────────
 * Focus is separated into its own pass because a style read in the same turn
 * as the state change returns the TRANSITION START (S2: a phantom "glow only,
 * 1.13:1 FAIL" on a ring that is really 5.47:1). The driver settles between
 * the two evaluations.
 *
 * The three states below cannot be given that boundary here. `:hover` is not
 * scriptable — only CDP's `CSS.forcePseudoState` or a real pointer enters it —
 * and the portal's driver, `scripts/portal/shoot.js`, hands this source to ONE
 * `Runtime.evaluate` with no `awaitPromise`. So the trap is removed at its
 * root instead of waited out: `neutraliseTransitions()` installs
 * `transition:none !important` BEFORE any state is armed, so there is no
 * interpolation left for a read to catch — and it VERIFIES that. It picks a
 * witness element that really was transitioning and throws if the witness does
 * not read `0s` afterwards. A neutralisation that failed silently would
 * reproduce exactly the S2 phantom, so it is not allowed to fail silently.
 *
 * The state itself is entered through the CASCADE, not through a synthesised
 * style: every `:hover` rule gets a twin whose pseudo-class is rewritten to
 * `[data-cs-hover]`, INSERTED IMMEDIATELY AFTER THE ORIGINAL IN THE SAME
 * SHEET. A pseudo-class and an attribute selector are both (0,1,0), so same
 * specificity and same document order, and the twin wins and loses exactly the
 * cascade fights the original does. Appending one stylesheet at the end would
 * not: `.lang-toggle:hover` LOSES to the later `.lang-toggle[aria-pressed=
 * "true"]` at equal specificity, and a twin parked at the end of the document
 * would have won it and reported a colour the screen never shows.
 *
 * Every element matching the pseudo's own compound is armed at once. That is
 * not a fiction — hovering a child hovers its whole ancestor chain, so the
 * nested case is the real one — and contrast is a per-element question anyway.
 *
 * ── WHAT A STATE PASS RECORDS ─────────────────────────────────────────────
 * Only glyphs the state actually MOVED. Each rest row's colour, backdrop,
 * opacity and size is fingerprinted per element and per slot; a state row
 * whose fingerprint is unchanged is dropped. So `:hover` on a rule that moves
 * only `border-color` adds nothing, and the rows that survive are exactly the
 * ones a rest-only sweep could never have seen.
 * ────────────────────────────────────────────────────────────────────────── */

function sweepPage(parseColorFn, compositeOverFn) {
  var WHITE = { r: 255, g: 255, b: 255, a: 1 };
  var STATES = ['hover', 'active', 'focus-within'];

  function pathOf(el) {
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      var seg = String(n.tagName).toLowerCase();
      if (n.id) { parts.unshift(seg + '#' + n.id); break; }
      var cls = String(n.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      if (cls.length) seg += '.' + cls.slice(0, 2).join('.');
      parts.unshift(seg);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  // Accumulated scale from every ancestor transform. Computed font-size does
  // NOT move under transform: scale(), so the large-text boundary is invisible
  // without this.
  function scaleOf(el) {
    var s = 1;
    var n = el;
    while (n && n.nodeType === 1) {
      var t = getComputedStyle(n).transform;
      if (t && t !== 'none') {
        var m = t.match(/matrix\(([^)]+)\)/);
        if (m) {
          var p = m[1].split(',').map(parseFloat);
          var det = Math.abs(p[0] * p[3] - p[1] * p[2]);
          if (isFinite(det) && det > 0) s *= Math.sqrt(det);
        } else {
          var m3 = t.match(/matrix3d\(([^)]+)\)/);
          if (m3) {
            var q = m3[1].split(',').map(parseFloat);
            var d3 = Math.abs(q[0] * q[5] - q[1] * q[4]);
            if (isFinite(d3) && d3 > 0) s *= Math.sqrt(d3);
          }
        }
      }
      n = n.parentElement;
    }
    return s;
  }

  // Product of `opacity` on the element and every ancestor. An opacity group
  // composites its WHOLE subtree — the glyph and the element's own background
  // alike — toward whatever is behind the group.
  function opacityChain(el) {
    var chain = [];
    var acc = 1;
    var n = el;
    while (n && n.nodeType === 1) {
      var o = parseFloat(getComputedStyle(n).opacity);
      acc *= (isFinite(o) ? o : 1);
      chain.push({ el: n, acc: acc });
      n = n.parentElement;
    }
    return chain;
  }

  /**
   * The composited backdrop behind `el`'s glyphs.
   *
   * Walks from `el` ITSELF (trap 1 — starting at the parent skips the
   * element's own fill and reads light-on-dark labels as 1:1), collecting each
   * background-color with its alpha scaled by that node's accumulated opacity
   * (trap 2), stopping at the first fully opaque layer (trap 4), and folding
   * the stack bottom-up onto the canvas. `background-image` is not resolvable
   * from computed style, so it is flagged rather than silently ignored.
   *
   * `lead` is the box of a PSEUDO-ELEMENT, which paints above its originating
   * element's own background and below nothing else. Passing it prepends one
   * layer and changes nothing else; with no `lead` this is the walk that
   * produced every baseline before S3b-3, layer for layer.
   */
  function backdropOf(el, lead) {
    var chain = opacityChain(el);
    var layers = [];
    var image = false;
    var closed = false;
    if (lead) {
      if (lead.image) image = true;
      var lc = parseColorFn(lead.backgroundColor);
      if (lc) {
        var la = lc.a * (chain.length ? chain[0].acc : 1) * lead.opacity;
        if (la > 0) {
          layers.push({ r: lc.r, g: lc.g, b: lc.b, a: la });
          if (la >= 1) closed = true;
        }
      }
    }
    for (var i = 0; !closed && i < chain.length; i++) {
      var cs = getComputedStyle(chain[i].el);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') image = true;
      var c = parseColorFn(cs.backgroundColor);
      if (!c) continue;
      var a = c.a * chain[i].acc;
      if (a <= 0) continue;
      layers.push({ r: c.r, g: c.g, b: c.b, a: a });
      if (a >= 1) closed = true; // opaque: nothing below it can show through
    }
    var out = WHITE; // the canvas default, reached only if the stack never closed
    for (var k = layers.length - 1; k >= 0; k--) out = compositeOverFn(layers[k], out);
    return { color: { r: out.r, g: out.g, b: out.b, a: 1 }, imageBacked: image };
  }

  function visible(el, cs) {
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (cs.display === 'none') return false;
    if (!el.getClientRects().length) return false;
    return true;
  }

  function pageName() {
    return location.pathname.split('/').pop() || 'index.html';
  }

  /* ── the rest fingerprint, and the state de-duplication it enables ────── */

  var restFp = new Map();

  function fingerprintOf(row) {
    return row.color + '|' + Math.round(row.bg.r) + ',' + Math.round(row.bg.g)
      + ',' + Math.round(row.bg.b) + '|' + row.opacity + '|' + row.px + '|' + row.weight;
  }

  function push(rows, el, slot, state, row) {
    var fp = fingerprintOf(row);
    if (state === 'rest') {
      var slots = restFp.get(el);
      if (!slots) { slots = {}; restFp.set(el, slots); }
      slots[slot] = fp;
      rows.push(row);
      return;
    }
    var known = restFp.get(el);
    if (known && known[slot] === fp) return; // this state moved nothing here
    rows.push(row);
  }

  /* ── the three kinds of glyph ─────────────────────────────────────────── */

  function record(rows, el, role, colorStr, textSample, state, slot) {
    var cs = getComputedStyle(el);
    if (!visible(el, cs)) return;
    var chain = opacityChain(el);
    var opacity = chain.length ? chain[chain.length - 1].acc : 1;
    if (opacity <= 0) return;
    var back = backdropOf(el);
    var scale = scaleOf(el);
    push(rows, el, slot, state, {
      page: pageName(),
      sel: pathOf(el),
      role: role,
      state: state,
      text: String(textSample || '').replace(/\s+/g, ' ').trim().slice(0, 48),
      color: colorStr,
      opacity: Math.round(opacity * 1e4) / 1e4,
      scale: Math.round(scale * 1e4) / 1e4,
      px: Math.round(parseFloat(cs.fontSize) * scale * 100) / 100,
      weight: Number(cs.fontWeight) || 400,
      bg: back.color,
      imageBacked: back.imageBacked,
    });
  }

  /**
   * The painted half of `content`. Quoted runs only — `counter()` and `attr()`
   * paint a glyph whose text computed style will not hand over, so the raw
   * value stands in as the sample rather than the row being dropped. A bare
   * `url(...)` is an image, not a glyph, and `content: ""` is a decorative box:
   * both return null and are never scored.
   */
  function pseudoText(raw) {
    if (!raw) return null;
    var v = String(raw);
    if (v === 'none' || v === 'normal') return null;
    var alt = v.indexOf(' / ');          // content: "x" / "alt" — alt is not painted
    if (alt >= 0) v = v.slice(0, alt);
    var quoted = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
    var out = '';
    var m;
    while ((m = quoted.exec(v)) !== null) out += (m[1] !== undefined ? m[1] : m[2]);
    if (out.trim().length) return out;
    if (/counter\(|counters\(|attr\(/.test(v)) return v;
    return null;
  }

  function recordPseudo(rows, el, which, state) {
    var cs;
    try { cs = getComputedStyle(el, which); } catch (e) { return; }
    if (!cs) return;
    var hostCs = getComputedStyle(el);
    var text = pseudoText(cs.content);
    if (!text && which === '::marker') {
      // A default marker paints a bullet or a number with `content: normal`.
      if (hostCs.listStyleType && hostCs.listStyleType !== 'none') text = '•';
    }
    if (!text) return;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return;
    if (!visible(el, hostCs)) return;
    var chain = opacityChain(el);
    var hostOpacity = chain.length ? chain[chain.length - 1].acc : 1;
    var own = parseFloat(cs.opacity);
    if (!isFinite(own)) own = 1;
    var opacity = hostOpacity * own;
    if (opacity <= 0) return;
    var back = backdropOf(el, {
      backgroundColor: cs.backgroundColor,
      image: !!(cs.backgroundImage && cs.backgroundImage !== 'none'),
      opacity: own,
    });
    var scale = scaleOf(el);
    push(rows, el, which, state, {
      page: pageName(),
      sel: pathOf(el) + which,
      role: 'pseudo',
      pseudo: which,
      state: state,
      text: String(text).replace(/\s+/g, ' ').trim().slice(0, 48),
      color: cs.color,
      opacity: Math.round(opacity * 1e4) / 1e4,
      scale: Math.round(scale * 1e4) / 1e4,
      px: Math.round(parseFloat(cs.fontSize) * scale * 100) / 100,
      weight: Number(cs.fontWeight) || 400,
      bg: back.color,
      imageBacked: back.imageBacked,
    });
  }

  var SVG_SHAPES = 'path,circle,rect,line,polyline,polygon,ellipse,use';

  /**
   * One row per DISTINCT resolved paint inside an <svg>, attributed to the
   * shape that introduced it and capped at three so a detailed illustration
   * cannot flood the row set. `fill`/`stroke` may be a paint server
   * (`url(#grad)`) rather than a colour — parseColor returns null for those and
   * they are skipped rather than guessed at.
   */
  function recordGraphics(rows, svg, state) {
    var shapes = svg.querySelectorAll(SVG_SHAPES);
    var seen = {};
    var found = 0;
    for (var i = 0; i < shapes.length && found < 3; i++) {
      var n = shapes[i];
      var cs = getComputedStyle(n);
      if (!visible(n, cs)) continue;
      var cand = [];
      if (cs.fill && cs.fill !== 'none') cand.push(cs.fill);
      if (cs.stroke && cs.stroke !== 'none') cand.push(cs.stroke);
      for (var j = 0; j < cand.length && found < 3; j++) {
        var paint = cand[j];
        if (seen[paint]) continue;
        var parsed = parseColorFn(paint);
        if (!parsed || parsed.a <= 0) continue;
        seen[paint] = 1;
        found += 1;
        var chain = opacityChain(n);
        var opacity = chain.length ? chain[chain.length - 1].acc : 1;
        if (opacity <= 0) continue;
        var back = backdropOf(n);
        var label = svg.getAttribute('aria-label')
          || (svg.parentElement && svg.parentElement.getAttribute('aria-label')) || '';
        push(rows, n, 'graphic:' + paint, state, {
          page: pageName(),
          sel: pathOf(n),
          role: 'graphic',
          state: state,
          text: String(label).replace(/\s+/g, ' ').trim().slice(0, 48),
          color: paint,
          opacity: Math.round(opacity * 1e4) / 1e4,
          scale: Math.round(scaleOf(n) * 1e4) / 1e4,
          px: 0,
          weight: 400,
          bg: back.color,
          imageBacked: back.imageBacked,
        });
      }
    }
  }

  /* ── one pass over one state ──────────────────────────────────────────── */

  function collect(rows, state) {
    var all = state === 'rest'
      ? document.querySelectorAll('*')
      : document.querySelectorAll('[data-cs-' + state + '],[data-cs-' + state + '] *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var tag = String(el.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'title'
          || tag === 'meta' || tag === 'link' || tag === 'head') continue;

      // Only DIRECT text children: an ancestor does not paint its descendants'
      // glyphs, and counting it would score the same glyph against the wrong box.
      var own = '';
      for (var c = 0; c < el.childNodes.length; c++) {
        if (el.childNodes[c].nodeType === 3) own += el.childNodes[c].nodeValue;
      }
      if (own.trim().length) {
        var cs = getComputedStyle(el);
        // SVG text is painted with `fill`; `color` inside an <svg> subtree is
        // only the resolution target for `currentColor`.
        var paint = cs.color;
        if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
          if (cs.fill && cs.fill !== 'none') paint = cs.fill;
          else if (cs.stroke && cs.stroke !== 'none') paint = cs.stroke;
        }
        record(rows, el, 'text', paint, own, state, 'text');
      }

      recordPseudo(rows, el, '::before', state);
      recordPseudo(rows, el, '::after', state);
      if (/list-item/.test(getComputedStyle(el).display)) recordPseudo(rows, el, '::marker', state);
      if (tag === 'svg') recordGraphics(rows, el, state);

      if (tag === 'input' || tag === 'textarea') {
        var type = String(el.getAttribute('type') || 'text').toLowerCase();
        var typed = type !== 'checkbox' && type !== 'radio' && type !== 'hidden'
          && type !== 'range' && type !== 'color' && type !== 'file';
        if (typed && el.value) {
          record(rows, el, 'text', getComputedStyle(el).color, el.value, state, 'value');
        }
        if (typed && el.placeholder) {
          var ph = getComputedStyle(el, '::placeholder');
          // Chrome returns the element's own colour for ::placeholder when the
          // pseudo carries no colour of its own; either way this is the colour
          // the placeholder glyphs are painted in.
          record(rows, el, 'placeholder', ph.color || getComputedStyle(el).color,
            el.placeholder, state, 'placeholder');
        }
      }
      if (tag === 'select') {
        for (var o = 0; o < el.options.length && o < 3; o++) {
          if (el.options[o].selected) {
            record(rows, el, 'text', getComputedStyle(el).color, el.options[o].text, state, 'option');
          }
        }
      }
    }
  }

  /* ── entering a state through the cascade ─────────────────────────────── */

  /** Every style rule in the document, including inside @media / @supports. */
  function eachRule(fn) {
    function walk(list, parent) {
      for (var i = list.length - 1; i >= 0; i--) { // descending: inserting shifts
        var r = list[i];
        if (r.cssRules && r.cssRules.length) walk(r.cssRules, r);
        if (r.selectorText) fn(r, parent, i);
      }
    }
    var sheets = document.styleSheets;
    for (var s = 0; s < sheets.length; s++) {
      var rules;
      try { rules = sheets[s].cssRules; } catch (e) { continue; } // cross-origin
      if (rules) walk(rules, sheets[s]);
    }
  }

  /**
   * Every selector in the document, in order. Taken before the first state is
   * armed and again after the last is disarmed, and required to match.
   *
   * This is not belt-and-braces. Arming EDITS LIVE STYLESHEETS, and the ring
   * pass runs in a LATER evaluation against the same document — so a twin left
   * behind, or an original deleted by mistake, does not fail here: it silently
   * changes what a different instrument measures forty seconds later. That is
   * exactly what happened while this was being written (see `disarm`), and a
   * count of rules would not have caught it, because the fault deleted one and
   * left one. The selectors themselves are the evidence.
   */
  function snapshotRules() {
    var out = [];
    eachRule(function (rule) { out.push(rule.selectorText); });
    return out.join('\n');
  }

  function neutraliseTransitions() {
    var settled = /^(0s)(\s*,\s*0s)*$/;
    var witness = null;
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length && !witness; i++) {
      var d = getComputedStyle(all[i]).transitionDuration;
      if (d && !settled.test(d)) witness = all[i];
    }
    var st = document.createElement('style');
    st.setAttribute('data-cs-kill', '');
    st.textContent = '*,*::before,*::after,*::marker{'
      + 'transition:none !important;animation:none !important;}';
    document.head.appendChild(st);
    if (witness) {
      var after = getComputedStyle(witness).transitionDuration;
      if (!settled.test(after)) {
        throw new Error('contrast sweep: transitions not neutralised (reads ' + after
          + ') — a state read would return the transition START, not the settled value');
      }
    }
    return st;
  }

  /**
   * The compound the pseudo-class is attached to, with the pseudo removed —
   * i.e. the element that would BE hovered. `a:hover span` arms the `a`, not
   * the span, so the twin `a[data-cs-hover] span` matches what the real rule
   * would have.
   */
  function armTarget(sel, re) {
    re.lastIndex = 0;
    var m = re.exec(sel);
    if (!m) return null;
    var head = sel.slice(0, m.index);
    var tail = sel.slice(m.index + m[0].length);
    var j = 0;
    while (j < tail.length && !/[\s>+~,(]/.test(tail[j])) j += 1;
    return (head + tail.slice(0, j)).trim() || '*';
  }

  function armState(state) {
    var attr = 'data-cs-' + state;
    var re = new RegExp(':' + state + '(?![\\w-])', 'g');
    var inserted = [];
    var armed = [];
    eachRule(function (rule, parent, index) {
      var sel = rule.selectorText;
      if (!sel || sel.indexOf(':' + state) < 0) return;
      var kept = [];
      var parts = sel.split(',');
      for (var p = 0; p < parts.length; p++) {
        var one = parts[p].trim();
        re.lastIndex = 0;
        if (!re.test(one)) continue;
        var target = armTarget(one, re);
        if (!target) continue;
        var hit;
        try { hit = document.querySelectorAll(target); } catch (e) { continue; }
        for (var h = 0; h < hit.length; h++) {
          if (!hit[h].hasAttribute(attr)) { hit[h].setAttribute(attr, ''); armed.push(hit[h]); }
        }
        kept.push(one.replace(re, '[' + attr + ']'));
      }
      if (!kept.length) return;
      try {
        parent.insertRule(kept.join(',') + '{' + rule.style.cssText + '}', index + 1);
        // Keep the RULE OBJECT, never the index it went in at. Twins are
        // inserted at descending indices across one sheet, so every later
        // insertion shifts every earlier one; deleting by the recorded index
        // therefore destroys an ORIGINAL rule and leaves the twin behind
        // permanently. Measured, not reasoned: it silently deleted
        // verbatim.css's dark-panel focus rule, and the ring pass — which
        // runs long after this source returns — reported the Verbatim
        // controls at 3.38:1 on the global teal-700 ring instead of 7.42:1
        // on their own, across 60 of 368 focus indicators.
        inserted.push({ parent: parent, rule: parent.cssRules[index + 1] });
      } catch (e) { /* a selector Chrome will not re-parse; the arming still stands */ }
    });
    return { attr: attr, inserted: inserted, armed: armed };
  }

  function disarm(handle) {
    for (var i = 0; i < handle.inserted.length; i++) {
      var ins = handle.inserted[i];
      try {
        var at = Array.prototype.indexOf.call(ins.parent.cssRules, ins.rule);
        if (at >= 0) ins.parent.deleteRule(at);
      } catch (e) { /* already gone */ }
    }
    for (var a = 0; a < handle.armed.length; a++) handle.armed[a].removeAttribute(handle.attr);
  }

  /* ── the sweep ────────────────────────────────────────────────────────── */

  var rows = [];
  collect(rows, 'rest');       // FIRST, and with nothing injected: the rest row
                               // set is byte-identical to every baseline taken
                               // before S3b-3.
  var sheetsBefore = snapshotRules();
  var kill = neutraliseTransitions();
  try {
    for (var s = 0; s < STATES.length; s++) {
      var handle = armState(STATES[s]);
      try {
        if (handle.armed.length) collect(rows, STATES[s]);
      } finally {
        disarm(handle);
      }
    }
  } finally {
    if (kill.parentNode) kill.parentNode.removeChild(kill);
  }
  if (snapshotRules() !== sheetsBefore) {
    throw new Error('contrast sweep: the state passes did not restore the '
      + 'stylesheets they edited — every later measurement on this page, the '
      + 'focus-ring pass included, would be taken against a document the '
      + 'browser never served');
  }
  var leftArmed = document.querySelectorAll('[data-cs-hover],[data-cs-active],'
    + '[data-cs-focus-within],style[data-cs-kill]').length;
  if (leftArmed) {
    throw new Error('contrast sweep: ' + leftArmed + ' element(s) left armed');
  }
  return rows;
}

/**
 * Tag every focusable with an index and record its RESTING styles, so the ring
 * pass can report what actually changed when focus arrived — including a fill
 * change, which is one of the two things tokens.css:995-998 says does not
 * happen.
 */
/**
 * Drop focus before the resting styles are read, and — critically — do it in a
 * SEPARATE evaluation from the read.
 *
 * Two pages take focus on load: login.html:67 `autofocus` and test.js:203
 * `input.focus()`. Their fields carry `transition: border-color .12s`
 * (login.html:26, tokens.css:1008), so a `getComputedStyle` in the same turn as
 * the `blur()` returns the transition's START value — which is the FOCUSED
 * colour. The rest snapshot then equals the focus snapshot, the border
 * indicator diffs to "unchanged", and both fields report a phantom
 * "glow only, 1.13:1 FAIL" against a ring that is really 5.47:1.
 *
 * The caller must sleep past --dur-1 between this and tagFocusables(). This is
 * the same trap as reading a FORCED :focus-visible without sleeping, which has
 * already cost this repo a session — it just bites in the other direction.
 */
function blurActive() {
  try {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  } catch (_) { /* nothing focusable to blur */ }
  return document.activeElement ? document.activeElement.tagName.toLowerCase() : null;
}

function tagFocusables(parseColorFn, compositeOverFn) {
  var SEL = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
  var els = document.querySelectorAll(SEL);
  var out = [];
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    el.setAttribute('data-pc-i', String(i));
    var cs = getComputedStyle(el);
    out.push({
      i: i,
      tag: el.tagName.toLowerCase(),
      cls: el.getAttribute('class') || '',
      restBackground: cs.backgroundColor,
      restBorderColor: cs.borderTopColor,
      restBorderWidth: cs.borderTopWidth,
      restOutlineStyle: cs.outlineStyle,
      restBoxShadow: cs.boxShadow,
    });
  }
  return out;
}

/**
 * Read the focus indicator on whatever currently has focus. Called after a REAL
 * Tab keypress dispatched over CDP — programmatic .focus() does not reliably
 * match :focus-visible on a button, and the portal's ring is :focus-visible.
 */
function readFocusRing(parseColorFn, compositeOverFn) {
  var WHITE = { r: 255, g: 255, b: 255, a: 1 };
  var el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;

  function opacityChain(n) {
    var chain = [];
    var acc = 1;
    while (n && n.nodeType === 1) {
      var o = parseFloat(getComputedStyle(n).opacity);
      acc *= (isFinite(o) ? o : 1);
      chain.push({ el: n, acc: acc });
      n = n.parentElement;
    }
    return chain;
  }
  function backdropFrom(start) {
    var chain = opacityChain(start);
    var layers = [];
    for (var i = 0; i < chain.length; i++) {
      var cs = getComputedStyle(chain[i].el);
      var c = parseColorFn(cs.backgroundColor);
      if (!c) continue;
      var a = c.a * chain[i].acc;
      if (a <= 0) continue;
      layers.push({ r: c.r, g: c.g, b: c.b, a: a });
      if (a >= 1) break;
    }
    var out = WHITE;
    for (var k = layers.length - 1; k >= 0; k--) out = compositeOverFn(layers[k], out);
    return { r: out.r, g: out.g, b: out.b, a: 1 };
  }
  function pathOf(n) {
    var parts = [];
    while (n && n.nodeType === 1 && parts.length < 5) {
      var seg = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(seg + '#' + n.id); break; }
      var cls = (n.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      if (cls.length) seg += '.' + cls.slice(0, 2).join('.');
      parts.unshift(seg);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  var cs = getComputedStyle(el);
  return {
    page: location.pathname.split('/').pop() || 'index.html',
    i: el.getAttribute('data-pc-i'),
    sel: pathOf(el),
    label: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    matchesFocusVisible: (function () {
      try { return el.matches(':focus-visible'); } catch (_) { return null; }
    })(),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor,
    outlineOffset: cs.outlineOffset,
    boxShadow: cs.boxShadow,
    borderColor: cs.borderTopColor,
    borderWidth: cs.borderTopWidth,
    background: cs.backgroundColor,
    // What the ring is drawn ON: with a positive outline-offset the gap shows
    // the ANCESTOR backdrop on both sides of the stroke, so that is the
    // adjacent colour SC 1.4.11 is about.
    outerBackdrop: backdropFrom(el.parentElement || document.body),
    innerBackdrop: backdropFrom(el),
  };
}

/**
 * Serialise an in-page function together with the two colour helpers it needs,
 * via Function.prototype.toString(). Building the source this way instead of
 * from a template literal is deliberate: a backtick inside a template literal
 * terminates it, and that has silently broken a probe in this repo more than
 * once.
 */
function buildSource(fn, argJson) {
  return '(function(){\n'
    + parseColor.toString() + '\n'
    + compositeOver.toString() + '\n'
    + 'return (' + fn.toString() + ')(parseColor, compositeOver'
    + (argJson === undefined ? '' : ', ' + argJson) + ');\n'
    + '})()';
}

/* ──────────────────────────────────────────────────────────────────────────
 * The D-016 contract, and the verdict.
 * ────────────────────────────────────────────────────────────────────────── */

/** #A8A199 — `--ink-faint`. NON-TEXT ONLY by written contract (D-016 §2). */
const INK_FAINT = '#A8A199';

/** Thresholds, named so a caller cannot pass 4.5 where 3 was meant. */
const AA_BODY = 4.5;
const AA_LARGE = 3;
const AA_NON_TEXT = 3;

function sameColor(a, b) {
  if (!a || !b) return false;
  return Math.round(a.r) === Math.round(b.r)
    && Math.round(a.g) === Math.round(b.g)
    && Math.round(a.b) === Math.round(b.b);
}

/**
 * Score raw sweep rows. Pure — no DOM, no I/O — which is what makes the
 * thresholds testable offline and the live run reproducible from its JSON.
 *
 * A row fails on THRESHOLD when its measured ratio is below the floor its own
 * size and weight select. A row violates the CONTRACT when its declared glyph
 * colour is --ink-faint, whatever it scored: measured here, #A8A199 is 2.41:1
 * on paper (#FAF8F5) and 2.55:1 on a white card, so it clears no text floor at
 * all — but on a light enough chip the same hex can be arranged to clear 3:1,
 * and a threshold would then wave it through onto a heading. The contract is
 * not a threshold and must not be enforced as one.
 */
/**
 * EXEMPTIONS — an explicit, named allowlist, and nothing else.
 *
 * SC 1.4.11 does not ask every graphic to clear 3:1. It exempts inactive
 * components outright, it exempts pure decoration, and it asks only for the
 * parts of a graphic REQUIRED to understand the content — so an icon whose
 * meaning is carried by the label beside it is not in scope. Measuring every
 * icon and then failing all of them would print a wrong verdict with the same
 * authority as a right one.
 *
 * The mechanism is deliberately dumb: a list of literal descriptors, each
 * carrying the NAME of the thing it exempts, WHY, and the CLAUSE it rests on.
 * No heuristic — a rule like `has a text sibling` would silently acquire and
 * lose members as markup moves, and nobody would ever be told. Anything not on
 * the list is scored.
 *
 * An exempted row is still MEASURED, still counted in `pairs`, and still
 * emitted into the signature on its own EXEMPT line. "We did not look" and
 * "we looked and chose not to fail it" must not be the same entry, and adding
 * or removing an exemption must move the md5 the gate is judged on.
 */
function normaliseExempt(list) {
  const out = [];
  for (const e of list || []) {
    if (!e || !e.name || !e.why || !e.sc) {
      throw new Error('contrast exemption needs { name, why, sc } — an unnamed or '
        + 'unjustified suppression is indistinguishable from a bug: '
        + JSON.stringify(e));
    }
    const narrows = ['role', 'sel', 'color', 'bg', 'opacity', 'state']
      .filter((k) => e[k] !== undefined);
    if (!narrows.length) {
      throw new Error(`contrast exemption ${e.name} narrows on nothing — it would `
        + 'exempt the whole surface');
    }
    out.push(e);
  }
  return out;
}

/** True when EVERY field the entry declares matches the row. */
function exemptionMatches(e, row) {
  if (e.role !== undefined && row.role !== e.role) return false;
  if (e.state !== undefined && (row.state || 'rest') !== e.state) return false;
  if (e.color !== undefined && row.color !== e.color) return false;
  if (e.opacity !== undefined && row.opacity !== e.opacity) return false;
  if (e.bg !== undefined && bgKey(row.bg) !== e.bg) return false;
  if (e.sel !== undefined) {
    const sel = String(row.sel || '');
    if (e.sel instanceof RegExp ? !e.sel.test(sel) : !sel.includes(e.sel)) return false;
  }
  return true;
}

function judge(rows, opts) {
  const o = opts || {};
  const inkFaint = parseColor(o.inkFaint || INK_FAINT);
  const exemptions = normaliseExempt(o.exempt);
  const measured = [];
  const failures = [];
  const exempt = [];
  const contract = [];
  const undeterminable = [];

  for (const row of rows) {
    const declared = parseColor(row.color);
    const bg = row.bg && row.bg.r !== undefined ? { ...row.bg, a: 1 } : parseColor(row.bg);
    if (!declared || !bg) { undeterminable.push({ ...row, why: 'unparseable colour' }); continue; }

    const opacity = row.opacity === undefined ? 1 : row.opacity;
    const fg = compositeOver({ ...declared, a: declared.a * opacity }, bg);
    const ratio = contrastRatio({ r: fg.r, g: fg.g, b: fg.b }, bg);
    const large = isLargeText(row.px, row.weight);
    // SC 1.4.11's 3:1 covers focus indicators AND graphics. An icon judged at
    // 4.5 would be a wrong verdict printed with the same authority as a right
    // one, which is worse than not measuring it at all.
    const nonText = row.role === 'ring' || row.role === 'graphic';
    const floor = nonText ? AA_NON_TEXT : (large ? AA_LARGE : AA_BODY);

    const scored = {
      ...row,
      ratio: Math.round(ratio * 100) / 100,
      large,
      floor,
      pass: ratio >= floor,
    };
    if (row.imageBacked) {
      // The stack contained a background-image. The colour underneath is not
      // recoverable from computed style, so the number is reported but is not
      // allowed to certify anything.
      undeterminable.push({ ...scored, why: 'background-image in the backdrop stack' });
    }
    measured.push(scored);
    if (!scored.pass && !row.imageBacked) {
      const hit = exemptions.find((e) => exemptionMatches(e, scored));
      if (hit) exempt.push({ ...scored, exemptedBy: hit.name, why: hit.why, sc: hit.sc });
      else failures.push(scored);
    }
    // D-016 says --ink-faint is NON-TEXT ONLY. An icon painted in it is the
    // permitted use, not the violation, so `graphic` rows are exempt — the
    // contract is about glyphs. Extending the sweep to SVG paint without this
    // would have manufactured contract violations out of compliant icons.
    if (row.role !== 'graphic' && sameColor(declared, inkFaint)) {
      contract.push({ ...scored, why: '--ink-faint resolved as a glyph colour' });
    }
  }

  return {
    measured,
    failures,
    exempt,
    contract,
    undeterminable,
    pairs: uniquePairs(measured),
  };
}

/**
 * Distinct (glyph colour, backdrop, size band) triples. Reported alongside the
 * element count because D-016's surviving number — 532 — does not say which of
 * the two it counted, and a later session should not have to guess again.
 */
function uniquePairs(measured) {
  const seen = new Set();
  for (const m of measured) {
    seen.add([
      m.color,
      Math.round(m.bg.r) + ',' + Math.round(m.bg.g) + ',' + Math.round(m.bg.b),
      // Three bands, not two: Large text, Body text, and Non-text (a graphic,
      // at SC 1.4.11's floor). Appended, never reordered — a `rest` row's key
      // is byte-identical to the one it had before states existed, which is
      // what lets a pair count be compared across S3b-3.
      m.role === 'graphic' ? 'N' : (m.large ? 'L' : 'B'),
      m.opacity,
    ].join('|') + (m.state && m.state !== 'rest' ? '|' + m.state : ''));
  }
  return seen.size;
}

/**
 * Score one focus indicator. SC 1.4.11 asks for 3:1 between the indicator and
 * the colour ADJACENT to it. With `outline-offset: 2px` the gap shows the
 * ancestor backdrop on both sides of the stroke, so that is the comparison;
 * where the indicator is a border rather than an outline, the inside neighbour
 * is the control's own fill and both are reported.
 */
function judgeRing(ring, rest) {
  const outer = { ...ring.outerBackdrop, a: 1 };
  const inner = { ...ring.innerBackdrop, a: 1 };
  const out = {
    page: ring.page,
    sel: ring.sel,
    label: ring.label,
    matchesFocusVisible: ring.matchesFocusVisible,
    indicators: [],
    fillChanged: false,
    fillRatio: null,
    // Kept in the report, not just used: "no indicator" and "the indicator did
    // not move" are different findings, and without the resting values beside
    // the focused ones a reader cannot tell which one they are looking at.
    focused: {
      border: ring.borderColor, borderWidth: ring.borderWidth,
      background: ring.background, boxShadow: ring.boxShadow,
      outline: ring.outlineStyle + ' ' + ring.outlineWidth + ' ' + ring.outlineColor,
    },
    rest: rest ? {
      border: rest.restBorderColor, borderWidth: rest.restBorderWidth,
      background: rest.restBackground, boxShadow: rest.restBoxShadow,
      outline: rest.restOutlineStyle,
    } : null,
  };

  const outlineOn = ring.outlineStyle && ring.outlineStyle !== 'none'
    && parseFloat(ring.outlineWidth) > 0;
  if (outlineOn) {
    const c = parseColor(ring.outlineColor);
    if (c) {
      out.indicators.push({
        kind: 'outline',
        css: ring.outlineWidth + ' ' + ring.outlineStyle + ' ' + ring.outlineColor
             + ' @ ' + ring.outlineOffset,
        color: ring.outlineColor,
        against: 'outer backdrop',
        ratio: round2(contrastRatio(rgb(compositeOver(c, outer)), outer)),
      });
    }
  }

  // A border that MOVED on focus is an indicator; a border that did not is
  // furniture. Comparing against the resting value is the only way to tell.
  if (rest && rest.restBorderColor && ring.borderColor !== rest.restBorderColor
      && parseFloat(ring.borderWidth) > 0) {
    const c = parseColor(ring.borderColor);
    if (c) {
      out.indicators.push({
        kind: 'border',
        css: ring.borderWidth + ' ' + ring.borderColor
             + ' (rest ' + rest.restBorderColor + ')',
        color: ring.borderColor,
        against: 'inner fill / outer backdrop',
        ratio: round2(contrastRatio(rgb(compositeOver(c, inner)), inner)),
        ratioOuter: round2(contrastRatio(rgb(compositeOver(c, outer)), outer)),
      });
    }
  }

  for (const layer of parseBoxShadow(ring.boxShadow)) {
    if (layer.inset) continue;
    if (layer.spread <= 0 && layer.blur <= 0) continue;
    const c = parseColor(layer.color);
    if (!c) continue;
    const against = layer.spread > 0 ? outer : inner;
    out.indicators.push({
      kind: 'glow',
      css: layer.offsetX + 'px ' + layer.offsetY + 'px ' + layer.blur + 'px '
           + layer.spread + 'px ' + layer.color,
      color: layer.color,
      alpha: c.a,
      against: layer.spread > 0 ? 'outer backdrop' : 'inner fill',
      ratio: round2(contrastRatio(rgb(compositeOver(c, against)), against)),
    });
  }

  if (rest && rest.restBackground && ring.background !== rest.restBackground) {
    const a = parseColor(rest.restBackground);
    const b = parseColor(ring.background);
    out.fillChanged = true;
    if (a && b) {
      out.fillRatio = round2(contrastRatio(
        rgb(compositeOver(a, outer)), rgb(compositeOver(b, outer))
      ));
    }
  }

  out.best = out.indicators.reduce(function (m, x) {
    return Math.max(m, Math.max(x.ratio || 0, x.ratioOuter || 0));
  }, 0);
  out.pass = out.indicators.length > 0 && out.best >= AA_NON_TEXT;
  return out;
}

function rgb(c) { return { r: c.r, g: c.g, b: c.b }; }
function round2(n) { return Math.round(n * 100) / 100; }

/* ──────────────────────────────────────────────────────────────────────────
 * Signature emission.
 *
 * A run's INVARIANT is its set of distinct shapes, not its counts. S2 measured
 * five sweeps of the same tree whose row counts read 2302 / 2325 / 2339 / 2347
 * — readiness races, since closed — and the distinct-pair signature was
 * byte-identical across all five. So the signature deliberately drops every
 * multiplicity: how MANY elements paint `--faint` on `--card` is a fact about
 * the page's content, while WHICH colour lands on which backdrop at which ratio
 * is a fact about the visual system, and only the second is what a refactor of
 * this engine must preserve.
 *
 * It covers all four verdict channels, because each can move independently:
 * a threshold failure, a contract violation, a backdrop the engine refused to
 * certify, and a focus indicator. Ring shapes are included precisely because
 * their ratios are computed through the same backdrop walk as the glyph rows —
 * a broken composite shows up there even when no glyph row crosses a floor.
 *
 * Input is the shape `judge()` returns (plus `rings`), which is also the shape
 * a driver writes to disk, so a signature can be recomputed from a stored
 * report months later without a browser.
 *
 * `exempt` is deliberately NOT a fifth channel here, and re-adding it would be
 * a mistake worth naming. The portal's driver — `scripts/portal/shoot.js:667`
 * — serialises `failures`, `contract`, `undeterminable` and `rings` and knows
 * nothing about exemptions, so a signature taken from a `judge()` return in
 * process and a signature taken from that driver's own report would differ by
 * the EXEMPT lines alone. One artefact with two ways to compute it is the
 * drift this whole file exists to prevent, and the gate has to read the
 * driver's report. The allowlist is still fully visible in the hash: silencing
 * a shape REMOVES its FAIL line, which moves the md5 — measured, by exempting
 * `.holiday__remove` on purpose and watching `FAIL 2.60:1 ... [graphic]`
 * disappear. What the list itself says lives in `portalContrast.js`, next to
 * the reasons.
 * ────────────────────────────────────────────────────────────────────────── */

function bgKey(bg) {
  if (!bg) return 'null';
  if (typeof bg === 'string') return bg;
  return Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b);
}

function ratioText(n) {
  return typeof n === 'number' && isFinite(n) ? n.toFixed(2) : String(n);
}

/** The distinct shape of one threshold failure: pair, band, opacity, verdict. */
function failureShape(f) {
  return ratioText(f.ratio) + ':1 needs ' + f.floor + '  '
    + f.color + ' on rgb(' + bgKey(f.bg) + ')'
    + (f.large ? ' [large]' : '')
    + (f.role === 'graphic' ? ' [graphic]' : '')
    + (f.opacity !== undefined && f.opacity !== 1 ? ' @op' + f.opacity : '')
    // Appended last so a rest text row's shape is byte-identical to the one it
    // had before S3b-3: a signature diff across this change shows only NEW
    // coverage, never a reformatting of what was already there.
    + (f.state && f.state !== 'rest' ? ' :' + f.state : '');
}

/** The distinct shape of one focus indicator, drawn through the same walk. */
function ringShape(r) {
  const inds = (r.indicators || []).map(function (x) {
    return x.kind + ' ' + ratioText(x.ratio)
      + (x.ratioOuter === undefined ? '' : '/' + ratioText(x.ratioOuter))
      + ' vs ' + x.against + '  ' + x.css;
  });
  return (r.pass ? 'PASS' : 'FAIL') + ' ' + ratioText(r.best)
    + (r.fillChanged ? '  fill@' + ratioText(r.fillRatio) : '')
    + '  [' + (inds.length ? inds.join(' | ') : 'no indicator') + ']';
}

function sortedUnique(list) {
  return [...new Set(list)].sort();
}

/**
 * Reduce a run to its distinct shapes and hash them. `lines` is the human
 * artifact — a diff of two runs says exactly which shape moved — and `md5` is
 * the single value a refactor is judged on.
 */
function signature(report) {
  const r = report || {};
  const lines = [];
  for (const s of sortedUnique((r.failures || []).map(failureShape))) lines.push('FAIL      ' + s);
  for (const s of sortedUnique((r.contract || []).map(function (c) {
    return c.why + '  ' + c.color + ' on rgb(' + bgKey(c.bg) + ')  ' + ratioText(c.ratio) + ':1';
  }))) lines.push('CONTRACT  ' + s);
  for (const s of sortedUnique((r.undeterminable || []).map(function (u) {
    return u.why + '  ' + u.color + ' on rgb(' + bgKey(u.bg) + ')';
  }))) lines.push('UNDET     ' + s);
  for (const s of sortedUnique((r.rings || []).map(ringShape))) lines.push('RING      ' + s);
  const body = lines.join('\n') + '\n';
  return { lines, body, md5: crypto.createHash('md5').update(body, 'utf8').digest('hex') };
}

module.exports = {
  parseColor,
  compositeOver,
  relativeLuminance,
  contrastRatio,
  isLargeText,
  parseBoxShadow,
  judge,
  judgeRing,
  uniquePairs,
  buildSource,
  sweepPage,
  blurActive,
  tagFocusables,
  readFocusRing,
  TEXT_SWEEP_SOURCE: buildSource(sweepPage),
  BLUR_SOURCE: buildSource(blurActive),
  TAG_FOCUSABLES_SOURCE: buildSource(tagFocusables),
  READ_RING_SOURCE: buildSource(readFocusRing),
  INK_FAINT,
  AA_BODY,
  AA_LARGE,
  AA_NON_TEXT,
  signature,
  failureShape,
  ringShape,
};
