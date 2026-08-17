// ─────────────────────────────────────────────────────────────────────────────
// The hero conversation, rendered. Phase 3 of HERO-1.
//
// STILL STATELESS. No "use client", no useState, no useEffect, no timer. Every
// frame is a pure function of (turns, activeIndex, revealed) — phase 3 added
// the thing that walks those forward over time, and it is a SEPARATE file
// (ConversationPlayer.tsx) precisely so that this one did not have to change
// shape. If this component ever needs state of its own to render a frame, the
// split between "what a frame looks like" and "which frame we are on" has been
// drawn in the wrong place.
//
// IT IS NO LONGER A SERVER COMPONENT, and that is the one thing about phase 3
// worth being careful about. ConversationPlayer.tsx carries "use client" and
// renders this, so this module is compiled into the client graph too. Phase 2
// kept the demo fixture out of the browser for free by being server-only;
// phase 3 has to keep it out DELIBERATELY, and the way it does that is:
//
//     THE CARD'S DATA ARRIVES AS A PROP. Three strings.
//
// `public/demo/fixture.json` is read by the page — a server component — which
// narrows it to { doctor, time, status } at the boundary. The appointment id,
// the synthetic patient name, the dev tenant and the four-week-old date never
// reach a client chunk because they are never in a module a client chunk
// imports. Re-adding `import fixture from "…"` to this file would ship all of
// it, silently, and the build would not complain.
//
// THE CAPTION BELONGS TO Hero. It is not rendered here.
// ─────────────────────────────────────────────────────────────────────────────

import { splitPhrases } from "./cadence";
import type { Speaker, Turn } from "./types";
import styles from "./Conversation.module.css";

/* ── What the card is allowed to say ──────────────────────────────────────────
 *
 * GRADE      VALUE       SOURCE
 * REAL       Dr. Rao     fixture.appointment.doctor_name
 * REAL       9:00 AM     fixture.appointment.time — "09:00", rendered 12-hour
 * REAL       booked      fixture.appointment.status
 * AUTHORED   Tomorrow    the dialogue's own relative framing
 *
 * `status` is "booked", NOT "confirmed". The brief for phase 2 graded the word
 * "confirmed" as REAL and attributed it to this field; the field does not hold
 * it. Rendering "confirmed" while citing `fixture.appointment.status` would be
 * a provenance claim with nothing behind it, so the card says what the fixture
 * says. It also reads truer against the dialogue: t3 is "బుక్ అయింది", *it is
 * booked*.
 *
 * DELIBERATELY NOT RENDERED, and as of phase 3 not even reachable from here:
 *   date / appointment_time / appointment_time_ist — 2026-07-18, four weeks
 *     past. A card reading "Saturday, 18 July" beside dialogue saying "tomorrow"
 *     is incoherent, and the incoherence is in the data's age, not in the copy.
 *   patient_name — synthetic.
 *   tenant       — a dev tenant ("Smile Dental (Voice Dev)").
 *   id           — a database key.
 * ────────────────────────────────────────────────────────────────────────── */

/** The three strings the card may show. The narrowing happens on the server;
 *  this is the shape that crosses into the client. */
export interface ConversationRecord {
  status: string;
  time: string;
  doctor: string;
}

/** "09:00" → "9:00 AM". Pure string arithmetic on purpose: `Date`/`Intl` would
 *  make the rendered value depend on the build machine's zone, and this is a
 *  wall-clock time in the clinic's day, not an instant.
 *
 *  Exported so the page can build the record without a second copy of the rule.
 *  It is a pure function of its argument and reads no module state, so calling
 *  it from a server component is just calling a function. */
export function to12Hour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

// Authored in sentence case, uppercased by CSS. A screen reader given "PATIENT"
// may spell it; given "Patient" it says the word, and text-transform does not
// reach the accessibility tree.
const SPEAKER_LABEL: Record<Speaker, string> = {
  patient: "Patient",
  prantivo: "Prantivo",
};

/* ── The recency ladder ───────────────────────────────────────────────────────
 * Distance from the active turn, floored at 2. Without the floor a six-turn
 * thread compounds down to 0.70 and ends unreadable at the top.
 *
 * COLOUR CARRIES ONE STEP, SCALE CARRIES THE REST (D-016). Only the active
 * PRANTIVO turn is --ink-strong; everything else — including an active patient
 * turn — is --ink-soft at 7.31:1. --ink-faint touches no glyph at any position.
 * ────────────────────────────────────────────────────────────────────────── */
const STEP_CLASS = [styles.stepActive, styles.stepNear, styles.stepFloor];

export interface ConversationProps {
  /** In order. Only turns 0…activeIndex are rendered; the rest have not
   *  arrived yet, and rendering them invisibly would reserve their space. */
  turns: Turn[];
  /**
   * Which turn is active, and the single number playback walks forward.
   *
   *   0 … turns.length-1   that turn is active; later turns are absent
   *   turns.length         every turn has landed and the confirmation record is
   *                        the active element — the ONLY way the card appears
   *
   * The card is deliberately the terminal value of the same scalar rather than
   * a second prop: it is one more thing that arrives, it arrives last, and a
   * `showCard` boolean would let a caller express states the thread cannot
   * actually reach (a card at turn 2, a last turn with no record).
   */
  activeIndex: number;
  /** The confirmation record, narrowed at the server→client boundary. */
  record: ConversationRecord;
  /**
   * How many phrases of the ACTIVE turn have emerged. A different axis from
   * `activeIndex`, not a second way to say the same thing: it only ever
   * describes the turn that is currently arriving.
   *
   * Consulted only when `live` — and only for Prantivo turns. THE ASYMMETRY IS
   * THE POINT: Prantivo *speaks*, so its answer unfolds; the patient's message
   * *arrived*, whole, the way a message does. In practice only t1 and t3
   * visibly unfold, because the other Prantivo turn is a single phrase. That is
   * correct — the two turns that unfold are the two where the product is doing
   * work.
   */
  revealed?: number;
  /**
   * True for the one instance a client is playing. Everything that moves is
   * scoped to this flag, so a statically rendered frame carries no transition,
   * no animation and no transform it did not carry in phase 2 — which is what
   * makes the four static instances on /specimen a usable pixel gate for the
   * markup change underneath them.
   */
  live?: boolean;
}

