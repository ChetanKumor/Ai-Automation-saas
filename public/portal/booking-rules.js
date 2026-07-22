/* ============================================================================
 * Booking rules (PORTAL-P3-S9) — the fourth owner-writable config surface.
 *
 * Copies the S4/S5/S6 pattern exactly:
 *   load  → GET  /portal/api/config/booking → fill the four rules + three texts
 *   save  → POST /portal/api/config/booking → { section, version, readiness }
 *           → "Saved · v{N}" toast, update the header go-live control, reset dirty
 *   error → 400 { fields:[{field,message}] } → inline, per-field messages
 *
 * The four settings at the top are ENFORCED (F-006): what is saved here is what
 * the receptionist can offer and what a booking write will accept. The three
 * policy texts are not — they are sentences the receptionist recites. The page
 * says which is which, because an owner who believes a cancellation policy
 * enforces itself has been misled by us, not by the model.
 *
 * The summary line is deliberately derived from the LAST SAVED section, never
 * from the live form: it is the page's statement of what the receptionist is
 * doing right now. While the form is dirty it says so rather than describing
 * rules nobody has saved yet.
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  // Mirrors SLOT_CHOICES in src/portal/routes.js. A stored value outside this set
  // (set through the admin JSON editor) is added as an extra option below so the
  // page can never silently re-grid a clinic on an unrelated save.
  const SLOT_CHOICES = [10, 15, 20, 30];
  const POLICY_IDS = ['cancellation_policy', 'reschedule_policy', 'walk_in_policy'];
  const NUMBER_IDS = ['advance_days', 'buffer_minutes'];

  const form = $('bookingForm');
  const slotEl = $('slot_minutes');
  const sameDayEl = $('allow_same_day');
  const saveBtn = $('saveBtn');
  const saveNote = $('saveNote');

  let baseline = '';   // JSON of the last-saved form state — drives the dirty note
  let saved = null;    // the last-saved section — the ONLY source for the summary

  // ── Dirty tracking ───────────────────────────────────────────────────────────
  function markDirty() {
    const dirty = JSON.stringify(collect()) !== baseline;
    saveNote.textContent = dirty ? 'Unsaved changes' : '';
    saveNote.className = 'save-note' + (dirty ? ' save-note--dirty' : '');
    $('summaryStale').hidden = !dirty;
  }

  // ── Errors ───────────────────────────────────────────────────────────────────
  function clearErrors() {
    form.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
    form.querySelectorAll('.field__error').forEach((e) => { e.textContent = ''; });
    form.querySelectorAll('.input--invalid').forEach((i) => i.classList.remove('input--invalid'));
  }

  function clearFieldError(name) {
    const f = form.querySelector(`.field[data-field="${name}"]`);
    if (!f) return;
    f.classList.remove('is-invalid');
    const err = f.querySelector('.field__error');
    if (err) err.textContent = '';
    f.querySelectorAll('.input--invalid').forEach((i) => i.classList.remove('input--invalid'));
  }

  function applyErrors(fields) {
    clearErrors();
    let firstEl = null;
    for (const f of fields) {
      const el = form.querySelector(`.field[data-field="${f.field}"]`);
      if (!el) continue;
      el.classList.add('is-invalid');
      const err = el.querySelector('.field__error');
      if (err) err.textContent = f.message;
      const input = el.querySelector('.input');
      if (input) input.classList.add('input--invalid');
      if (!firstEl) firstEl = input || el;
    }
    if (firstEl && firstEl.focus) firstEl.focus();
    if (firstEl && firstEl.scrollIntoView) firstEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ── Plain-English summary ────────────────────────────────────────────────────
  // One sentence, built from the saved values. This is what the owner checks
  // instead of re-reading four form fields — so it must describe the rules as
  // enforcement applies them, not as the form displays them. The formula lives
  // in booking-summary.js (shared with the server-side "what it knows" page,
  // PORTAL-P5-S15) so the two pages can never quote different wording.
  function renderSummary() {
    $('summaryText').textContent = saved ? window.BookingSummary.summarizeBooking(saved) : '';
  }

  // ── Collect / fill ───────────────────────────────────────────────────────────
  // Numbers go up as raw strings — the server is the one that decides what a
  // whole number is, and it rejects rather than coerces (a silently reinterpreted
  // booking window is the failure this page exists to prevent).
  function collect() {
    const out = {
      slot_minutes: slotEl.value,
      allow_same_day: sameDayEl.checked,
    };
    NUMBER_IDS.forEach((id) => { out[id] = $(id).value.trim(); });
    POLICY_IDS.forEach((id) => { out[id] = $(id).value.trim(); });
    return out;
  }

  function renderSlotOptions(current) {
    const choices = SLOT_CHOICES.slice();
    // Keep an out-of-set stored value selectable, labelled as what it is. Dropping
    // it would show "30 minutes" for a clinic running 45 — and the next save of
    // any field on this page would make that lie true.
    if (choices.indexOf(current) === -1) choices.push(current);
    choices.sort((a, b) => a - b);
    slotEl.innerHTML = choices.map((n) => {
      const custom = SLOT_CHOICES.indexOf(n) === -1 ? ' (current setting)' : '';
      return `<option value="${n}"${n === current ? ' selected' : ''}>${esc(n)} minutes${custom}</option>`;
    }).join('');
  }

  function syncSameDayText() {
    $('sameDayText').textContent = sameDayEl.checked ? 'On' : 'Off';
  }

  function fill(booking) {
    renderSlotOptions(booking.slot_minutes);
    NUMBER_IDS.forEach((id) => { $(id).value = booking[id]; });
    sameDayEl.checked = booking.allow_same_day === true;
    syncSameDayText();
    POLICY_IDS.forEach((id) => { $(id).value = booking[id] || ''; });
  }

  // ── Toast ────────────────────────────────────────────────────────────────────
  function toast(message, ok) {
    const host = $('toastHost');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (ok ? CHECK : '') + `<span>${esc(message)}</span>`;
    el.style.transition = 'opacity .3s ease, transform .3s ease';
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 2600);
    setTimeout(() => el.remove(), 2950);
  }

  // ── Save ─────────────────────────────────────────────────────────────────────
  async function save(e) {
    e.preventDefault();
    clearErrors();
    const payload = collect();
    saveBtn.disabled = true;
    const label = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    try {
      const res = await fetch('/portal/api/config/booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      const data = await res.json().catch(() => ({}));
      if (res.status === 400 && Array.isArray(data.fields)) { applyErrors(data.fields); return; }
      if (!res.ok) { toast(data.error || 'Something went wrong. Try again.', false); return; }

      // Success: show exactly what the server saved (policy texts come back
      // whitespace-normalised), refresh the summary, reset dirty, update chrome.
      fill(data.section);
      saved = data.section;
      renderSummary();
      baseline = JSON.stringify(collect());
      $('summaryStale').hidden = true;
      saveNote.textContent = 'Saved · v' + data.version;
      saveNote.className = 'save-note save-note--saved';
      toast('Saved · v' + data.version, true);
      if (data.readiness && window.Portal && window.Portal.renderLifecycle) {
        window.Portal.renderLifecycle(data.readiness.status, window.Portal.deriveGoLive(data.readiness.run));
      }
    } catch (_) {
      toast('Couldn’t save — check your connection and try again.', false);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = label;
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  async function main() {
    try { await window.Portal.me; } catch (_) { return; } // shell redirected to login
    let data;
    try {
      const res = await fetch('/portal/api/config/booking', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      data = await res.json();
    } catch (_) {
      const msg = $('loadMsg');
      msg.textContent = 'We couldn’t load your booking rules. Refresh the page to try again.';
      msg.className = 'state-msg state-msg--error';
      return;
    }

    fill(data.booking);
    saved = data.booking;
    renderSummary();
    baseline = JSON.stringify(collect());

    slotEl.addEventListener('change', () => { clearFieldError('slot_minutes'); markDirty(); });
    sameDayEl.addEventListener('change', () => {
      syncSameDayText();
      clearFieldError('allow_same_day');
      markDirty();
    });
    NUMBER_IDS.concat(POLICY_IDS).forEach((id) => $(id).addEventListener('input', () => {
      clearFieldError(id);
      markDirty();
    }));
    form.addEventListener('submit', save);

    $('loadCard').hidden = true;
    form.hidden = false;
    if (data.version) { saveNote.textContent = 'Version ' + data.version; saveNote.className = 'save-note'; }
  }

  main();
})();
