// ─────────────────────────────────────────────────────────────────────────────
// THE CONTROL. One button, four states, and the only interactive element the
// conversation has this phase.
//
// PILL ↔ CIRCLE WITHOUT A HARDCODED WIDTH. The glyph sits in a fixed 48px
// square, and the label lives in a grid column that runs 1fr → 0fr. The button
// keeps `width: auto` throughout, so at rest it is exactly 48px + label +
// trailing padding, and collapsed it is exactly 48px — a circle, from the same
// 24px radius that made it a pill. Nothing measures text, and nothing needs
// re-measuring when phase 4 changes the label's language.
//
// THE PRESS FIRES ON POINTER-DOWN, and it fires there because it is `:active`
// and not an onClick handler. A control that lights up on click has already
// lost the interaction — the reader pressed, and the interface waited to see
// whether they would let go before admitting it noticed.
//
// `will-change` is added at pointer-down and removed when the transform
// transition ends, not left declared in the stylesheet: a permanent
// `will-change: transform` promotes the button to its own layer for the entire
// life of the page to save 100ms once.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback } from "react";
import type { PlaybackState } from "./usePlayback";
import styles from "./PlayControl.module.css";

/** Shape, glyph and accessible name per state. The label is ALWAYS in the DOM —
 *  in the circle states it is collapsed and transparent, not removed, so the
 *  button always has an accessible name and that name always says what pressing
 *  it will do next. */
const FACE: Record<PlaybackState, { label: string; shape: "pill" | "circle"; glyph: Glyph }> = {
  idle: { label: "Play the conversation", shape: "pill", glyph: "play" },
  playing: { label: "Pause", shape: "circle", glyph: "pause" },
  paused: { label: "Resume", shape: "circle", glyph: "play" },
  complete: { label: "Replay", shape: "pill", glyph: "replay" },
};

type Glyph = "play" | "pause" | "replay";

/* Drawn, not typed. ⏸ (U+23F8) and ↻ (U+21BB) are in no face this site loads,
 * so a text glyph would fall through to whatever the OS has — the same failure
 * the ₹ in the portal turned up. An inline SVG is the same colour, the same
 * size and the same on every machine. */
function Icon({ glyph }: { glyph: Glyph }) {
  return (
    <svg
      className={styles.icon}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {glyph === "play" && <path d="M8 5.2 L19 12 L8 18.8 Z" fill="currentColor" />}
      {glyph === "pause" && (
        <>
          <rect x="7" y="5.5" width="3.5" height="13" rx="1.2" fill="currentColor" />
          <rect x="13.5" y="5.5" width="3.5" height="13" rx="1.2" fill="currentColor" />
        </>
      )}
      {glyph === "replay" && (
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20.4 15.2A9 9 0 1 1 18.3 5.8L21.6 9" />
          <path d="M21.6 3.6V9h-5.4" />
        </g>
      )}
    </svg>
  );
}

export interface PlayControlProps {
  state: PlaybackState;
  onToggle: () => void;
}

export function PlayControl({ state, onToggle }: PlayControlProps) {
  const face = FACE[state];

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.style.willChange = "transform";
  }, []);

  const onTransitionEnd = useCallback((e: React.TransitionEvent<HTMLButtonElement>) => {
    // Only the press transform settling clears it. The 250ms shape morph runs
    // on other properties and must not.
    if (e.propertyName === "transform") e.currentTarget.style.willChange = "";
  }, []);

  return (
    <button
      type="button"
      className={styles.control}
      data-shape={face.shape}
      data-state={state}
      onClick={onToggle}
      onPointerDown={onPointerDown}
      onTransitionEnd={onTransitionEnd}
    >
      <span className={styles.glyph}>
        <Icon glyph={face.glyph} />
      </span>
      <span className={styles.labelWrap}>
        <span className={styles.labelText}>{face.label}</span>
      </span>
    </button>
  );
}
