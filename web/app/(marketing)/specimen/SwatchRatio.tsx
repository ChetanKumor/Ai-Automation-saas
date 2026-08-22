"use client";

import { useEffect, useState } from "react";
import { contrast } from "./tokens";

/* ============================================================================
 * The caption on the two --ink-faint demo swatches, MEASURED rather than typed.
 *
 * The rest of this route captions from a table on purpose: `tokens.ts` records
 * what globals.css declares, the page paints with var(--token), and a caption
 * that disagrees with the swatch beside it is the drift becoming visible. That
 * works because those captions describe a DECLARATION.
 *
 * These two did not describe a declaration. They described a computed
 * relationship between two tokens — "--ink-faint · 2.21:1 on sunk" — and phase
 * 6 then made both tokens conditional on `prefers-contrast: more`. The
 * relationship became 3.42 and 8.08 in that mode; the literals did not move, so
 * the page asserted a false number to precisely the reader who had asked the
 * browser for more contrast. A caption that can only be true in one media state
 * is not a caption, it is a stale measurement.
 *
 * So this measures what is actually on screen. It does not read the tokens: it
 * reads the computed `color` and `backgroundColor` of the swatch it labels,
 * which is the pair a reader's eye is being asked to separate. Change a token,
 * change the media state, or re-point the swatch at another ground, and the
 * number follows without anybody remembering to update it.
 *
 * WHY IT IS A CLIENT ISLAND. `prefers-contrast` is resolved by the browser,
 * against the reader's OS, at paint. No server render can know it. The initial
 * value is still computed rather than hardcoded — the server passes the pair
 * from the same `tokens.ts` table the palette renders from — so the markup is
 * right on arrival for the normal-contrast case and identical on both sides of
 * hydration; the effect then re-reads the live values and corrects the
 * high-contrast case. A reader with JavaScript off keeps the honest
 * normal-contrast number, which is what the page shipped with.
 *
 * The verdict is derived from the ratio and never passed in — the same rule
 * `verdict()` follows one file over. 4.5:1, because this swatch is body-sized
 * text: a name and a timestamp, which is exactly the use the callout above
 * rules out for --ink-faint.
 * ========================================================================== */

export function SwatchRatio({
  token,
  ground,
  initialFg,
  initialBg,
  className,
}: {
  /** The token NAME, for the label. Set on the swatch by CSS; not measured. */
  token: string;
  /** The ground's short name, for the label. Also not measured. */
  ground: string;
  /** The declared value of `token`, from tokens.ts. Server-render seed only. */
  initialFg: string;
  /** The declared value of the ground, from tokens.ts. Server-render seed only. */
  initialBg: string;
  className?: string;
}) {
  const [ratio, setRatio] = useState(() => contrast(initialFg, initialBg));
  const [node, setNode] = useState<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!node) return;
    // This <span> is the label; its PARENT is the swatch carrying the pair.
    const swatch = node.parentElement;
    if (!swatch) return;

    const measure = () => {
      const cs = getComputedStyle(swatch);
      setRatio(contrast(cs.color, cs.backgroundColor));
    };
    measure();

    // `prefers-contrast` can change while the page is open — an OS setting, a
    // devtools emulation, a window dragged to another display. Re-measure
    // rather than assume mount was the last word.
    const mqs = ["(prefers-contrast: more)", "(prefers-contrast: less)"].map((q) =>
      window.matchMedia(q)
    );
    for (const mq of mqs) mq.addEventListener("change", measure);
    return () => {
      for (const mq of mqs) mq.removeEventListener("change", measure);
    };
  }, [node]);

  const shown = Number.isFinite(ratio) ? ratio.toFixed(2) : "?";
  const ok = Number.isFinite(ratio) && ratio >= 4.5;

  return (
    <span ref={setNode} className={className} data-swatch-ratio={token}>
      {token} · {shown}:1 on {ground} · {ok ? "CORRECT" : "WRONG"}
    </span>
  );
}