export function Conversation({
  turns,
  activeIndex,
  record,
  revealed = Number.MAX_SAFE_INTEGER,
  live = false,
}: ConversationProps) {
  const shown = turns.slice(0, Math.max(0, Math.min(activeIndex + 1, turns.length)));
  const complete = activeIndex >= turns.length;

  return (
    // BOTTOM-ANCHORED, NOT SCROLLED. A fixed height with justify-content:
    // flex-end and overflow:hidden — no scroll container, DOM order preserved
    // for a screen reader, and turns that leave view stay in the DOM. The region
    // is full height from the first frame, so nothing below it ever shifts.
    //
    // aria-live does work now. Because an un-emerged phrase is present at
    // opacity 0 rather than absent, the only mutation is a whole turn arriving:
    // six announcements across the sequence, not one per phrase.
    <div
      className={`${styles.region} ${live ? styles.live : ""}`}
      aria-live="polite"
      data-conversation-region
    >
      {shown.map((turn, i) => {
        const distance = Math.min(Math.max(activeIndex - i, 0), 2);
        const isPrantivo = turn.speaker === "prantivo";
        // Only an active Prantivo turn takes the strong ink. See the ladder
        // above. At `complete` no turn is at distance 0 — the card is the
        // active element — so this correctly goes false everywhere.
        const strong = isPrantivo && distance === 0;
        const parts = splitPhrases(turn);
        // Emergence applies to the active Prantivo turn of a live instance and
        // to nothing else. A settled turn, a patient turn and every turn of a
        // static instance render whole.
        const emerging = live && isPrantivo && i === activeIndex;
        return (
          // lang is on the TURN, so :lang(te) reaches the text and a screen
          // reader switches voice for it. The head row overrides back to en:
          // "Patient" and "9:14 AM" are English inside a Telugu turn, and
          // HeroChat.tsx:169-172 records the same rule for the same reason.
          <div
            key={turn.id}
            lang={turn.lang}
            className={`${styles.turn} ${STEP_CLASS[distance]} ${
              isPrantivo ? styles.turnPrantivo : styles.turnPatient
            }`}
          >
            {isPrantivo && <span className={styles.hair} aria-hidden="true" />}
            <div className={styles.head} lang="en">
              <span className={styles.label}>{SPEAKER_LABEL[turn.speaker]}</span>
              <time className={styles.time}>{turn.time}</time>
            </div>
            <p className={`${styles.text} ${strong ? styles.inkStrong : ""}`}>
              {/* A SPAN EXISTS ONLY WHERE A PHRASE CAN BE HIDDEN.

                  A one-phrase turn is revealed the instant it becomes active —
                  `revealed` starts at 1 — so wrapping it would add an element
                  that can never do anything. t2, t4 and t5 therefore render as
                  the bare text node they were in phase 2, which is also why
                  they are pixel-identical to it.

                  Where spans ARE needed they are present in every instance and
                  every state, static included, and they carry no CSS-module
                  class — only a data attribute the live stylesheet reaches. An
                  un-emerged phrase is transparent, never absent, so it holds
                  its space and the words after it do not move when it lands.
                  "no movement" in the motion table is a layout requirement, not
                  a description of the easing.

                  SPLITTING A TEXT RUN IS NOT FREE. Chrome shapes each inline
                  fragment separately and quantises its origin to a 1/64px
                  LayoutUnit, so a glyph immediately after a boundary can land
                  up to that far from where an unbroken run would put it. Line
                  count, line origins and wrap points are unaffected — measured,
                  not assumed — but subpixel antialiasing does repaint a few
                  glyph edges. That is the floor, and it is why this renders one
                  text node whenever it can. */}
              {parts.length === 1
                ? turn.text
                : parts.map((part, k) => (
                    <span
                      key={k}
                      data-phrase=""
                      data-hidden={emerging && k >= revealed ? "" : undefined}
                    >
                      {part}
                    </span>
                  ))}
            </p>
          </div>
        );
      })}

      {complete && (
        // A RECORD, not a message: no speaker, no timestamp, no hairline, and
        // last in the flow rather than beside the turn that announced it. At the
        // end it reserves no space and shifts nothing, and the resting state of
        // the thread is the payoff instead of a pleasantry.
        //
        // It is content. Not aria-hidden, not role="img" — a screen reader reads
        // "Appointment booked. Tomorrow, 9:00 AM · Dr. Rao" as the text it is.
        <div className={styles.card}>
          <svg
            className={styles.check}
            width="18"
            height="18"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M4.5 12.75 L9.75 18 L19.5 6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div>
            <p className={styles.cardTitle}>Appointment {record.status}</p>
            <p className={styles.cardMeta}>
              Tomorrow, {record.time} · {record.doctor}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
