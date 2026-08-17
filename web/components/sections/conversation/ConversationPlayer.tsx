"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE CLIENT BOUNDARY. This file, and only this file, carries "use client".
//
// It is deliberately the smallest thing that can hold state: a hook, a wrapper,
// a control. The presentational tree below it (Conversation) is unchanged and
// still renders a frame as a pure function of its props — the boundary is drawn
// between "which frame we are on" and "what a frame looks like", which is the
// lowest place it can go while still letting a client advance the former.
//
// WHAT MUST NOT CROSS IT. `record` is three strings, narrowed on the server.
// This module imports no fixture, and neither does anything it imports. The
// appointment id, the synthetic patient name, the dev tenant and the stale date
// are not in the client graph at all — not hidden in it, not in it. That is
// checkable, and it is checked: grep .next/static/ for any of the four.
//
// The conversation TEXT does cross, because it is the content — it arrives as
// props in the RSC payload and is rendered into the HTML either way.
// ─────────────────────────────────────────────────────────────────────────────

import { useLayoutEffect, useRef, type RefObject } from "react";
import { Conversation, type ConversationRecord } from "./Conversation";
import { PlayControl } from "./PlayControl";
import { usePlayback } from "./usePlayback";
import type { LangCode, Turn } from "./types";
import styles from "./Conversation.module.css";

/**
 * The region scroll, as a FLIP.
 *
 * The region is bottom-anchored (`justify-content: flex-end`), so appending a
 * turn moves everything above it up by that turn's height in a single layout
 * pass — instantly, and with nothing to transition, because no animatable
 * property changed. The fix is the standard one: measure the jump that already
 * happened, undo it with a transform while transitions are off, then release it.
 *
 * WHY offsetTop AND NOT getBoundingClientRect(). Every turn carries a
 * `transform: scale()` and, mid-flip, a `translateY` — so its client rect is its
 * VISUAL box and would fold the previous animation's in-flight value back into
 * the next measurement, compounding. `offsetTop` is the layout position and is
 * blind to transforms, which is exactly what is wanted.
 *
 * Skipped entirely under reduced motion, where the brief asks for an
 * instantaneous scroll. Setting --shift and clearing it would still be a
 * one-frame jump, because globals.css collapses the transition that would have
 * smoothed it.
 */
function useRegionScroll(
  hostRef: RefObject<HTMLDivElement | null>,
  activeIndex: number,
  reduced: boolean
) {
  const prevTop = useRef<number | null>(null);

  useLayoutEffect(() => {
    const region = hostRef.current?.querySelector<HTMLElement>("[data-conversation-region]");
    const first = region?.firstElementChild as HTMLElement | null;
    if (!region || !first) return;

    // Read the ref BEFORE overwriting it: at this point the DOM already holds
    // the new frame, but `prevTop` still holds the old frame's measurement.
    const top = first.offsetTop;
    const prev = prevTop.current;
    prevTop.current = top;

    if (prev === null || reduced || prev === top) return;

    const delta = prev - top; // > 0 when the stack moved up
    region.dataset.flip = "off";
    region.style.setProperty("--shift", `${delta}px`);
    void region.offsetHeight; // flush that as the transition's start value
    delete region.dataset.flip;
    region.style.setProperty("--shift", "0px");
  }, [hostRef, activeIndex, reduced]);
}

export interface ConversationPlayerProps {
  turns: Turn[];
  lang: LangCode;
  record: ConversationRecord;
}

export function ConversationPlayer({ turns, lang, record }: ConversationPlayerProps) {
  const pb = usePlayback(turns, lang);
  const hostRef = useRef<HTMLDivElement>(null);
  useRegionScroll(hostRef, pb.activeIndex, pb.reduced);

  return (
    // The data-* attributes are the player's state made observable. They are not
    // decoration: the phase-3 gates drive this component through all four states
    // over CDP and read them back, and a state machine you cannot observe from
    // outside is one whose behaviour can only be asserted.
    <div
      ref={hostRef}
      className={styles.host}
      data-playback={pb.state}
      data-playback-index={pb.activeIndex}
      data-playback-revealed={pb.revealed}
      data-playback-total={pb.totalMs}
      data-playback-reduced={pb.reduced ? "true" : "false"}
    >
      <div className={styles.fade} data-crossfading={pb.crossfading ? "" : undefined}>
        <Conversation
          turns={turns}
          activeIndex={pb.activeIndex}
          revealed={pb.revealed}
          record={record}
          live
        />
      </div>
      <PlayControl state={pb.state} onToggle={pb.toggle} />
    </div>
  );
}
