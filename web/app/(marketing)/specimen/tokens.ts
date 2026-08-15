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
 * Everything below is dormant: Phase 1b adds these tokens with no consumer on
 * any shipping route. This page is the only reader.
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
      "A second token, not a repoint of --accent. On the current near-black " +
      "--ink-900 this same hex measures 3.58:1 and would fail AA for the " +
      "fifteen --accent consumers on the legal pages.",
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

/** Rows that carry a measured contrast ratio — the palette proper. */
export const PALETTE = TOKENS.filter((t) => t.ratios !== null);

export const byGroup = (g: Group) => TOKENS.filter((t) => t.group === g);
