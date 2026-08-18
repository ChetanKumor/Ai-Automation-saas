// ─────────────────────────────────────────────────────────────────────────────
// PLAYBACK — the thing that walks `activeIndex` forward over time.
//
// FOUR STATES: idle · playing · paused · complete. `switching` is phase 4 and
// `silent` is phase 7; neither is modelled here, and neither should be added
// speculatively — a state with no control that reaches it is a state nobody
// has looked at.
//
// THE CLOCK IS ONE ACCUMULATED NUMBER, and every visible thing is derived from
// it by `frameAt`. That is deliberate and it is what makes the three behavioural
// rules true rather than approximately true:
//
//   PAUSE FREEZES. Pausing cancels the rAF and stops accumulating. It does not
//   round to a phrase boundary, does not settle, does not rewind. Resuming
//   starts accumulating again from the identical number, so a pause halfway
//   through a phrase resumes halfway through that phrase.
//
// The alternative — a chain of setTimeouts advancing a cursor — cannot do that
// without bookkeeping the remaining time of the in-flight timer, which is the
// same accumulator written less honestly.
//
// requestAnimationFrame, not setInterval: it is the presentation clock, so the
// number the frame is derived from is the number the frame is painted at. It
// also stops when the tab is hidden, which is the behaviour you want — a
// conversation should not have played itself out in a background tab.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTimeline, frameAt, CROSSFADE_MS, type Frame, type Timeline } from "./cadence";
import type { LangCode, Turn } from "./types";

export type PlaybackState = "idle" | "playing" | "paused" | "complete";

export interface Playback {
  state: PlaybackState;
  activeIndex: number;
  revealed: number;
  /** True during the 150ms `complete` → `idle` dissolve that Replay runs. */
  crossfading: boolean;
  reduced: boolean;
  /** Total sequence length in ms — reported, not just modelled. */
  totalMs: number;
  toggle: () => void;
}

/** Where a turn begins in a timeline. `total` once every turn has landed, which
 *  is what keeps a finished sequence finished when the language changes under
 *  it. There is deliberately no phrase argument: see the re-anchor below. */
function turnStart(tl: Timeline, turn: number): number {
  const step = tl.steps.find((s) => s.turn === turn);
  return step ? step.start : tl.total;
}

/** Live, not read-once: a reader can change the OS setting with the page open,
 *  and the sequence should honour it from the next frame. Starts `false` so the
 *  server-rendered idle frame and the first client frame agree — at idle every
 *  phrase is at rest either way, so there is nothing to mismatch. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export function usePlayback(turns: Turn[], lang: LangCode): Playback {
  const reduced = useReducedMotion();
  const tl = useMemo(() => buildTimeline(turns, lang), [turns, lang]);

  const [state, setState] = useState<PlaybackState>("idle");
  const [frame, setFrame] = useState<Frame>(() => frameAt(0, tl));
  const [crossfading, setCrossfading] = useState(false);

  const elapsed = useRef(0);
  const lastTs = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  /** The timeline `elapsed` is currently a number of milliseconds INTO. Not the
   *  same thing as `tl`, which is the timeline the next render will use — the
   *  two differ for exactly as long as it takes the effect below to reconcile
   *  them, and the difference is the whole subject of that effect. */
  const anchored = useRef(tl);

  const stop = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    lastTs.current = null;
  }, []);

  const tick = useCallback(
    (ts: number) => {
      if (lastTs.current === null) lastTs.current = ts;
      elapsed.current += ts - lastTs.current;
      lastTs.current = ts;
      setFrame(frameAt(elapsed.current, tl));
      if (elapsed.current >= tl.total) {
        raf.current = null;
        lastTs.current = null;
        setState("complete");
        return;
      }
      raf.current = requestAnimationFrame(tick);
    },
    [tl]
  );

  const run = useCallback(() => {
    lastTs.current = null;
    setState("playing");
    raf.current = requestAnimationFrame(tick);
  }, [tick]);

  // ─── THE LANGUAGE CHANGED UNDER A RUNNING CLOCK ────────────────────────────
  //
  // `tick` schedules its own successor, so the chain in flight is a chain of ONE
  // closure — the one built with the timeline that was current when it started.
  // Rebuilding `tl` does not reach it. Without this effect a reader who switches
  // to English watches English words arrive on Telugu's cadence for the rest of
  // the sequence, and nothing visible contradicts it: the two totals are 4ms
  // apart on purpose, so `totalMs` changes and means nothing.
  //
  // RE-ANCHOR, THEN RESTART. `elapsed` is a position in ONE timeline; carried
  // across unchanged it names a different place in the other. It moves to the
  // start of the turn the reader is in, which is the only translation between
  // the two clocks that is defensible — the turn is the unit both languages
  // agree on, and the phrase boundaries inside it are precisely what they do
  // not. So the turn restarts, in the new language, and the sequence runs out
  // from there. That is also the honest thing to show: half a Telugu sentence
  // followed by the tail of its English translation is a rendering of neither.
  //
  // ONLY A CHAIN IN FLIGHT IS RESTARTED, and `raf.current` is what says so —
  // NOT `state`. During the Replay crossfade the state is already "playing"
  // while no chain has started, and calling `run()` there would leave the
  // pending timer free to start a second one; two chains accumulating into one
  // `elapsed` play the sequence at double speed. Paused, idle and complete need
  // no restart for the same reason from the other side: they re-anchor and wait,
  // so a language chosen while paused is already in force when Play is pressed.
  useEffect(() => {
    const prev = anchored.current;
    if (prev === tl) return;
    anchored.current = tl;
    const { activeIndex } = frameAt(elapsed.current, prev);
    elapsed.current = turnStart(tl, activeIndex);
    setFrame(frameAt(elapsed.current, tl));
    if (raf.current !== null) {
      stop();
      run();
    }
  }, [tl, stop, run]);

  const toggle = useCallback(() => {
    if (state === "playing") {
      // FREEZE. Nothing is rounded and nothing is reset — `elapsed` is simply
      // left where it is. Any CSS transition already in flight finishes on its
      // own, which is correct: the transition is the presentation of a state
      // change that has already happened, not part of the timeline.
      stop();
      setState("paused");
      return;
    }
    if (state === "complete") {
      // The control morphs on the click; the thread dissolves under it and the
      // sequence restarts on the far side. Not a hard cut — enter and exit run
      // the same 150ms along the same curve.
      setState("playing");
      setCrossfading(true);
      timer.current = window.setTimeout(
        () => {
          elapsed.current = 0;
          setFrame(frameAt(0, tl));
          setCrossfading(false);
          run();
        },
        reduced ? 0 : CROSSFADE_MS
      );
      return;
    }
    // idle → play from the top; paused → carry on from the identical elapsed.
    run();
  }, [state, stop, run, tl, reduced]);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  // REDUCED MOTION IS NOT REDUCED CONTENT. The sequence still runs, at the same
  // cadence, through the same six turns — what changes is that a Prantivo turn's
  // phrases stop arriving one at a time and arrive with the turn. The timeline
  // is untouched, so the total duration is identical either way.
  const revealed = reduced ? Number.MAX_SAFE_INTEGER : frame.revealed;

  return {
    state,
    activeIndex: frame.activeIndex,
    revealed,
    crossfading,
    reduced,
    totalMs: tl.total,
    toggle,
  };
}
