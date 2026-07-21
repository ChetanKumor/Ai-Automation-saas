/* ============================================================================
 * Receptionist (PORTAL-P5-S13) — persona + voice.
 *
 * Copies the S4/S5/S6/S9/S10 pattern exactly:
 *   load  → GET  /portal/api/config/receptionist → fill name/tone/greeting/voice
 *   save  → POST /portal/api/config/receptionist → { section, version, readiness }
 *           → "Saved · v{N}" toast, update the header go-live control, reset dirty
 *   error → 400 { fields:[{field,message}] } → inline, per-field messages
 *
 * Two page-specific pieces:
 *   • Greeting fields are BUILT AT RUNTIME from the tenant's own enabled
 *     languages (never hardcoded te/hi/en) — one field per language, the
 *     default language marked and required.
 *   • The Voice card carries an honest "not fully wired yet" notice (see
 *     receptionist.css .gap-notice): PORTAL-P5-S13 found the voice worker
 *     doesn't read these fields yet (see the session's schema.js comments).
 *     The controls still save real config — future wiring reads them as-is.
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LANG_LABEL = { te: 'Telugu', hi: 'Hindi', en: 'English' };
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  const form = $('receptionistForm');
  const saveBtn = $('saveBtn');
  const saveNote = $('saveNote');

  let languages = [];   // this tenant's enabled languages, from the last load
  let defaultLang = 'en';
  let baseline = '';    // JSON of the last-saved form state — drives the dirty note

  // ── Segmented control (Tone / Response length) ──────────────────────────────
  function segmented(hostId) {
    const host = $(hostId);
    const btns = Array.from(host.querySelectorAll('.segmented__btn'));
    return {
      wire(onChange) {
        btns.forEach((b) => b.addEventListener('click', () => {
          btns.forEach((x) => x.classList.remove('segmented__btn--active'));
          b.classList.add('segmented__btn--active');
          onChange();
        }));
      },
      get: () => {
        const active = host.querySelector('.segmented__btn--active');
        return active ? active.dataset.value : btns[0].dataset.value;
      },
      set: (value) => btns.forEach((b) => b.classList.toggle('segmented__btn--active', b.dataset.value === value)),
    };
  }
  const toneCtl = segmented('toneControl');
  const lengthCtl = segmented('lengthControl');

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
      const input = el.querySelector('.input, .segmented, .pace__slider');
      if (!firstEl) firstEl = input || el;
    }
    if (firstEl && firstEl.focus) firstEl.focus();
    if (firstEl && firstEl.scrollIntoView) firstEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ── Greeting fields (built from the tenant's own enabled languages) ─────────
  function renderGreeting(rec) {
    const host = $('greetingFields');
    host.innerHTML = rec.languages.map((lang) => {
      const isDefault = lang === rec.default_language;
      const label = LANG_LABEL[lang] || lang;
      return `<div class="field greet-field greet-field--${esc(lang)}" data-field="greeting.${esc(lang)}">
        <label class="greet-field__label" for="greet-${esc(lang)}">${esc(label)}
          ${isDefault ? '<span class="greet-field__badge">Default</span>' : '<span class="field__opt">optional</span>'}
        </label>
        <p class="field__help">${isDefault
          ? 'The first thing a caller or customer hears — required, since this is your default language.'
          : `Leave blank to use your ${esc(LANG_LABEL[rec.default_language] || rec.default_language)} greeting instead.`}</p>
        <textarea class="input" id="greet-${esc(lang)}" lang="${esc(lang)}" maxlength="300" rows="2"
          placeholder="Hello! Welcome. How can I help you today?"></textarea>
        <div class="field__error"></div>
      </div>`;
    }).join('');
    rec.languages.forEach((lang) => {
      const el = $(`greet-${lang}`);
      el.value = (rec.greeting && rec.greeting[lang]) || '';
      el.addEventListener('input', () => { clearFieldError(`greeting.${lang}`); markDirty(); });
    });
  }

  // ── Voice speaker options (the real bulbul:v3 list, from the server) ───────
  function renderSpeakerOptions(speakers) {
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const group = (label, list) => list.length
      ? `<optgroup label="${label}">${list.map((s) => `<option value="${esc(s.value)}">${esc(cap(s.value))}</option>`).join('')}</optgroup>`
      : '';
    const female = speakers.filter((s) => s.gender === 'female');
    const male = speakers.filter((s) => s.gender === 'male');
    const other = speakers.filter((s) => s.gender !== 'female' && s.gender !== 'male');
    $('voiceSpeaker').innerHTML = group('Female', female) + group('Male', male) + group('Voice', other);
  }

  // ── Speaking pace ────────────────────────────────────────────────────────────
  function paceLabel(v) {
    if (v < 0.95) return 'Slower';
    if (v > 1.05) return 'Faster';
    return 'Normal';
  }
  function syncPaceLabel() {
    $('paceValue').textContent = paceLabel(Number($('pace').value));
  }

  // ── Collect / fill ───────────────────────────────────────────────────────────
  function collect() {
    const greeting = {};
    languages.forEach((lang) => {
      const el = $(`greet-${lang}`);
      greeting[lang] = el ? el.value.trim() : '';
    });
    return {
      display_name: $('displayName').value.trim(),
      greeting,
      tone: toneCtl.get(),
      response_length: lengthCtl.get(),
      voice_speaker: $('voiceSpeaker').value,
      pace: Number($('pace').value),
    };
  }

  function fill(rec) {
    languages = Array.isArray(rec.languages) ? rec.languages.slice() : [];
    defaultLang = rec.default_language || languages[0] || 'en';
    $('displayName').value = rec.display_name || '';
    renderGreeting(rec);
    toneCtl.set(rec.tone === 'professional' ? 'professional' : 'warm');
    lengthCtl.set(rec.response_length === 'concise' ? 'concise' : 'standard');
    if (rec.voice_speaker) $('voiceSpeaker').value = rec.voice_speaker;
    $('pace').value = typeof rec.pace === 'number' ? rec.pace : 1.0;
    syncPaceLabel();
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
      const res = await fetch('/portal/api/config/receptionist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      const data = await res.json().catch(() => ({}));
      if (res.status === 400 && Array.isArray(data.fields)) { applyErrors(data.fields); return; }
      if (!res.ok) { toast(data.error || 'Something went wrong. Try again.', false); return; }

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
      const res = await fetch('/portal/api/config/receptionist', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      data = await res.json();
    } catch (_) {
      const msg = $('loadMsg');
      msg.textContent = 'We couldn’t load your receptionist settings. Refresh the page to try again.';
      msg.className = 'state-msg state-msg--error';
      return;
    }

    renderSpeakerOptions(data.speakers || []);
    fill(data.receptionist);
    baseline = JSON.stringify(collect());

    toneCtl.wire(() => { clearFieldError('tone'); markDirty(); });
    lengthCtl.wire(() => { clearFieldError('response_length'); markDirty(); });
    $('displayName').addEventListener('input', () => { clearFieldError('display_name'); markDirty(); });
    $('voiceSpeaker').addEventListener('change', () => { clearFieldError('voice_speaker'); markDirty(); });
    $('pace').addEventListener('input', () => { syncPaceLabel(); clearFieldError('pace'); markDirty(); });
    form.addEventListener('submit', save);

    $('loadCard').hidden = true;
    form.hidden = false;
    if (data.version) { saveNote.textContent = 'Version ' + data.version; saveNote.className = 'save-note'; }
  }

  main();
})();
