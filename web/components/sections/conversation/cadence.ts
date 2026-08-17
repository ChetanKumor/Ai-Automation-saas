// ─────────────────────────────────────────────────────────────────────────────
// CADENCE — how long the conversation takes, as a model rather than a table of
// hardcoded numbers.
//
// Phase 4 adds English and Hindi. Those strings have different lengths, so a
// per-turn duration table authored against Telugu would be wrong for both the
// day it landed. What is actually language-specific is ONE number — how fast
// this script reads — so that is the only thing stored per language:
//
//     phraseDuration_ms = max(MIN_PHRASE_MS, chars / CPS * 1000)
//
// CPS lives HERE, beside te.json and meta.json, not in the component. Phase 4
// adds two more entries to the same object and nothing else moves.
//
// WHY CHARACTERS AND NOT WORDS. Telugu does not space-delimit the way Latin
// does, and `String.length` over Telugu counts combining matras as separate
// code units — so a Telugu string reads "longer" than a Latin one carrying the
// same meaning. That is fine, and it is exactly why CPS is per-language: the
// unit does not have to mean the same thing across scripts, it only has to be
// consistent within one.
// ─────────────────────────────────────────────────────────────────────────────

import type { LangCode, Turn } from "./types";

/** Characters per second, per language. Telugu tuned in phase 3 against the
 *  brief's ~13s target for the whole activeIndex 0 → 6 walk; the measured total
 *  is 13208ms. `en` and `hi` land in phase 4. */
export const CPS: Partial<Record<LangCode, number>> = {
  te: 32,
};

/** The floor, so a two-word phrase does not flash. Authored at 450ms, raised to
 *  550ms after measuring: at CPS 32 the closing turn "రేపు కలుద్దాం!" computes to
 *  437ms and t1's "నమస్తే!" to 219ms, and both sit at the floor rather than near
 *  it — a greeting and a sign-off are precisely the phrases the floor exists
 *  for. 550 costs 319ms across the whole sequence. */
export const MIN_PHRASE_MS = 550;

/** Stillness after each turn, including before the confirmation record. */
export const GAP_MS = 220;

/** The crossfade `complete` → `idle` runs through on Replay. */
export const CROSSFADE_MS = 150;

export interface Step {
  turn: number;
  phrase: number;
  start: number;
  end: number;
}

export interface Timeline {
  steps: Step[];
  /** Elapsed at which activeIndex reaches turns.length — the card. */
  total: number;
  /** Phrase count per turn, so a frame lookup never has to re-split text. */
  counts: number[];
}

/** The phrases of one turn, as strings. `phrases` holds the END offset of each
 *  phrase, so the array PARTITIONS the text — phrase k is
 *  text.slice(offsets[k-1] ?? 0, offsets[k]). No character is dropped and none
 *  is added, which is what lets the rendered spans lay out identically to the
 *  one undivided text node they replace.
 *
 *  The trailing guard is not decoration: an offsets array that stops short of
 *  the end would otherwise silently truncate the turn on screen. */
export function splitPhrases(turn: Turn): string[] {
  const offsets = turn.phrases;
  if (!offsets || offsets.length === 0) return [turn.text];
  const out: string[] = [];
  let prev = 0;
  for (const o of offsets) {
    if (o <= prev || o > turn.text.length) continue;
    out.push(turn.text.slice(prev, o));
    prev = o;
  }
  if (prev < turn.text.length) out.push(turn.text.slice(prev));
  return out.length > 0 ? out : [turn.text];
}

export function phraseDurations(turn: Turn, cps: number): number[] {
  return splitPhrases(turn).map((p) => Math.max(MIN_PHRASE_MS, (p.length / cps) * 1000));
}

/**
 * The whole sequence, as absolute offsets from the moment Play is pressed.
 *
 * A TURN'S DWELL IS THE SUM OF ITS PHRASE DURATIONS — for patient turns too,
 * even though a patient turn's text appears whole. The cadence model answers
 * "how long is this turn on stage"; emergence only answers "how does its text
 * arrive during that time". Without that split, "అంతే, ధన్యవాదాలు." would be on
 * screen for one 150ms fade and gone.
 */
export function buildTimeline(turns: Turn[], lang: LangCode): Timeline {
  const cps = CPS[lang];
  if (cps === undefined) {
    throw new Error(`cadence: no CPS for "${lang}" — en and hi land in phase 4`);
  }
  const steps: Step[] = [];
  const counts: number[] = [];
  let t = 0;
  turns.forEach((turn, i) => {
    const ds = phraseDurations(turn, cps);
    counts.push(ds.length);
    ds.forEach((d, j) => {
      steps.push({ turn: i, phrase: j, start: t, end: t + d });
      t += d;
    });
    t += GAP_MS;
  });
  return { steps, total: t, counts };
}

export interface Frame {
  activeIndex: number;
  /** Phrases of the active turn that have emerged. Consulted only for Prantivo
   *  turns; patient turns arrive whole. */
  revealed: number;
}

/**
 * Where the sequence is at `elapsed`. A pure function of elapsed time and the
 * timeline — which is what makes pause/resume exact: pausing stops accumulating
 * elapsed, and resuming carries on from the same number. There is no separate
 * "current phrase" cursor that could drift out of step with the clock.
 */
export function frameAt(elapsed: number, tl: Timeline): Frame {
  if (elapsed >= tl.total) return { activeIndex: tl.counts.length, revealed: 0 };
  let idx = 0;
  for (let k = 0; k < tl.steps.length; k++) {
    if (tl.steps[k].start <= elapsed) idx = k;
    else break;
  }
  const s = tl.steps[idx];
  // During a phrase's window that phrase is revealed; in the stillness after a
  // turn's last phrase this resolves to the turn's full count, which is right.
  return { activeIndex: s.turn, revealed: s.phrase + 1 };
}
