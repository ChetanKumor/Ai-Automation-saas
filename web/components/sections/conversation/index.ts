// ─────────────────────────────────────────────────────────────────────────────
// PROVENANCE — migrated VERBATIM from HeroChat.tsx:6-20. sha256 of that block,
// CRLF-NORMALISED (\r\n → \n before hashing):
//   17088cf2c738ff8236ca728585c9d73ba4c1bf1d167e54da74ed979366374cfe
// Normalised for the same reason schema_migrations normalises its checksums: this
// repo checks out CRLF on Windows and LF elsewhere, so a raw digest of the same
// unchanged block differs by platform and would report drift that is only a line
// ending. JSON cannot hold comments, so the prose record lives here. HeroChat.tsx
// keeps its own copy and keeps rendering until phase 5; both are correct until then.
//
// The mockup plays in Telugu because the subhead one column to the left claims
// Telugu, and this is the one claim the product can prove instantly and for free.
// A prospect who has to take it on faith is being asked for the wrong thing.
//
// Provenance, kept straight. The first two lines are REAL, copied verbatim from
// public/demo/fixture.json: the customer line is Sarvam STT output on
// founder-recorded audio, the reply is output of the same brain the live route
// runs. The other four are hand-authored illustrative copy — exactly what that
// fixture's own WhatsApp side is (see its `provenance.whatsapp`). Nothing here is
// presented as a capture, and the real pair must not be edited: re-capture it or
// leave it alone.
//
// `te` is the message. `en` is a translation shown beneath the receptionist's
// replies so a prospect who does not read Telugu can still follow the booking;
// the customer's own lines carry none, since the replies restate what was asked.
//
// ── END of the verbatim block. Notes added by this migration: ────────────────
//
// The capture identifiers are NOT in the block above and never were. They live in
// public/demo/fixture.json under `provenance` — the Sarvam request id is
// 20260717_006a8c12-8ef0-4748-8908-6523130c107f (model saaras:v3, mode transcribe,
// detected te-IN), on founder-recorded audio demo-audio/booking.wav captured
// 2026-07-17. That file, not this comment, is the authority; the last paragraph
// above describes HeroChat's `te`/`en` shape rather than this module's, because it
// is reproduced unedited.
//
// The Telugu here was copied from those files programmatically, never retyped.
// It has to be: `అపాయింట్‌మెంట్` typed by hand carries a ZWNJ (U+200C) that keeps
// ట్ and మ apart, and the captured string does not have one — fourteen codepoints
// against thirteen, indistinguishable in most renderings and a test failure.
// tests/design/conversationProvenance.test.js compares these bytes to the fixture.
// ─────────────────────────────────────────────────────────────────────────────

import metaRaw from "./meta.json";
import teRaw from "./te.json";
import type { LangCode, LangTurn, Turn, TurnId, TurnMeta, TurnSource } from "./types";

const SOURCES: readonly TurnSource[] = ["captured", "authored", "translated"];

// `satisfies`, not `as`. This is the build-time half of the guard: a cast would
// silently accept a te.json missing a turn, whereas Record<TurnId, …> demands all
// six keys and fails `tsc` when one is deleted. `next build` type-checks every
// file matched by tsconfig's `**/*.ts`, so this fires even while nothing imports
// this module.
const TE = teRaw satisfies Record<TurnId, { text: string; source: string }> as Record<
  TurnId,
  LangTurn
>;
const META = metaRaw as TurnMeta[];

// The runtime half. It cannot fail a build while nothing imports this module —
// that is the type layer's job above — but it is what turns a mismatch into a
// loud error instead of an `undefined` turn once phase 5 wires this in.
const metaIds = META.map((m) => m.id);
const langIds = Object.keys(TE) as TurnId[];
if (metaIds.length !== langIds.length || metaIds.some((id, i) => id !== langIds[i])) {
  throw new Error(
    `conversation: meta.json and te.json disagree on turns — ` +
      `meta [${metaIds.join(", ")}] vs te [${langIds.join(", ")}]`
  );
}
for (const id of metaIds) {
  if (!SOURCES.includes(TE[id].source)) {
    throw new Error(`conversation: ${id} has illegal source "${TE[id].source}"`);
  }
}

const LANGS: Partial<Record<LangCode, Record<TurnId, LangTurn>>> = { te: TE };

/** The six turns of the hero conversation, in order, for one language. */
export function getConversation(lang: LangCode): Turn[] {
  const strings = LANGS[lang];
  if (!strings) {
    throw new Error(`conversation: no strings for "${lang}" — en and hi land in phase 4`);
  }
  return META.map((m) => ({ ...m, ...strings[m.id], lang }));
}

export type { LangCode, LangTurn, Turn, TurnId, TurnMeta, TurnSource } from "./types";
