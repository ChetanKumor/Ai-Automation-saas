// ─────────────────────────────────────────────────────────────────────────────
// The hero conversation, rendered. Phase 2 of HERO-1.
//
// STATELESS, AND STRUCTURALLY SO. No "use client", no useState, no useEffect,
// no timer. It is a server component: everything below is decided at build time
// and the browser receives HTML. Phase 3 adds the thing that walks `activeIndex`
// forward over time; if this component ever needs state of its own to render a
// frame, the split between "what a frame looks like" and "which frame we are on"
// has been drawn in the wrong place.
//
// TEXT RENDERS WHOLE. `Turn.phrases` exists in the type but is not read here —
// phrase-level emergence is phase 3, and it subdivides these same text nodes.
// That is why phase 2's /specimen captures are phase 3's pixel-equality gate:
// splitting a string into spans must not move a single glyph.
//
// THE CAPTION BELONGS TO Hero. It is not rendered here.
// ─────────────────────────────────────────────────────────────────────────────

import type { Speaker, Turn } from "./types";
import styles from "./Conversation.module.css";

// The record is REAL. Read from the fixture rather than typed in, because a
// literal "Dr. Rao" in this file is a claim with nothing behind it — the same
// standard tests/design/conversationProvenance.test.js already holds the two
// captured turns to. This is the identical file that test requires, and the
// identical file public/demo/app.js plays from.
//
// The import crosses out of web/ deliberately: copying the fixture into
// web/public/ would make a SECOND copy that could drift from the one the test
// pins, which is the failure mode this is avoiding. Nothing ships to the
// browser — this is a server component, so the value is inlined into the
// prerendered HTML and the JSON never enters a client chunk.
import fixture from "../../../../public/demo/fixture.json";

/* ── What the card is allowed to say ──────────────────────────────────────────
 *
 * GRADE      VALUE       SOURCE
 * REAL       Dr. Rao     fixture.appointment.doctor_name
 * REAL       9:00 AM     fixture.appointment.time — "09:00", rendered 12-hour
 * REAL       booked      fixture.appointment.status
 * AUTHORED   Tomorrow    the dialogue's own relative framing
 *
 * `status` is "booked", NOT "confirmed". The brief for this phase graded the
 * word "confirmed" as REAL and attributed it to this field; the field does not
 * hold it. Rendering "confirmed" while citing `fixture.appointment.status`
 * would be a provenance claim with nothing behind it — the exact thing the
 * paragraph above exists to prevent — so the card says what the fixture says.
 * It also reads truer against the dialogue: t3 is "బుక్ అయింది", *it is booked*.
 *
 * DELIBERATELY NOT RENDERED:
 *   date / appointment_time / appointment_time_ist — 2026-07-18, four weeks
 *     past. A card reading "Saturday, 18 July" beside dialogue saying "tomorrow"
 *     is incoherent, and the incoherence is in the data's age, not in the copy.
 *   patient_name — synthetic.
 *   tenant       — a dev tenant ("Smile Dental (Voice Dev)").
 *   id           — a database key.
 * ────────────────────────────────────────────────────────────────────────── */

/** "09:00" → "9:00 AM". Pure string arithmetic on purpose: `Date`/`Intl` would
 *  make the rendered value depend on the build machine's zone, and this is a
 *  wall-clock time in the clinic's day, not an instant. */
function to12Hour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

const RECORD = {
  status: fixture.appointment.status,
  time: to12Hour(fixture.appointment.time),
  doctor: fixture.appointment.doctor_name,
} as const;

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
   * Which turn is active, and the single number phase 3 will walk forward.
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
}

export function Conversation({ turns, activeIndex }: ConversationProps) {
  const shown = turns.slice(0, Math.max(0, Math.min(activeIndex + 1, turns.length)));
  const complete = activeIndex >= turns.length;

  return (
    // BOTTOM-ANCHORED, NOT SCROLLED. A fixed height with justify-content:
    // flex-end and overflow:hidden — no JS, no scrollTop, DOM order preserved
    // for a screen reader, and turns that leave view stay in the DOM. The region
    // is full height from the first frame, so nothing below it ever shifts.
    //
    // aria-live is inert this phase — nothing arrives. Phase 3 is what makes it
    // do work, and it is declared now because a live region added later has to
    // exist before the first mutation to announce it.
    <div className={styles.region} aria-live="polite">
      {shown.map((turn, i) => {
        const distance = Math.min(Math.max(activeIndex - i, 0), 2);
        const isPrantivo = turn.speaker === "prantivo";
        // Only an active Prantivo turn takes the strong ink. See the ladder
        // above. At `complete` no turn is at distance 0 — the card is the
        // active element — so this correctly goes false everywhere.
        const strong = isPrantivo && distance === 0;
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
              {turn.text}
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
            <p className={styles.cardTitle}>Appointment {RECORD.status}</p>
            <p className={styles.cardMeta}>
              Tomorrow, {RECORD.time} · {RECORD.doctor}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
