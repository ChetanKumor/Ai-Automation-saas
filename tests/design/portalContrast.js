'use strict';

/* ============================================================================
 * PORTAL CONTRAST INSTRUMENT — the measuring half.
 *
 * Not a test file (no `.test.js`), so `npm test` never loads it. It is required
 * by `tests/design/portalContrast.test.js`, which exercises the pure half
 * offline, and by `scripts/portal/shoot.js --contrast`, which drives the live
 * half over CDP against the real portal.
 *
 * ── WHAT IT REPLACES ──────────────────────────────────────────────────────
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
 * ── THE D-016 CONTRACT ────────────────────────────────────────────────────
 * `--ink-faint` (#A8A199) is NON-TEXT ONLY by written contract, not by
 * threshold. `judge()` reports it as a contract violation wherever it resolves
 * as a glyph colour, independently of the ratio that glyph happens to score.
 * Today the portal is on the cool ground and #A8A199 is not in its token layer,
 * so the assertion is not yet load-bearing — it becomes load-bearing the moment
 * the ground flip imports the paper palette, which is exactly when a threshold
 * alone would let it through on a large heading at 3.02:1.
 * ========================================================================== */

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

function sweepPage(parseColorFn, compositeOverFn) {
  var WHITE = { r: 255, g: 255, b: 255, a: 1 };

  function pathOf(el) {
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      var seg = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(seg + '#' + n.id); break; }
      var cls = (n.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
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
   */
  function backdropOf(el) {
    var chain = opacityChain(el);
    var layers = [];
    var image = false;
    for (var i = 0; i < chain.length; i++) {
      var cs = getComputedStyle(chain[i].el);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') image = true;
      var c = parseColorFn(cs.backgroundColor);
      if (!c) continue;
      var a = c.a * chain[i].acc;
      if (a <= 0) continue;
      layers.push({ r: c.r, g: c.g, b: c.b, a: a });
      if (a >= 1) break; // opaque: nothing below it can show through
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

  function record(rows, el, role, colorStr, textSample) {
    var cs = getComputedStyle(el);
    if (!visible(el, cs)) return;
    var chain = opacityChain(el);
    var opacity = chain.length ? chain[chain.length - 1].acc : 1;
    if (opacity <= 0) return;
    var back = backdropOf(el);
    var scale = scaleOf(el);
    rows.push({
      page: location.pathname.split('/').pop() || 'index.html',
      sel: pathOf(el),
      role: role,
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

  var rows = [];
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'title'
        || tag === 'meta' || tag === 'link' || tag === 'head') continue;

    // Only DIRECT text children: an ancestor does not paint its descendants'
    // glyphs, and counting it would score the same glyph against the wrong box.
    var own = '';
    for (var c = 0; c < el.childNodes.length; c++) {
      if (el.childNodes[c].nodeType === 3) own += el.childNodes[c].nodeValue;
    }
    if (own.trim().length) record(rows, el, 'text', getComputedStyle(el).color, own);

    if (tag === 'input' || tag === 'textarea') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      var typed = type !== 'checkbox' && type !== 'radio' && type !== 'hidden'
        && type !== 'range' && type !== 'color' && type !== 'file';
      if (typed && el.value) record(rows, el, 'text', getComputedStyle(el).color, el.value);
      if (typed && el.placeholder) {
        var ph = getComputedStyle(el, '::placeholder');
        // Chrome returns the element's own colour for ::placeholder when the
        // pseudo carries no colour of its own; either way this is the colour
        // the placeholder glyphs are painted in.
        record(rows, el, 'placeholder', ph.color || getComputedStyle(el).color, el.placeholder);
      }
    }
    if (tag === 'select') {
      for (var o = 0; o < el.options.length && o < 3; o++) {
        if (el.options[o].selected) {
          record(rows, el, 'text', getComputedStyle(el).color, el.options[o].text);
        }
      }
    }
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
function judge(rows, opts) {
  const o = opts || {};
  const inkFaint = parseColor(o.inkFaint || INK_FAINT);
  const measured = [];
  const failures = [];
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
    const floor = row.role === 'ring' ? AA_NON_TEXT : (large ? AA_LARGE : AA_BODY);

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
    if (!scored.pass && !row.imageBacked) failures.push(scored);
    if (sameColor(declared, inkFaint)) contract.push({ ...scored, why: '--ink-faint resolved as a glyph colour' });
  }

  return {
    measured,
    failures,
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
      m.large ? 'L' : 'B',
      m.opacity,
    ].join('|'));
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
};
