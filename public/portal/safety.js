/* ============================================================================
 * Safety & handoff (PORTAL-P3-S10) — the fifth owner-writable config surface,
 * plus the read-only protections panel.
 *
 * Copies the S4/S5/S6/S9 pattern exactly:
 *   load  → GET  /portal/api/config/safety → fill toggle, numbers, emergency text
 *   save  → POST /portal/api/config/safety → { section, version, readiness }
 *           → "Saved · v{N}" toast, update the header go-live control, reset dirty
 *   error → 400 { fields:[{field,message}] } → inline, per-field messages
 *
 * The protections panel is fetched from GET /portal/api/protections and rendered
 * read-only — no toggles, no config keys (INV-3). Its contents come from the same
 * catalog the protections test asserts against, so this page cannot display a
 * claim that isn't provably in the prompt. That is the whole point of the panel:
 * an unenforced safety promise shown to a paying clinic is worse than no panel.
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const XMARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>';

  const form = $('safetyForm');
  const enabledEl = $('enabled');
  const phonesHost = $('phones');
  const saveBtn = $('saveBtn');
  const saveNote = $('saveNote');

  let baseline = ''; // JSON of the last-saved form state — drives the dirty note

  // ── Dirty tracking ───────────────────────────────────────────────────────────
  function markDirty() {
    const dirty = JSON.stringify(collect()) !== baseline;
    saveNote.textContent = dirty ? 'Unsaved changes' : '';
    saveNote.className = 'save-note' + (dirty ? ' save-note--dirty' : '');
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

  function fieldError(name, message) {
    const f = form.querySelector(`.field[data-field="${name}"]`);
    if (!f) return;
    f.classList.add('is-invalid');
    const err = f.querySelector('.field__error');
    if (err) err.textContent = message;
  }

  // Server field errors. Number errors carry a row index (phone_numbers.N) so the
  // exact row is marked; the shared message sits under the list.
  function applyErrors(fields) {
    clearErrors();
    let phoneMsg = null;
    let firstEl = null;
    const rows = phonesHost.querySelectorAll('.phone-row');
    for (const f of fields) {
      if (f.field.indexOf('phone_numbers.') === 0) {
        const row = rows[Number(f.field.split('.')[1])];
        const input = row && row.querySelector('.input');
        if (input) { input.classList.add('input--invalid'); if (!firstEl) firstEl = input; }
        if (!phoneMsg) phoneMsg = f.message;
        continue;
      }
      if (f.field === 'phone_numbers') { if (!phoneMsg) phoneMsg = f.message; continue; }
      const el = form.querySelector(`.field[data-field="${f.field}"]`);
      if (!el) continue;
      el.classList.add('is-invalid');
      const err = el.querySelector('.field__error');
      if (err) err.textContent = f.message;
      const input = el.querySelector('.input');
      if (input) input.classList.add('input--invalid');
      if (!firstEl) firstEl = input || el;
    }
    if (phoneMsg) fieldError('phone_numbers', phoneMsg);
    if (firstEl && firstEl.focus) firstEl.focus();
    if (firstEl && firstEl.scrollIntoView) firstEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ── Staff number rows ────────────────────────────────────────────────────────
  function addPhoneRow(value) {
    const row = document.createElement('div');
    row.className = 'phone-row';
    row.innerHTML =
      `<input class="input" type="tel" autocomplete="off" placeholder="+91 98765 43210" value="${esc(value || '')}">
       <button class="phone-row__remove" type="button" aria-label="Remove this number">${XMARK}</button>`;
    const input = row.querySelector('.input');
    input.addEventListener('input', () => {
      input.classList.remove('input--invalid');
      clearFieldError('phone_numbers');
      markDirty();
    });
    row.querySelector('.phone-row__remove').addEventListener('click', () => {
      row.remove();
      if (!phonesHost.querySelector('.phone-row')) addPhoneRow(''); // always keep one row
      clearFieldError('phone_numbers');
      markDirty();
    });
    phonesHost.appendChild(row);
  }

  function renderPhones(list) {
    phonesHost.innerHTML = '';
    if (!list || list.length === 0) addPhoneRow('');
    else list.forEach((p) => addPhoneRow(p));
  }

  // ── Collect / fill ───────────────────────────────────────────────────────────
  // Numbers go up as typed. The server normalises them (INV-6) and rejects what it
  // can't read — it never rewrites a number into something the owner didn't enter.
  function collect() {
    return {
      enabled: enabledEl.checked,
      phone_numbers: Array.from(phonesHost.querySelectorAll('.phone-row .input')).map((i) => i.value.trim()),
      emergency_guidance: $('emergency_guidance').value.trim(),
      emergency_number: $('emergency_number').value.trim(),
    };
  }

  function syncEnabledText() {
    $('enabledText').textContent = enabledEl.checked ? 'On' : 'Off';
  }

  function fill(safety) {
    enabledEl.checked = safety.enabled === true;
    syncEnabledText();
    renderPhones(safety.phone_numbers || []);
    $('emergency_guidance').value = safety.emergency_guidance || '';
    $('emergency_number').value = safety.emergency_number || '';
  }

  // ── Protections panel (read-only) ────────────────────────────────────────────
  function renderProtections(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    $('protList').innerHTML = list.map((p) => `
      <li class="prot__item">
        <span class="prot__icon" aria-hidden="true">${SHIELD}</span>
        <div class="prot__body">
          <div class="prot__title">${esc(p.title)}</div>
          <p class="prot__detail">${esc(p.detail)}</p>
          ${(p.instructions || []).map((t) => `<p class="prot__quote">${esc(t)}</p>`).join('')}
        </div>
      </li>`).join('');
    $('protCard').hidden = false;
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
      const res = await fetch('/portal/api/config/safety', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      const data = await res.json().catch(() => ({}));
      if (res.status === 400 && Array.isArray(data.fields)) { applyErrors(data.fields); return; }
      if (!res.ok) { toast(data.error || 'Something went wrong. Try again.', false); return; }

      // Success: show exactly what the server saved (numbers come back normalised,
      // the guidance whitespace-collapsed), reset dirty, update the header.
      fill(data.section);
      baseline = JSON.stringify(collect());
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
      const res = await fetch('/portal/api/config/safety', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      data = await res.json();
    } catch (_) {
      const msg = $('loadMsg');
      msg.textContent = 'We couldn’t load your safety settings. Refresh the page to try again.';
      msg.className = 'state-msg state-msg--error';
      return;
    }

    fill(data.safety);
    baseline = JSON.stringify(collect());

    enabledEl.addEventListener('change', () => {
      syncEnabledText();
      clearFieldError('enabled');
      markDirty();
    });
    ['emergency_guidance', 'emergency_number'].forEach((id) => $(id).addEventListener('input', () => {
      clearFieldError(id);
      markDirty();
    }));
    $('addPhone').addEventListener('click', () => { addPhoneRow(''); markDirty(); });
    form.addEventListener('submit', save);

    $('loadCard').hidden = true;
    form.hidden = false;
    if (data.version) { saveNote.textContent = 'Version ' + data.version; saveNote.className = 'save-note'; }

    // The panel is chrome: a failure here must never take the form down with it.
    try {
      const res = await fetch('/portal/api/protections', { headers: { Accept: 'application/json' } });
      if (res.ok) renderProtections((await res.json()).protections);
    } catch (_) { /* panel stays hidden */ }
  }

  main();
})();
