'use strict';

// Canonical phone format: E.164 with leading '+' and country code.
// Example: "+919999999999" (not "919999999999").
// Both WhatsApp (wa_id = bare digits, CC included) and voice (caller_id = +CC...)
// normalize to the same string so the same human always resolves to ONE customer row.
//
// F-003b: length bounds are the ONLY signal available to tell "missing country
// code" apart from "short-but-real E.164 number" — a regex can't know a number's
// actual country. 11 digits after '+' is the floor because it's the shortest
// real number this codebase ever validates (+14155550100, NANP, tested in
// configSchema); a bare 10-digit Indian mobile ("9876543210" -> "+9876543210")
// is one digit short of that floor and gets rejected instead of silently
// becoming a real, different, +98 (Iran) number. 15 is the ITU E.164 max.
const E164_RE = /^\+[1-9]\d{10,14}$/;

/**
 * Normalize a raw phone string to canonical E.164 (+CC digits, no spaces/dashes).
 * Idempotent: normalizePhone(normalizePhone(x)) === normalizePhone(x).
 *
 * Numbers are never silently prefixed with a default country code, and a number
 * arriving without one is never reinterpreted as a plausible different number —
 * it fails validation and the caller gets a clear error rather than a silently
 * wrong record (F-003, hardened in F-003b).
 *
 * @param {string} raw  Raw phone string from any source.
 * @returns {string}    E.164 string, e.g. "+919999999999".
 * @throws {Error}      If the result fails E.164 shape validation.
 */
function normalizePhone(raw) {
  if (raw == null || raw === '') {
    throw new Error('invalid phone: empty');
  }
  let s = String(raw).trim();
  s = s.replace(/[^\d+]/g, '');  // strip spaces, dashes, parens, etc.
  s = s.replace(/^\++/, '');      // strip any run of leading +'s
  s = `+${s}`;                    // ensure exactly one leading +
  if (!E164_RE.test(s)) {
    throw new Error(
      `invalid phone: "${raw}" is not a valid E.164 number — it must include ` +
      `its country code (11-15 digits total, e.g. +919876543210), got "${s}"`
    );
  }
  return s;
}

module.exports = { normalizePhone, E164_RE };
