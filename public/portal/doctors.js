/* ============================================================================
 * Doctors (PORTAL-P3-S8) — the first portal page that is NOT a config section.
 *
 * Doctor schedules are rows in tenant_entities, the storage appointmentService
 * reads on every availability check and every booking. Saving here changes what
 * the receptionist offers patients immediately — there is no config version to
 * bump and no revision trail, which is why this page shows no "v{N}".
 *
 *   load    → GET    /portal/api/doctors           → { doctors, languages }
 *   add     → POST   /portal/api/doctors           → { doctor, doctors, readiness }
 *   save    → PATCH  /portal/api/doctors/:id       → { doctor, doctors, readiness }
 *   remove  → DELETE /portal/api/doctors/:id       → { outcome, doctors, readiness }
 *   restore → POST   /portal/api/doctors/:id/restore
 *
 * The unit of save is ONE doctor (one row), so each card carries its own Save.
 * A doctor with no working days saves fine and is flagged "Not bookable" — that
 * is honest data, not an error. Hours outside the clinic's opening hours save
 * fine too, with a quiet warning: booking offers the overlap, so those minutes
 * simply never appear.
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';

  // Day tokens EXACTLY as the backend stores and booking matches them
  // ('Mon'..'Sun'); the label is display-only.
  const DAYS = [
    { key: 'Mon', label: 'Mon' }, { key: 'Tue', label: 'Tue' }, { key: 'Wed', label: 'Wed' },
    { key: 'Thu', label: 'Thu' }, { key: 'Fri', label: 'Fri' }, { key: 'Sat', label: 'Sat' },
    { key: 'Sun', label: 'Sun' },
  ];
  const LANG_LABEL = {
    te: { label: 'Telugu', native: 'తెలుగు' },
    hi: { label: 'Hindi', native: 'हिन्दी' },
    en: { label: 'English', native: '' },
  };
  const DEFAULT_START = '10:00';
  const DEFAULT_END = '17:00';

  const host = $('doctors');
  const archivedHost = $('archived');
  let languages = ['te', 'hi', 'en']; // replaced by the tenant's enabled set on load
  let seq = 0;                        // client-side ids for unsaved cards

  // ── Toast ──────────────────────────────────────────────────────────────────
  function toast(message, ok) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (ok ? CHECK : '') + `<span>${esc(message)}</span>`;
    el.style.transition = 'opacity .3s ease, transform .3s ease';
    $('toastHost').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 2600);
    setTimeout(() => el.remove(), 2950);
  }

  function updateHeader(readiness) {
    if (readiness && window.Portal && window.Portal.renderLifecycle) {
      window.Portal.renderLifecycle(readiness.status, window.Portal.deriveGoLive(readiness.run));
    }
  }

  // ── One doctor card ────────────────────────────────────────────────────────
  // `doctor` is a server row, or null for a new unsaved doctor.
  function card(doctor) {
    const isNew = !doctor;
    const d = doctor || {
      id: null, name: '', specialization: '', languages: [], days: [],
      start: DEFAULT_START, end: DEFAULT_END, archived: false, bookable: false, warnings: [],
    };
    const uid = 'doc' + (++seq);

    const el = document.createElement('section');
    el.className = 'doc';
    el.dataset.id = d.id || '';
    el.innerHTML =
      `<div class="doc__head">
         <span class="doc__title${isNew ? ' doc__title--new' : ''}" data-role="title">${isNew ? 'New doctor' : esc(d.name)}</span>
         <span data-role="badge"></span>
       </div>

       <div class="doc__row">
         <div class="field" data-field="name">
           <label class="field__label" for="${uid}-name">Name</label>
           <input class="input" id="${uid}-name" type="text" maxlength="120" placeholder="Dr. Sharma" value="${esc(d.name)}" autocomplete="off">
           <div class="field__error"></div>
         </div>
         <div class="field" data-field="specialization">
           <label class="field__label" for="${uid}-spec">Specialization <span class="field__opt">optional</span></label>
           <input class="input" id="${uid}-spec" type="text" maxlength="120" placeholder="Dentist" value="${esc(d.specialization)}" autocomplete="off">
           <div class="field__error"></div>
         </div>
       </div>

       <div class="field" data-field="days">
         <span class="field__label">Days this doctor sees patients</span>
         <div class="days-group" role="group" aria-label="Working days" data-role="days"></div>
         <div class="field__error"></div>
       </div>

       <div class="field" data-field="hours">
         <label class="field__label" for="${uid}-start">Working hours</label>
         <p class="field__help">Patients are only offered appointments inside these hours, and inside your clinic’s opening hours.</p>
         <div class="hours-pair">
           <input class="input hours-pair__input" id="${uid}-start" type="time" value="${esc(d.start || DEFAULT_START)}" aria-label="Starting time">
           <span class="hours-pair__to">to</span>
           <input class="input hours-pair__input" id="${uid}-end" type="time" value="${esc(d.end || DEFAULT_END)}" aria-label="Finishing time">
         </div>
         <div class="field__error"></div>
       </div>

       <div class="field" data-field="languages">
         <span class="field__label">Languages spoken <span class="field__opt">optional</span></span>
         <div class="langs-group" role="group" aria-label="Languages spoken" data-role="langs"></div>
         <div class="field__error"></div>
       </div>

       <div data-role="warn"></div>
       <div class="doc__error" data-role="formError"></div>

       <div class="doc__foot">
         <button class="doc__remove" type="button" data-role="remove"${isNew ? '' : ''}>Remove</button>
         <span class="doc__foot-spacer"></span>
         <span class="save-note" data-role="note"></span>
         <button class="btn btn--primary" type="button" data-role="save">${isNew ? 'Add doctor' : 'Save changes'}</button>
       </div>`;

    const q = (role) => el.querySelector(`[data-role="${role}"]`);

    // Day toggles — the storage's `days` array, one chip per day.
    q('days').innerHTML = DAYS.map((day) =>
      `<button class="day-toggle" type="button" data-day="${day.key}" aria-pressed="${d.days.indexOf(day.key) !== -1 ? 'true' : 'false'}">${day.label}</button>`
    ).join('');

    // Language pills — only the languages this clinic actually serves.
    q('langs').innerHTML = languages.map((code) => {
      const meta = LANG_LABEL[code] || { label: code, native: '' };
      const on = d.languages.indexOf(code) !== -1;
      return `<button class="lang-toggle" type="button" data-lang="${code}" aria-pressed="${on ? 'true' : 'false'}">
        <span>${esc(meta.label)}</span>${meta.native ? `<span class="lang-toggle__native">${esc(meta.native)}</span>` : ''}</button>`;
    }).join('');

    // ── Read the card ──
    function collect() {
      return {
        name: el.querySelector(`#${uid}-name`).value.trim(),
        specialization: el.querySelector(`#${uid}-spec`).value.trim(),
        days: Array.from(q('days').querySelectorAll('[aria-pressed="true"]')).map((b) => b.dataset.day),
        start: el.querySelector(`#${uid}-start`).value.trim(),
        end: el.querySelector(`#${uid}-end`).value.trim(),
        languages: Array.from(q('langs').querySelectorAll('[aria-pressed="true"]')).map((b) => b.dataset.lang),
      };
    }

    let baseline = JSON.stringify(collect());
    const markDirty = () => {
      if (isNew && !el.dataset.id) return; // a new card is dirty by definition
      const dirty = JSON.stringify(collect()) !== baseline;
      q('note').textContent = dirty ? 'Unsaved changes' : '';
      q('note').className = 'save-note' + (dirty ? ' save-note--dirty' : '');
    };

    // ── Errors ──
    function clearErrors() {
      el.classList.remove('is-invalid');
      q('formError').textContent = '';
      el.querySelectorAll('.field.is-invalid').forEach((f) => f.classList.remove('is-invalid'));
      el.querySelectorAll('.field__error').forEach((e) => { e.textContent = ''; });
      el.querySelectorAll('.input--invalid').forEach((i) => i.classList.remove('input--invalid'));
    }
    function applyErrors(fields) {
      clearErrors();
      let first = null;
      for (const f of fields) {
        const wrap = el.querySelector(`.field[data-field="${f.field}"]`);
        if (!wrap) {
          el.classList.add('is-invalid');
          q('formError').textContent = f.message;
          continue;
        }
        wrap.classList.add('is-invalid');
        const err = wrap.querySelector('.field__error');
        if (err) err.textContent = f.message;
        wrap.querySelectorAll('.input').forEach((i) => i.classList.add('input--invalid'));
        if (!first) first = wrap.querySelector('.input') || wrap;
      }
      if (first && first.focus) first.focus();
      if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    // Badges + warnings reflect what BOOKING will do with this doctor, so they
    // are re-rendered from the server's answer after every save — never guessed
    // client-side.
    function renderState(row) {
      const badge = q('badge');
      if (row.archived) {
        badge.innerHTML = '<span class="badge badge--muted">No longer seeing patients</span>';
      } else if (!row.bookable) {
        badge.innerHTML = '<span class="badge badge--warn">Not bookable — no working days</span>';
      } else {
        badge.innerHTML = '';
      }
      const warns = row.warnings || [];
      q('warn').innerHTML = warns.length
        ? `<div class="doc__warn">${WARN}<ul>${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
        : '';
      q('title').textContent = row.name || 'New doctor';
      q('title').className = 'doc__title';
    }
    if (!isNew) renderState(d);

    // ── Wiring ──
    el.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => {
      const wrap = i.closest('.field');
      if (wrap) {
        wrap.classList.remove('is-invalid');
        const err = wrap.querySelector('.field__error');
        if (err) err.textContent = '';
        wrap.querySelectorAll('.input--invalid').forEach((x) => x.classList.remove('input--invalid'));
      }
      markDirty();
    }));
    q('days').querySelectorAll('.day-toggle').forEach((btn) => btn.addEventListener('click', () => {
      btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      markDirty();
    }));
    q('langs').querySelectorAll('.lang-toggle').forEach((btn) => btn.addEventListener('click', () => {
      btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      markDirty();
    }));

    // ── Save (POST for a new doctor, PATCH for an existing one) ──
    q('save').addEventListener('click', async () => {
      clearErrors();
      const id = el.dataset.id;
      const btn = q('save');
      // After the first successful add the card is an existing doctor, so the
      // button settles on "Save changes" for good.
      let label = id ? 'Save changes' : 'Add doctor';
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const res = await fetch(id ? `/portal/api/doctors/${encodeURIComponent(id)}` : '/portal/api/doctors', {
          method: id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(collect()),
        });
        if (res.status === 401) { window.location.replace('login.html'); return; }
        const data = await res.json().catch(() => ({}));
        if (res.status === 400 && Array.isArray(data.fields)) { applyErrors(data.fields); return; }
        if (!res.ok) { toast(data.error || 'Something went wrong. Try again.', false); return; }

        // The server's row is the truth — including the derived bookable flag and
        // the clinic-hours warnings.
        el.dataset.id = data.doctor.id;
        renderState(data.doctor);
        baseline = JSON.stringify(collect());
        q('note').textContent = 'Saved';
        q('note').className = 'save-note save-note--saved';
        label = 'Save changes';
        toast(id ? 'Saved' : `${data.doctor.name} added`, true);
        updateHeader(data.readiness);
        refreshChrome();
      } catch (_) {
        toast('Couldn’t save — check your connection and try again.', false);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });

    // ── Remove: confirm in place, then let the server decide delete vs archive ──
    let confirming = false;
    q('remove').addEventListener('click', async () => {
      const id = el.dataset.id;
      if (!id) { // an unsaved card — nothing to delete
        el.remove();
        refreshChrome();
        return;
      }
      const btn = q('remove');
      if (!confirming) {
        confirming = true;
        btn.textContent = 'Remove — tap to confirm';
        btn.classList.add('doc__remove--confirm');
        setTimeout(() => {
          if (!confirming) return;
          confirming = false;
          btn.textContent = 'Remove';
          btn.classList.remove('doc__remove--confirm');
        }, 4000);
        return;
      }
      confirming = false;
      btn.disabled = true;
      btn.textContent = 'Removing…';
      try {
        const res = await fetch(`/portal/api/doctors/${encodeURIComponent(id)}`, {
          method: 'DELETE', headers: { Accept: 'application/json' },
        });
        if (res.status === 401) { window.location.replace('login.html'); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { toast(data.error || 'Couldn’t remove this doctor.', false); return; }
        // Honest about what actually happened: a doctor with appointments on the
        // books is kept (archived), not deleted.
        toast(data.outcome === 'archived'
          ? 'Removed from booking — kept because they have appointments'
          : 'Doctor removed', true);
        updateHeader(data.readiness);
        render(data.doctors);
      } catch (_) {
        toast('Couldn’t remove — check your connection and try again.', false);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Remove';
        btn.classList.remove('doc__remove--confirm');
      }
    });

    if (isNew) { q('note').textContent = ''; }
    return el;
  }

  // ── Archived row ───────────────────────────────────────────────────────────
  function archivedRow(d) {
    const row = document.createElement('div');
    row.className = 'arch-row';
    const days = d.days && d.days.length ? d.days.join(', ') : 'no working days';
    row.innerHTML =
      `<span class="arch-row__name">${esc(d.name)}</span>
       <span class="arch-row__meta">${esc(days)}</span>
       <span class="arch-row__spacer"></span>
       <button class="btn" type="button">Bring back</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      const btn = row.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Restoring…';
      try {
        const res = await fetch(`/portal/api/doctors/${encodeURIComponent(d.id)}/restore`, {
          method: 'POST', headers: { Accept: 'application/json' },
        });
        if (res.status === 401) { window.location.replace('login.html'); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast((data.fields && data.fields[0] && data.fields[0].message) || data.error || 'Couldn’t bring this doctor back.', false);
          return;
        }
        toast(`${data.doctor.name} is seeing patients again`, true);
        updateHeader(data.readiness);
        render(data.doctors);
      } catch (_) {
        toast('Couldn’t restore — check your connection and try again.', false);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Bring back';
      }
    });
    return row;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render(list) {
    const active = (list || []).filter((d) => !d.archived);
    const archived = (list || []).filter((d) => d.archived);

    host.innerHTML = '';
    active.forEach((d) => host.appendChild(card(d)));

    archivedHost.innerHTML = '';
    archived.forEach((d) => archivedHost.appendChild(archivedRow(d)));
    $('archivedCard').hidden = archived.length === 0;

    refreshChrome();
  }

  // Empty state vs list footer. Driven by what is ON SCREEN (including an unsaved
  // new card), so adding a doctor immediately replaces the empty state.
  function refreshChrome() {
    const cards = host.querySelectorAll('.doc').length;
    $('emptyCard').hidden = cards > 0;
    $('listFoot').hidden = cards === 0;
  }

  function addBlank() {
    const el = card(null);
    host.appendChild(el);
    refreshChrome();
    const first = el.querySelector('.input');
    if (first && first.focus) first.focus();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function main() {
    try { await window.Portal.me; } catch (_) { return; } // shell redirected to login
    let data;
    try {
      const res = await fetch('/portal/api/doctors', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      data = await res.json();
    } catch (_) {
      const msg = $('loadMsg');
      msg.textContent = 'We couldn’t load your doctors. Refresh the page to try again.';
      msg.className = 'state-msg state-msg--error';
      return;
    }

    if (Array.isArray(data.languages) && data.languages.length) languages = data.languages;
    $('loadCard').hidden = true;
    render(data.doctors || []);

    $('addDoctor').addEventListener('click', addBlank);
    $('emptyAdd').addEventListener('click', addBlank);
  }

  main();
})();
