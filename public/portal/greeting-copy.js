/* ============================================================================
 * What the portal says ABOUT the greeting — the single copy of it.
 *
 * Two surfaces now show the clinic's own opening line: the Verbatim panel
 * (verbatim.js, nine editing pages) and Home's greeting block (home.js). Both
 * have to answer the same three questions in the same words:
 *
 *   • what the English gloss beside a vernacular line is called,
 *   • what to say when there is no English line to check it against, and
 *   • what to say when the clinic has no greeting in that language at all.
 *
 * Every string below is the panel's, unchanged — this file did not author one.
 * It exists because the alternative was a second copy in home.js, and a second
 * copy of copy is how the two surfaces come to describe the same greeting two
 * different ways. Same reasoning, and the same UMD-lite shape, as
 * booking-summary.js and shadow-notice.js: no build step (spec §2), the logic
 * is pure, and the file the browser loads is the file anything else reads.
 *
 * NOT in here: the greeting itself. Every vernacular string in this product is
 * tenant-authored — portal files ship no Telugu or Devanagari of their own.
 * ========================================================================== */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GreetingCopy = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const LANG_LABEL = { te: 'Telugu', hi: 'Hindi', en: 'English' };
  const langName = (code) => LANG_LABEL[code] || code;

  const GLOSS_LABEL = 'Your English greeting';
  const NO_ENGLISH_LABEL = 'No English to check against';
  const NO_ENGLISH_OFF =
    'English isn’t switched on for your clinic, so there’s no English version of this line to compare.';
  const NO_ENGLISH_BLANK =
    'You haven’t written the English greeting yet. Add it on Receptionist and it will show here, '
    + 'so you can check this line reads right.';

  /**
   * The English gloss for a vernacular line, or null when there is nothing to
   * gloss (the line already IS English).
   *
   * MANDATORY wherever a vernacular greeting is shown, and never aria-hidden
   * (spec §2.10): it is the accessible content for an owner who does not read
   * Telugu fluently, and a preview they cannot verify is theatre. When there
   * is no English to check against we say so — silence would hide exactly the
   * thing the gloss rule exists to surface.
   *
   * @param {string} code   the language being shown
   * @param {string[]} langs  the clinic's enabled languages
   * @param {string|function} english  the clinic's English greeting, or a thunk
   *        returning it — a thunk so the caller need not resolve a value that
   *        the `en is not enabled` branch never reads.
   * @returns {{label: string, text: string}|null}
   */
  function glossFor(code, langs, english) {
    if (code === 'en') return null;
    if ((langs || []).indexOf('en') === -1) {
      return { label: NO_ENGLISH_LABEL, text: NO_ENGLISH_OFF };
    }
    const en = typeof english === 'function' ? english() : english;
    if (!en) return { label: NO_ENGLISH_LABEL, text: NO_ENGLISH_BLANK };
    return { label: GLOSS_LABEL, text: en };
  }

  /** No greeting on file for this language. Names what happens instead. */
  const noGreeting = (code) =>
    `You haven’t written a ${langName(code)} greeting yet — `
    + 'your receptionist opens with a plain line naming your clinic.';

  return { LANG_LABEL, langName, glossFor, noGreeting, GLOSS_LABEL, NO_ENGLISH_LABEL };
});
