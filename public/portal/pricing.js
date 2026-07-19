/* ============================================================================
 * Pricing (PORTAL-P2-S6) — the third owner-writable config surface.
 *
 * Copies the S4/S5 pattern exactly:
 *   load  → GET  /portal/api/config/pricing  → fill fees, treatments, payment
 *   save  → POST /portal/api/config/pricing  → { section, version, readiness }
 *           → "Saved · v{N}" toast, update the header go-live control, reset dirty
 *   error → 400 { fields:[{field,message}] } → inline, per-field / per-row messages
 *
 * What is saved here is quoted VERBATIM by the receptionist (it renders into the
 * prompt's bounded price block). A blank fee is not zero — it means "not
 * configured", and the receptionist simply won't quote it.
 *
 * Treatments are ARCHIVED, never deleted (spec §5.4: referenced history). An
 * archived row stays in the document, drops out of the prompt, and hides behind
 * the "Show archived" toggle.
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const ARCHIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';
  const RESTORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';

  const FEE_IDS = ['consultation_fee', 'follow_up_fee', 'emergency_fee'];
  const PAYMENTS = [
    { id: 'upi', label: 'UPI' },
    { id: 'cash', label: 'Cash' },
    { id: 'card', label: 'Card' },
  ];
  // Per-stance copy for the conditional detail field.
  const STANCE_COPY = {
    selected_insurers: {
      label: 'Which insurers?',
      help: 'Your receptionist names these when a patient asks about insurance.',
      placeholder: 'Star Health, HDFC Ergo, Niva Bupa',
    },
    note: {
      label: 'What should your receptionist say?',
      help: 'Your receptionist says this when a patient asks about insurance.',
      placeholder: 'We give you a receipt to claim reimbursement from your insurer.',
    },
  };

  const form = $('pricingForm');
  const treatmentsHost = $('treatments');
  const paysHost = $('pays');
  const stanceEl = $('insuranceStance');
  const noteField = $('insuranceNoteField');
  const noteEl = $('insuranceNote');
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
    $('treatmentsError').textContent = '';
  }

  // Mark a `.field` block (fees, payment, insurance) by its data-field name.
  function markField(name, message) {
    const el = form.querySelector(`.field[data-field="${name}"]`);
    if (!el) return false;
    el.classList.add('is-invalid');
    const err = el.querySelector('.field__error');
    if (err) err.textContent = message;
    const input = el.querySelector('.input');
    if (input) input.classList.add('input--invalid');
    return true;
  }

  // Server field names: fees/payment/insurance map to a `.field`; `treatments`
  // is the whole-list cap; `treatments.<i>.<key>` marks one row (indices map 1:1
  // — we POST every rendered row, archived and blank included).
  function applyErrors(fields) {
    clearErrors();
    const rows = treatmentsHost.querySelectorAll('.tr');
    let firstEl = null;
    for (const f of fields) {
      if (f.field.indexOf('treatments.') === 0) {
        const parts = f.field.split('.');
        const row = rows[Number(parts[1])];
        if (!row) continue;
        row.classList.add('is-invalid');
        const err = row.querySelector('.tr__error');
        if (err) err.textContent = f.message;
        const target = row.querySelector('.tr__' + ({
          name: 'name', price: 'price', duration_minutes: 'dur', notes: 'notes',
        }[parts[2]] || 'name'));
        if (target) target.classList.add('input--invalid');
        // An error on a hidden archived row would be invisible — reveal them.
        if (row.dataset.archived === '1' && !$('showArchived').checked) {
          $('showArchived').checked = true;
          refreshArchived();
        }
        if (!firstEl) firstEl = target || row;
      } else if (f.field === 'treatments') {
        $('treatmentsError').textContent = f.message;
        if (!firstEl) firstEl = $('addTreatment');
      } else if (markField(f.field, f.message) && !firstEl) {
        firstEl = form.querySelector(`.field[data-field="${f.field}"] .input`);
      }
    }
    if (firstEl && firstEl.focus) firstEl.focus();
    if (firstEl && firstEl.scrollIntoView) firstEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ── Treatment rows ───────────────────────────────────────────────────────────
  function addTreatmentRow(t) {
    t = t || { name: '', price: '', price_from: false, duration_minutes: null, notes: '', archived: false };
    const row = document.createElement('div');
    row.className = 'tr' + (t.archived ? ' tr--archived' : '');
    row.dataset.archived = t.archived ? '1' : '0';
    row.innerHTML =
      `<div class="tr__main">
         <input class="input tr__name" type="text" maxlength="120" placeholder="e.g. Root canal" value="${esc(t.name)}" aria-label="Treatment name">
         <div class="money tr__price-wrap">
           <span class="money__sym" aria-hidden="true">₹</span>
           <input class="input money__input tr__price" type="text" inputmode="numeric" autocomplete="off" placeholder="1500" value="${esc(t.price === null || t.price === undefined ? '' : t.price)}" aria-label="Treatment price in rupees">
         </div>
         <div class="tr__dur-wrap">
           <input class="input tr__dur" type="text" inputmode="numeric" autocomplete="off" placeholder="—" value="${esc(t.duration_minutes == null ? '' : t.duration_minutes)}" aria-label="Duration in minutes">
           <span class="tr__dur-unit" aria-hidden="true">min</span>
         </div>
         <button class="tr__archive" type="button"></button>
       </div>
       <div class="tr__extra">
         <span class="tr__tag">Archived</span>
         <label class="chk"><input type="checkbox" class="tr__from"${t.price_from ? ' checked' : ''}><span>Starts at (price varies)</span></label>
         <input class="input tr__notes" type="text" maxlength="300" placeholder="Note (optional)" value="${esc(t.notes)}" aria-label="Treatment note">
       </div>
       <div class="tr__error"></div>`;

    const clearRowError = () => {
      row.classList.remove('is-invalid');
      row.querySelector('.tr__error').textContent = '';
      row.querySelectorAll('.input--invalid').forEach((i) => i.classList.remove('input--invalid'));
    };
    row.querySelectorAll('input').forEach((i) =>
      i.addEventListener('input', () => { clearRowError(); markDirty(); }));
    row.querySelector('.tr__from').addEventListener('change', markDirty);

    // Archive / restore. Archiving never removes the row — it keeps the price in
    // history and drops it out of the receptionist's price list.
    row.querySelector('.tr__archive').addEventListener('click', () => {
      const nowArchived = row.dataset.archived !== '1';
      row.dataset.archived = nowArchived ? '1' : '0';
      row.classList.toggle('tr--archived', nowArchived);
      clearRowError();
      syncArchiveBtn(row);
      refreshArchived();
      markDirty();
    });

    syncArchiveBtn(row);
    treatmentsHost.appendChild(row);
    return row;
  }

  function syncArchiveBtn(row) {
    const archived = row.dataset.archived === '1';
    const btn = row.querySelector('.tr__archive');
    btn.innerHTML = archived ? RESTORE : ARCHIVE;
    btn.setAttribute('aria-label', archived ? 'Restore this treatment' : 'Archive this treatment');
    btn.title = archived ? 'Restore — your receptionist can quote this again' : 'Archive — your receptionist stops quoting this';
  }

  function renderTreatments(list) {
    treatmentsHost.innerHTML = '';
    (list || []).forEach((t) => addTreatmentRow(t));
    refreshArchived();
  }

  // Show/hide archived rows, keep the counter honest, and drive the empty state
  // off VISIBLE rows (an all-archived list still reads as empty to the owner).
  function refreshArchived() {
    const rows = Array.from(treatmentsHost.querySelectorAll('.tr'));
    const archived = rows.filter((r) => r.dataset.archived === '1');
    const show = $('showArchived').checked;
    rows.forEach((r) => r.classList.toggle('tr--hidden', r.dataset.archived === '1' && !show));
    $('archivedCount').textContent = String(archived.length);
    $('showArchivedWrap').hidden = archived.length === 0;
    const visible = rows.length - (show ? 0 : archived.length);
    $('treatmentsEmpty').hidden = visible > 0;
  }

  // ── Payment pills ────────────────────────────────────────────────────────────
  function renderPays(selected) {
    paysHost.innerHTML = PAYMENTS.map((p) => {
      const on = (selected || []).indexOf(p.id) !== -1;
      return `<button class="pay-toggle" type="button" data-method="${p.id}" aria-pressed="${on ? 'true' : 'false'}">
        <span class="pay-toggle__check">${CHECK}</span><span>${esc(p.label)}</span></button>`;
    }).join('');
    paysHost.querySelectorAll('.pay-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        const f = form.querySelector('.field[data-field="payment_methods"]');
        if (f) { f.classList.remove('is-invalid'); f.querySelector('.field__error').textContent = ''; }
        markDirty();
      });
    });
  }

  // ── Insurance ────────────────────────────────────────────────────────────────
  // The detail field appears only for a stance that actually promises detail.
  function syncInsurance() {
    const copy = STANCE_COPY[stanceEl.value];
    noteField.hidden = !copy;
    if (copy) {
      $('insuranceNoteLabel').textContent = copy.label;
      $('insuranceNoteHelp').textContent = copy.help;
      noteEl.placeholder = copy.placeholder;
    }
  }

  // ── Collect / fill ───────────────────────────────────────────────────────────
  // Fees and prices go up as raw strings; '' means "not configured" and the
  // server maps it to null. Every rendered row is POSTed (archived and blank
  // included) so a server error index maps 1:1 to a DOM row.
  function collect() {
    const out = {
      payment_methods: Array.from(paysHost.querySelectorAll('.pay-toggle[aria-pressed="true"]'))
        .map((b) => b.dataset.method),
      insurance: { stance: stanceEl.value, note: noteEl.value.trim() },
      treatments: Array.from(treatmentsHost.querySelectorAll('.tr')).map((row) => ({
        name: row.querySelector('.tr__name').value.trim(),
        price: row.querySelector('.tr__price').value.trim(),
        price_from: row.querySelector('.tr__from').checked,
        duration_minutes: row.querySelector('.tr__dur').value.trim(),
        notes: row.querySelector('.tr__notes').value.trim(),
        archived: row.dataset.archived === '1',
      })),
    };
    FEE_IDS.forEach((id) => { out[id] = $(id).value.trim(); });
    return out;
  }

  function fill(pricing) {
    FEE_IDS.forEach((id) => { $(id).value = pricing[id] == null ? '' : pricing[id]; });
    renderTreatments(pricing.treatments || []);
    renderPays(pricing.payment_methods || []);
    const ins = pricing.insurance || {};
    stanceEl.value = ins.stance || 'not_accepted';
    noteEl.value = ins.note || '';
    syncInsurance();
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
      const res = await fetch('/portal/api/config/pricing', {
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
      const res = await fetch('/portal/api/config/pricing', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      data = await res.json();
    } catch (_) {
      const msg = $('loadMsg');
      msg.textContent = 'We couldn’t load your prices. Refresh the page to try again.';
      msg.className = 'state-msg state-msg--error';
      return;
    }

    fill(data.pricing);
    baseline = JSON.stringify(collect());

    FEE_IDS.forEach((id) => $(id).addEventListener('input', () => {
      const f = form.querySelector(`.field[data-field="${id}"]`);
      if (f) { f.classList.remove('is-invalid'); f.querySelector('.field__error').textContent = ''; }
      $(id).classList.remove('input--invalid');
      markDirty();
    }));
    stanceEl.addEventListener('change', () => { syncInsurance(); markDirty(); });
    noteEl.addEventListener('input', () => {
      const f = form.querySelector('.field[data-field="insurance.note"]');
      if (f) { f.classList.remove('is-invalid'); f.querySelector('.field__error').textContent = ''; }
      noteEl.classList.remove('input--invalid');
      markDirty();
    });
    $('showArchived').addEventListener('change', refreshArchived);
    $('addTreatment').addEventListener('click', () => {
      const row = addTreatmentRow();
      refreshArchived();
      markDirty();
      const n = row.querySelector('.tr__name');
      if (n && n.focus) n.focus();
    });
    form.addEventListener('submit', save);

    $('loadCard').hidden = true;
    form.hidden = false;
    if (data.version) { saveNote.textContent = 'Version ' + data.version; saveNote.className = 'save-note'; }
  }

  main();
})();
