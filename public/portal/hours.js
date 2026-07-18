/* ============================================================================
 * Hours & holidays (PORTAL-P2-S5) — the second owner-writable config surface.
 *
 * Copies the S4 clinic-profile pattern exactly:
 *   load  → GET  /portal/api/config/hours  → fill the grid + holiday rows
 *   save  → POST /portal/api/config/hours  → { section, version, readiness }
 *           → "Saved · v{N}" toast, update the header go-live control, reset dirty
 *   error → 400 { fields:[{field,message}] } → inline, per-row messages
 *
 * A day is EITHER open (open + close time) OR closed (a per-day "Closed" toggle).
 * Holidays are date + optional name; past dates are allowed but de-emphasised.
 * No autosave, no optimistic UI. Spec §5.3 (after-hours message + emergency number
 * deferred — no schema home yet).
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const XMARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_LABEL = {
    mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
    fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
  };

  const form = $('hoursForm');
  const daysHost = $('days');
  const holidaysHost = $('holidays');
  const saveBtn = $('saveBtn');
  const saveNote = $('saveNote');

  let baseline = ''; // JSON of the last-saved form state — drives the dirty note

  // Today's local date as YYYY-MM-DD — for de-emphasising past holidays.
  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  const isPast = (date) => !!date && date < todayStr();

  // ── Dirty tracking ───────────────────────────────────────────────────────────
  function markDirty() {
    if (saveNote.classList.contains('save-note--saved') && JSON.stringify(collect()) === baseline) return;
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
  function clearDayError(key) {
    const row = daysHost.querySelector(`.day[data-day="${key}"]`);
    if (!row) return;
    row.classList.remove('is-invalid');
    const e = row.querySelector('.day__error');
    if (e) e.textContent = '';
  }
  // Server field errors: `days.<key>` mark the day row; `holidays.<i>` mark the
  // i-th holiday row (indices map 1:1 — we POST every row, empties included).
  function applyErrors(fields) {
    clearErrors();
    const holRows = holidaysHost.querySelectorAll('.holiday-row');
    for (const f of fields) {
      if (f.field.indexOf('days.') === 0) {
        const key = f.field.split('.')[1];
        const row = daysHost.querySelector(`.day[data-day="${key}"]`);
        if (row) {
          row.classList.add('is-invalid');
          const e = row.querySelector('.day__error');
          if (e) e.textContent = f.message;
        }
      } else if (f.field.indexOf('holidays.') === 0) {
        const idx = Number(f.field.split('.')[1]);
        const row = holRows[idx];
        if (row) {
          row.classList.add('is-invalid');
          const e = row.querySelector('.holiday__error');
          if (e) e.textContent = f.message;
        }
      }
    }
    const first = form.querySelector('.day.is-invalid, .holiday-row.is-invalid');
    if (first) { const inp = first.querySelector('.input'); if (inp && inp.focus) inp.focus(); }
  }

  // ── Day rows ─────────────────────────────────────────────────────────────────
  function renderDays(days) {
    daysHost.innerHTML = '';
    (days || []).forEach((d) => {
      const row = document.createElement('div');
      row.className = 'day' + (d.closed ? ' day--closed' : '');
      row.dataset.day = d.key;
      row.innerHTML =
        `<div class="day__name">${esc(DAY_LABEL[d.key] || d.key)}</div>
         <div class="day__body">
           <div class="day__times">
             <input class="input day__time" type="time" data-role="open" value="${esc(d.open)}" aria-label="${esc(DAY_LABEL[d.key])} opening time">
             <span class="day__to">to</span>
             <input class="input day__time" type="time" data-role="close" value="${esc(d.close)}" aria-label="${esc(DAY_LABEL[d.key])} closing time">
           </div>
           <div class="day__closed-label">Closed all day</div>
         </div>
         <label class="day__toggle">
           <input type="checkbox" class="day__cb"${d.closed ? ' checked' : ''}>
           <span>Closed</span>
         </label>
         <div class="field__error day__error"></div>`;
      const cb = row.querySelector('.day__cb');
      cb.addEventListener('change', () => {
        row.classList.toggle('day--closed', cb.checked);
        clearDayError(d.key);
        markDirty();
      });
      row.querySelectorAll('.day__time').forEach((i) =>
        i.addEventListener('input', () => { clearDayError(d.key); markDirty(); }));
      daysHost.appendChild(row);
    });
  }

  // ── Holiday rows ─────────────────────────────────────────────────────────────
  function addHolidayRow(h) {
    h = h || { date: '', name: '' };
    const row = document.createElement('div');
    row.className = 'holiday-row' + (isPast(h.date) ? ' holiday-row--past' : '');
    row.innerHTML =
      `<input class="input holiday__date" type="date" value="${esc(h.date)}" aria-label="Holiday date">
       <input class="input holiday__name" type="text" maxlength="120" placeholder="Holiday name (optional)" value="${esc(h.name)}" aria-label="Holiday name">
       <span class="holiday__past" aria-hidden="true">past</span>
       <button class="holiday__remove" type="button" aria-label="Remove this holiday">${XMARK}</button>
       <div class="field__error holiday__error"></div>`;
    const date = row.querySelector('.holiday__date');
    date.addEventListener('input', () => {
      row.classList.toggle('holiday-row--past', isPast(date.value));
      row.classList.remove('is-invalid');
      markDirty();
    });
    row.querySelector('.holiday__name').addEventListener('input', () => {
      row.classList.remove('is-invalid');
      markDirty();
    });
    row.querySelector('.holiday__remove').addEventListener('click', () => {
      row.remove();
      refreshHolidayEmpty();
      markDirty();
    });
    holidaysHost.appendChild(row);
    return row;
  }
  function renderHolidays(list) {
    holidaysHost.innerHTML = '';
    const sorted = (list || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    sorted.forEach((h) => addHolidayRow(h));
    refreshHolidayEmpty();
  }
  function refreshHolidayEmpty() {
    $('holidaysEmpty').hidden = holidaysHost.querySelector('.holiday-row') != null;
  }

  // ── Collect / fill ───────────────────────────────────────────────────────────
  function collect() {
    const days = {};
    daysHost.querySelectorAll('.day').forEach((row) => {
      const key = row.dataset.day;
      const closed = row.querySelector('.day__cb').checked;
      if (closed) { days[key] = { closed: true }; return; }
      days[key] = {
        closed: false,
        open: row.querySelector('[data-role="open"]').value,
        close: row.querySelector('[data-role="close"]').value,
      };
    });
    // Every row is sent (empties included) so a server error index maps 1:1 to a
    // DOM row; the server drops empty rows and normalises the rest.
    const holidays = Array.from(holidaysHost.querySelectorAll('.holiday-row')).map((row) => ({
      date: row.querySelector('.holiday__date').value,
      name: row.querySelector('.holiday__name').value.trim(),
    }));
    return { days, holidays };
  }
  function fill(hours) {
    renderDays(hours.days || []);
    renderHolidays(hours.holidays || []);
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
      const res = await fetch('/portal/api/config/hours', {
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
      const res = await fetch('/portal/api/config/hours', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      data = await res.json();
    } catch (_) {
      const msg = $('loadMsg');
      msg.textContent = 'We couldn’t load your hours. Refresh the page to try again.';
      msg.className = 'state-msg state-msg--error';
      return;
    }

    fill(data.hours);
    baseline = JSON.stringify(collect());
    $('addHoliday').addEventListener('click', () => {
      const row = addHolidayRow();
      refreshHolidayEmpty();
      markDirty();
      const d = row.querySelector('.holiday__date');
      if (d && d.focus) d.focus();
    });
    form.addEventListener('submit', save);

    $('loadCard').hidden = true;
    form.hidden = false;
    if (data.version) { saveNote.textContent = 'Version ' + data.version; saveNote.className = 'save-note'; }
  }

  main();
})();
