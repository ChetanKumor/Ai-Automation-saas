// Types only. No data lives in this file, and nothing here imports anything —
// the data is JSON so that a plain CommonJS test can read the exact bytes the
// app reads, rather than regex a .ts file and pass because it matched a string.

export type TurnId = "t0" | "t1" | "t2" | "t3" | "t4" | "t5";
export type LangCode = "en" | "hi" | "te";
export type Speaker = "patient" | "prantivo";

/** How a string came to exist. Never weakened, never inferred. */
export type TurnSource = "captured" | "authored" | "translated";

/** Language-independent. Lives once in meta.json so timestamps cannot drift
 *  between languages and adding a language is one new file. */
export interface TurnMeta {
  id: TurnId;
  speaker: Speaker;
  time: string;
}

export interface LangTurn {
  text: string;
  source: TurnSource;
  /** Character offsets for phrase-level emergence. Authored in phase 3. */
  phrases?: number[];
}

export interface Turn extends TurnMeta {
  text: string;
  source: TurnSource;
  phrases?: number[];
  lang: LangCode;
}
