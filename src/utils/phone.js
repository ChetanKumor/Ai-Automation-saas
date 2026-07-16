'use strict';

// Canonical phone format: E.164 with leading '+' and country code.
// Example: "+919999999999" (not "919999999999").
// Both WhatsApp (wa_id = bare digits, CC included) and voice (caller_id = +CC...)
// normalize to the same string so the same human always resolves to ONE customer row.
const E164_RE = /^\+[1-9]\d{1,14}$/;

/**
 * Normalize a raw phone string to canonical E.164 (+CC digits, no spaces/dashes).
 * Idempotent: normalizePhone(normalizePhone(x)) === normalizePhone(x).
 *
 * Numbers are never silently prefixed with a default country code — if a number
 * lacks its CC, it will fail the E.164 check and the caller gets a clear error
 * rather than a silently wrong record.
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
    throw new Error(`invalid phone: "${raw}" normalizes to "${s}" which is not E.164`);
  }
  return s;
}

module.exports = { normalizePhone, E164_RE };
