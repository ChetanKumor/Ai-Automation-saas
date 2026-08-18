"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE LANGUAGE SELECTOR — and, below it, the small stateful shell that owns
// which language is showing.
//
// WHY BOTH LIVE HERE. The specimen page is a server component. It cannot hold
// `useState`, so the language cannot live there however much it looks like the
// page's business. The shell is the smallest client thing that can own it, it
// exists only to pair this control with the player, and nothing else will ever
// import it — so it sits beside the control rather than in a file of its own.
//
// TWO LANGUAGES, BOTH REAL, BOTH ENABLED. There is no third segment greyed out
// waiting for phase 4b. A disabled option advertises an absence: it tells a
// reader the product has a Hindi mode and is withholding it, which is not true.
// Hindi arrives when its six turns have been read by someone who speaks it.
//
// THE OPTION LIST IS NOT AUTHORED HERE. It arrives as `langs`, which the page
// fills from LANGUAGES in ./index — itself derived from LANGS. So an option can
// only exist if its strings exist, and "no language is offered that throws" is a
// property of the wiring rather than a rule someone has to remember.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from "react";
import { ConversationPlayer } from "./ConversationPlayer";
import type { ConversationRecord } from "./Conversation";
import type { LangCode, Turn } from "./types";
import styles from "./LanguageSelector.module.css";

/** The endonym, always — a language names itself in its own script, because the
 *  reader who needs the Telugu segment is the reader who does not read the word
 *  "Telugu". `hi` is absent deliberately: an unreviewed Hindi endonym is the
 *  first thing a Hindi reader would see, and phase 4b exists because that
 *  review does not exist yet. */
const LABEL: Partial<Record<LangCode, string>> = {
  en: "English",
  te: "తెలుగు",
};

/** Loud, not blank. A language wired into LANGS but not into LABEL would
 *  otherwise render as an empty pill that still selects — a control with no
 *  name, which is worse than a crash because it looks deliberate. */
function labelOf(code: LangCode): string {
  const label = LABEL[code];
  if (!label) {
    throw new Error(`LanguageSelector: no label for "${code}" — add its endonym beside the others`);
  }
  return label;
}

export interface LanguageSelectorProps {
  /** Offer order. Every entry must have strings and a CPS; see the file header. */
  langs: LangCode[];
  value: LangCode;
  onChange: (lang: LangCode) => void;
  /** The group's accessible name. Required — a radiogroup without one is a set
   *  of options a screen reader cannot say the purpose of. */
  label: string;
}

/**
 * A radiogroup, not a row of buttons and not a <select>.
 *
 * The semantics are the ones the pattern actually specifies: ONE tab stop for
 * the whole group (roving tabindex, so Tab reaches the control and then leaves
 * it rather than walking every language), arrows to traverse, and selection
 * following focus — which is correct here because selecting is free and
 * instantaneous, so there is nothing to confirm.
 *
 * WRAP-AROUND IS BOTH WAYS. With two options every arrow press is a wrap, so a
 * one-directional implementation would look identical to a correct one on the
 * first press and diverge only once a third language lands. It is written for
 * n, tested at n = 2.
 */
export function LanguageSelector({ langs, value, onChange, label }: LanguageSelectorProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusAndSelect = useCallback(
    (index: number) => {
      const code = langs[index];
      if (!code) return;
      onChange(code);
      refs.current[index]?.focus();
    },
    [langs, onChange]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const i = langs.indexOf(value);
      if (i < 0) return;
      const n = langs.length;
      // The modulo carries the wrap in both directions: +n before % keeps
      // index 0 stepping backwards onto the last option rather than onto -1.
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          focusAndSelect((i + 1) % n);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          focusAndSelect((i - 1 + n) % n);
          break;
        case "Home":
          e.preventDefault();
          focusAndSelect(0);
          break;
        case "End":
          e.preventDefault();
          focusAndSelect(n - 1);
          break;
        default:
      }
    },
    [langs, value, focusAndSelect]
  );

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={styles.group}
      onKeyDown={onKeyDown}
      data-language-selector
    >
      {langs.map((code, i) => (
        <button
          key={code}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={code === value}
          // Roving. Only the selected option is in the tab order, so the group
          // is one stop; the arrows do the rest.
          tabIndex={code === value ? 0 : -1}
          // Per option, so assistive technology pronounces each name in its own
          // language rather than reading తెలుగు through an English voice.
          lang={code}
          className={styles.option}
          data-lang-option={code}
          onClick={() => onChange(code)}
        >
          {labelOf(code)}
        </button>
      ))}
    </div>
  );
}

export interface LanguageSwitchedConversationProps {
  langs: LangCode[];
  /** Built on the server, one entry per `langs` member. Passing the turns as
   *  data rather than importing ./index here keeps both language files out of
   *  the client chunk — they arrive in the RSC payload as the text that is
   *  rendered either way. */
  conversations: Partial<Record<LangCode, Turn[]>>;
  initial: LangCode;
  record: ConversationRecord;
}

/**
 * Selector + player, sharing one piece of state.
 *
 * SWITCHING SWAPS PROPS, IT DOES NOT REMOUNT. A `key={lang}` here would be the
 * obvious way to get a clean slate and it is the wrong one twice over: at idle
 * it throws away the server-rendered tree to build an identical one, and
 * mid-playback it would drop the reader back to turn 0 — the language changed,
 * not the conversation. Swapping `turns` and `lang` leaves usePlayback's
 * accumulated clock alone, which is what keeps the reader's place.
 */
export function LanguageSwitchedConversation({
  langs,
  conversations,
  initial,
  record,
}: LanguageSwitchedConversationProps) {
  const [lang, setLang] = useState<LangCode>(initial);
  const turns = conversations[lang];
  if (!turns) {
    throw new Error(`LanguageSwitchedConversation: no turns for "${lang}"`);
  }
  return (
    <div className={styles.shell} data-conversation-lang={lang}>
      <LanguageSelector
        langs={langs}
        value={lang}
        onChange={setLang}
        label="Conversation language"
      />
      <ConversationPlayer turns={turns} lang={lang} record={record} />
    </div>
  );
}
