/* ============================================================================
 * Clinic profile (PORTAL-P2-S4) — the first owner-writable config surface.
 *
 * Establishes the config-write pattern every later page copies:
 *   load  → GET  /portal/api/config/identity  → fill the form
 *   save  → POST /portal/api/config/identity  → { section, version, readiness }
 *           → "Saved · v{N}" toast, update the header go-live control, reset dirty
 *   error → 400 { fields:[{field,message}] } → inline, field-level messages
 *
 * No autosave, no optimistic UI: the form shows exactly what the server returned.
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const XMARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  // Telugu / Hindi / English (spec §5.2 order), each with its native-script tag.
  const LANGS = [
    { code: 'te', label: 'Telugu', native: 'తెలుగు' },
    { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
    { code: 'en', label: 'English', native: '' },
  ];

  const form = $('profileForm');
  const phonesHost = $('phones');
  const langsHost = $('langs');
  const saveBtn = $('saveBtn');
  const saveNote = $('saveNote');
  const SCALARS = ['display_name', 'address', 'landmark', 'website'];

  let baseline = ''; // JSON of the last-saved form state — drives the dirty note

  // ── Errors ─────────────────────────────────────────────────────────────────
  function clearErrors() {
    form.querySelectorAll('.field.is-invalid').forEach((f) => f.classList.remove('is-invalid'));
    form.querySelectorAll('.input--invalid').forEach((i) => i.classList.remove('input--invalid'));
    form.querySelectorAll('.field__error').forEach((e) => { e.textContent = ''; });
  }
  function fieldError(field, message) {
    const wrap = form.querySelector(`.field[data-field="${field}"]`);
    if (wrap) wrap.classList.add('is-invalid');
    const err = $('err-' + field);
    if (err) err.textContent = message;
    const input = $(field);            // scalar fields share id/name/data-field
    if (input) input.classList.add('input--invalid');
  }
  function clearFieldError(field) {
    const wrap = form.querySelector(`.field[data-field="${field}"]`);
    if (wrap) wrap.classList.remove('is-invalid');
    const err = $('err-' + field);
    if (err) err.textContent = '';
    const input = $(field);
    if (input) input.classList.remove('input--invalid');
  }
  // Apply server field errors. Phone errors carry a row index (phone_numbers.N)
  // aligned with the rows we POST (we send every row, empties included, so the
  // server's index maps 1:1 to a DOM row).
  function applyErrors(fields) {
    clearErrors();
    let phoneMsg = null;
    const rows = phonesHost.querySelectorAll('.phone-row');
    for (const f of fields) {
      if (f.field.indexOf('phone_numbers.') === 0) {
        const idx = Number(f.field.split('.')[1]);
        if (rows[idx]) { const i = rows[idx].querySelector('.input'); if (i) i.classList.add('input--invalid'); }
        if (!phoneMsg) phoneMsg = f.message;
      } else if (f.field === 'phone_numbers') {
        if (!phoneMsg) phoneMsg = f.message;
      } else {
        fieldError(f.field, f.message);
      }
    }
    if (phoneMsg) fieldError('phone_numbers', phoneMsg);
    const first = form.querySelector('.input--invalid, .field.is-invalid .input');
    if (first && first.focus) first.focus();
  }

  // ── Dirty tracking (trivial unsaved-changes note) ────────────────────────────
  function markDirty() {
    if (saveNote.classList.contains('save-note--saved') && JSON.stringify(collect()) === baseline) return;
    const dirty = JSON.stringify(collect()) !== baseline;
    saveNote.textContent = dirty ? 'Unsaved changes' : '';
    saveNote.className = 'save-note' + (dirty ? ' save-note--dirty' : '');
  }

  // ── Phone rows ───────────────────────────────────────────────────────────────
  function addPhoneRow(value) {
    const row = document.createElement('div');
    row.className = 'phone-row';
    row.innerHTML =
      `<input class="input" type="tel" inputmode="tel" autocomplete="tel" placeholder="+91 98765 43210" value="${esc(value || '')}">
       <button class="phone-row__remove" type="button" aria-label="Remove this number">${XMARK}</button>`;
    const input = row.querySelector('.input');
    input.addEventListener('input', () => { input.classList.remove('input--invalid'); clearFieldError('phone_numbers'); markDirty(); });
    row.querySelector('.phone-row__remove').addEventListener('click', () => {
      row.remove();
      if (!phonesHost.querySelector('.phone-row')) addPhoneRow(''); // always keep one row
      markDirty();
    });
    phonesHost.appendChild(row);
    return input;
  }
  function renderPhones(list) {
    phonesHost.innerHTML = '';
    const nums = (list && list.length) ? list : [''];
    nums.forEach((n) => addPhoneRow(n));
  }

  // ── Language toggles ─────────────────────────────────────────────────────────
  function renderLangs(enabled) {
    langsHost.innerHTML = '';
    const on = new Set(enabled || []);
    LANGS.forEach((l) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-toggle lang-toggle--' + l.code;
      btn.dataset.code = l.code;
      btn.setAttribute('aria-pressed', on.has(l.code) ? 'true' : 'false');
      btn.innerHTML =
        `<span class="lang-toggle__check">${CHECK}</span><span>${esc(l.label)}</span>` +
        (l.native ? `<span class="lang-toggle__native">${esc(l.native)}</span>` : '');
      btn.addEventListener('click', () => {
        btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        clearFieldError('languages');
        markDirty();
      });
      langsHost.appendChild(btn);
    });
  }

  // ── Collect / fill ───────────────────────────────────────────────────────────
  // Phones are sent RAW (every row, empties included) so a server error index
  // maps 1:1 to a DOM row; the server drops empty rows and normalizes the rest.
  function collect() {
    return {
      display_name: $('display_name').value.trim(),
      address: $('address').value.trim(),
      landmark: $('landmark').value.trim(),
      website: $('website').value.trim(),
      phone_numbers: Array.from(phonesHost.querySelectorAll('.phone-row .input')).map((i) => i.value.trim()),
      languages: Array.from(langsHost.querySelectorAll('.lang-toggle[aria-pressed="true"]')).map((b) => b.dataset.code),
    };
  }
  function fill(identity) {
    $('display_name').value = identity.display_name || '';
    $('address').value = identity.address || '';
    $('landmark').value = identity.landmark || '';
    $('website').value = identity.website || '';
    renderPhones(identity.phone_numbers || []);
    renderLangs(identity.languages || []);
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
      const res = await fetch('/portal/api/config/identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      const data = await res.json().catch(() => ({}));
      if (res.status === 400 && Array.isArray(data.fields)) { applyErrors(data.fields); return; }
      if (!res.ok) { toast(data.error || 'Something went wrong. Try again.', false); return; }

      // Success: show exactly what the server saved, reset dirty, update chrome.
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
      const res = await fetch('/portal/api/config/identity', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      data = await res.json();
    } catch (_) {
      const msg = $('loadMsg');
      msg.textContent = 'We couldn’t load your clinic profile. Refresh the page to try again.';
      msg.className = 'state-msg state-msg--error';
      return;
    }

    fill(data.identity);
    baseline = JSON.stringify(collect());
    SCALARS.forEach((id) => $(id).addEventListener('input', () => { clearFieldError(id); markDirty(); }));
    $('addPhone').addEventListener('click', () => { const i = addPhoneRow(''); markDirty(); if (i) i.focus(); });
    form.addEventListener('submit', save);

    $('loadCard').hidden = true;
    $('profileCard').hidden = false;
    if (data.version) { saveNote.textContent = 'Version ' + data.version; saveNote.className = 'save-note'; }
  }

  main();
})();
