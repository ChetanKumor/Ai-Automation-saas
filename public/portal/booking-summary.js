/* ============================================================================
 * Plain-English booking-rules summary sentence (PORTAL-P3-S9).
 *
 * Single source, shared by the booking-rules page (browser, via <script>) and
 * the "what your receptionist knows" page's server route (Node `require`,
 * PORTAL-P5-S15) — one wording, not two copies that can quietly drift apart.
 * No build step (spec §2): plain UMD-lite so the same file works both ways.
 * ========================================================================== */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BookingSummary = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function humanNotice(minutes) {
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute' : ' minutes');
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const hours = h + (h === 1 ? ' hour' : ' hours');
    return m === 0 ? hours : `${hours} ${m} ${m === 1 ? 'minute' : 'minutes'}`;
  }

  function summarizeBooking(b) {
    const parts = [`Patients can book ${b.slot_minutes}-minute appointments`];
    if (b.buffer_minutes > 0) parts.push(`from ${humanNotice(b.buffer_minutes)} ahead`);
    parts.push(`up to ${b.advance_days} ${b.advance_days === 1 ? 'day' : 'days'} out`);
    const same = b.allow_same_day
      ? 'same-day booking is on'
      : 'same-day booking is off, so the earliest is tomorrow';
    return `${parts.join(' ')}; ${same}.`;
  }

  return { humanNotice, summarizeBooking };
});
