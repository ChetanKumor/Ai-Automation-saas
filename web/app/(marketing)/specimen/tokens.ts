/* ============================================================================
 * The ONE table this route renders from.
 *
 * `value` is the token's value as declared in web/app/globals.css. The page
 * NEVER paints from this string — every swatch, surface and radius is painted
 * with `var(--name)`, so what you see is what the stylesheet actually holds.
 * The value here is a CAPTION.
 *
 * That split is the point. If a caption and the thing beside it ever disagree,
 * the stylesheet has drifted from the record, and it is visible on this page
 * rather than inferred from a diff. Hand-copying hexes into JSX would make this
 * file a fifth source of truth — which is the disease docs/design/brand-values.md
 * exists to cure, and it would be an odd way to document a design system to
 * introduce one more place for the same value to be wrong.
 *
 * Everything below WAS dormant: Phase 1b added these tokens with no consumer on
 * any shipping route, and this page was the only reader. Phase 2 S1 gave them
 * the four legal routes and S2 gave them the whole site, so they are live and
 * the sentence is kept as the record of where they came from.
 * ========================================================================== */

export type Group =
  | "ground"
  | "ink"
  | "functional"
  | "radius"
  | "type"
  | "track"
  | "measure"
  | "motion";

export type Verdict = "TEXT" | "LARGE-ONLY" | "NON-TEXT ONLY";

export interface TokenRow {
  name: string;
  value: string;
  group: Group;
  /** Contrast against --ground / --ground-sunk / --ground-raised. */
  ratios: readonly [number, number, number] | null;
  note?: string;
}

export const TOKENS: readonly TokenRow[] = [
  // —— Grounds. No ratio of their own: they are what everything else is
  //    measured against.
  { name: "--ground", value: "#FAF8F5", group: "ground", ratios: null },
  { name: "--ground-sunk", value: "#F2EEE8", group: "ground", ratios: null },
  { name: "--ground-raised", value: "#FFFFFF", group: "ground", ratios: null },

  // —— Ink
  { name: "--ink-strong", value: "#17150F", group: "ink", ratios: [17.22, 15.79, 18.25] },
  { name: "--ink-soft", value: "#57524A", group: "ink", ratios: [7.31, 6.7, 7.75] },
  {
    name: "--ink-faint",
    value: "#A8A199",
    group: "ink",
    ratios: [2.41, 2.21, 2.55],
    note:
      "NON-TEXT ONLY. Fails AA for text (4.5:1) and also fails 1.4.11's 3:1 " +
      "floor for a meaningful graphical object. Hairlines and undrawn states " +
      "only — never a glyph.",
  },
  {
    name: "--rule",
    value: "rgba(23, 21, 15, 0.08)",
    group: "ink",
    ratios: [1.18, 1.17, 1.18],
    note:
      "Decorative hairline. Legitimate at this ratio only because it carries " +
      "nothing required — see the speaker-identity note below.",
  },

  // —— Functional colour on a paper ground
  {
    name: "--accent-on-ground",
    value: "#0F766E",
    group: "functional",
    ratios: [5.16, 4.74, 5.47],
    note:
      "Added as a second token rather than a repoint of --accent, because on " +
      "the near-black --ink-900 this hex measured 3.58:1 and would have failed " +
      "AA for the fifteen --accent consumers on the legal pages. Phase 2 S2 " +
      "flipped that ground and repointed --accent to the same #0F766E, closing " +
      "F-F008; the two now hold one value and merging them is an S3 job.",
  },
  {
    name: "--answered",
    value: "#166534",
    group: "functional",
    ratios: [6.73, 6.17, 7.13],
    note:
      "Not the portal's green-700 #15803d, which measures 4.34:1 on " +
      "--ground-sunk and fails AA there.",
  },

  // —— Radius
  { name: "--rad-sm", value: "2px", group: "radius", ratios: null },
  { name: "--rad-md", value: "6px", group: "radius", ratios: null },
  { name: "--rad-lg", value: "10px", group: "radius", ratios: null },

  // —— Type scale
  { name: "--type-display", value: "clamp(2rem, 4.2vw, 3.75rem)", group: "type", ratios: null },
  { name: "--type-lede", value: "clamp(1rem, 1.4vw, 1.1875rem)", group: "type", ratios: null },
  { name: "--type-body", value: "clamp(1.0625rem, 1.5vw, 1.375rem)", group: "type", ratios: null },
  { name: "--type-meta", value: "0.75rem", group: "type", ratios: null },

  // —— Tracking
  { name: "--track-display", value: "-0.02em", group: "track", ratios: null },
  { name: "--track-lede", value: "-0.01em", group: "track", ratios: null },

  // —— Measure
  { name: "--measure", value: "66ch", group: "measure", ratios: null },

  // —— Motion
  { name: "--dur-emerge", value: "180ms", group: "motion", ratios: null },
  { name: "--ease-emerge", value: "cubic-bezier(0.2, 0, 0, 1)", group: "motion", ratios: null },
] as const;

/** The three grounds, derived from the one table rather than listed twice. */
export const GROUNDS = TOKENS.filter((t) => t.group === "ground");

/**
 * WCAG 2.2: 4.5:1 for normal text, 3:1 for large text (>=24px, or >=18.66px
 * bold), 3:1 for a meaningful non-text mark (1.4.11).
 *
 * Derived from the ratio rather than stored beside it, so a verdict can never
 * disagree with the number it is printed next to.
 */
export function verdict(ratio: number): Verdict {
  if (ratio >= 4.5) return "TEXT";
  if (ratio >= 3) return "LARGE-ONLY";
  return "NON-TEXT ONLY";
}

/**
 * WCAG 2.x relative luminance and contrast, over `rgb()` / `rgba()` / `#rrggbb`.
 *
 * It exists so the two --ink-faint demo swatches below the palette can print a
 * ratio they DERIVED instead of one somebody typed. Both labels used to carry a
 * literal — 2.21 and 6.70 — measured at normal contrast, and phase 6's
 * `prefers-contrast: more` block moved both tokens underneath them (3.42 and
 * 8.08). The numbers went on being rendered and went on being wrong, on the one
 * page whose entire job is to be right about contrast.
 *
 * Alpha is composited over white rather than over the true backdrop: nothing
 * this is asked to measure is translucent, and a wrong answer on a translucent
 * input would be better than a silently plausible one. Returns NaN on anything
 * it cannot parse, which the caller renders as "?" rather than as a number.
 */
export function contrast(a: string, b: string): number {
  const rgb = (c: string): [number, number, number] | null => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (p.length < 3 || p.slice(0, 3).some(Number.isNaN)) return null;
      const alpha = p.length > 3 && !Number.isNaN(p[3]) ? p[3] : 1;
      return [p[0], p[1], p[2]].map((v) => v * alpha + 255 * (1 - alpha)) as [number, number, number];
    }
    const h = String(c).trim().replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  };
  const lum = (c: [number, number, number]) => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return NaN;
  const lx = lum(x);
  const ly = lum(y);
  return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
}

/** Rows that carry a measured contrast ratio — the palette proper. */
export const PALETTE = TOKENS.filter((t) => t.ratios !== null);

export const byGroup = (g: Group) => TOKENS.filter((t) => t.group === g);
