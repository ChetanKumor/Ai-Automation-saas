/* ============================================================================
 * History (PORTAL-P6-S17) — configuration history + restore-as-new-version.
 *
 * GET /api/history            → the timeline list (newest first, capped at 50)
 * GET /api/history/:version   → one version's owner-safe snapshot (S15 reuse)
 * POST /api/history/:version/restore → writes a NEW version copying the old
 *   one (history is never rewritten); requires { confirm: true }.
 *
 * No form, no Save — this page only ever reads, plus the one Restore action,
 * which is itself just another (server-side) write through configService.
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rupee = (n) => '₹' + Number(n).toLocaleString('en-IN');

  const LANG_LABEL = { te: 'Telugu', hi: 'Hindi', en: 'English' };
  const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun', holidays: 'Holidays' };
  const PAYMENT_LABEL = { upi: 'UPI', cash: 'cash', card: 'card' };
  const INSURANCE_LABEL = { not_accepted: 'Not accepted', selected_insurers: 'Selected insurers', note: 'Custom note' };

  function humanizeField(key) {
    return DAY_LABEL[key] || LANG_LABEL[key] || key.replace(/_/g, ' ');
  }

  function formatWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${date}, ${time}`;
  }

  function chip(text) { return `<span class="chip">${esc(text)}</span>`; }
  function emptyCard(text) { return `<p class="know-empty">${esc(text)}</p>`; }

  // ── List ─────────────────────────────────────────────────────────────────────
  function renderRow(r) {
    const fields = (r.fields || []).map(humanizeField);
    return `<button class="hist-row" type="button" data-version="${r.version}">
      <span class="hist-row__version">v${r.version}</span>
      <span class="hist-row__main">
        <span class="hist-row__top">
          <span class="hist-row__summary">${esc(r.summary)}</span>
          ${r.current ? '<span class="badge badge--teal">Current</span>' : ''}
        </span>
        ${fields.length ? `<div class="hist-row__fields">${esc(fields.join(', '))}</div>` : ''}
      </span>
      <span class="hist-row__meta">
        <div class="hist-row__actor">${esc(r.actor)}</div>
        <div>${esc(formatWhen(r.created_at))}</div>
      </span>
    </button>`;
  }

  function renderList(revisions) {
    $('histList').innerHTML = revisions.map(renderRow).join('');
    $('histList').querySelectorAll('.hist-row').forEach((btn) => {
      btn.addEventListener('click', () => openDetail(Number(btn.dataset.version)));
    });
  }

  // ── Version-detail modal body (owner-safe snapshot, S15 reuse) ─────────────
  function renderClinic(s) {
    const rows = [];
    rows.push(`<div class="kv"><span class="kv__k">Name</span><span class="kv__v">${esc(s.name)}</span></div>`);
    rows.push(`<div class="kv"><span class="kv__k">Address</span><span class="kv__v">${s.address ? esc(s.address) + (s.landmark ? ', ' + esc(s.landmark) : '') : '<span class="know-faint">Not added</span>'}</span></div>`);
    rows.push(`<div class="kv"><span class="kv__k">Phone</span><span class="kv__v">${s.phone_numbers.length ? esc(s.phone_numbers.join(', ')) : '<span class="know-faint">Not added</span>'}</span></div>`);
    const langs = s.languages.map((l) => chip(LANG_LABEL[l] || l)).join('');
    rows.push(`<div class="kv"><span class="kv__k">Languages</span><span class="kv__v chip-row">${langs}</span></div>`);
    return rows.join('');
  }

  function renderHours(s) {
    let html = `<p class="know-lead">${esc(s.summary)}</p>`;
    if (s.holidays.length) {
      html += `<ul class="plain-list">${s.holidays.map((h) =>
        `<li>${esc(h.date)}${h.name ? ' — ' + esc(h.name) : ''}</li>`).join('')}</ul>`;
    }
    return html;
  }

  function renderPricing(s) {
    if (s.empty) return emptyCard('No prices were set at this version — the receptionist would have offered to check and call back.');
    const lines = [];
    if (typeof s.fees.consultation_fee === 'number') lines.push(`<li>Consultation — ${rupee(s.fees.consultation_fee)}</li>`);
    if (typeof s.fees.follow_up_fee === 'number') lines.push(`<li>Follow-up visit — ${rupee(s.fees.follow_up_fee)}</li>`);
    if (typeof s.fees.emergency_fee === 'number') lines.push(`<li>Emergency visit — ${rupee(s.fees.emergency_fee)}</li>`);
    for (const t of s.treatments) {
      const amount = t.price_from ? `from ${rupee(t.price)}` : rupee(t.price);
      lines.push(`<li>${esc(t.name)} — ${amount}</li>`);
    }
    let html = `<ul class="plain-list">${lines.join('')}</ul>`;
    if (s.payment_methods.length) {
      html += `<div class="kv"><span class="kv__k">Payment</span><span class="kv__v chip-row">${s.payment_methods.map((m) => chip(PAYMENT_LABEL[m] || m)).join('')}</span></div>`;
    }
    if (s.insurance && s.insurance.stance !== 'not_accepted') {
      html += `<div class="kv"><span class="kv__k">Insurance</span><span class="kv__v">${esc(INSURANCE_LABEL[s.insurance.stance] || s.insurance.stance)}</span></div>`;
    }
    return html;
  }

  function renderBooking(s) {
    let html = `<p class="know-lead">${esc(s.summary)}</p>`;
    if (s.empty) {
      html += emptyCard('No cancellation, rescheduling, or walk-in policy was written at this version.');
    } else {
      const lines = [];
      if (s.policies.cancellation_policy) lines.push(`<li>Cancellations — ${esc(s.policies.cancellation_policy)}</li>`);
      if (s.policies.reschedule_policy) lines.push(`<li>Rescheduling — ${esc(s.policies.reschedule_policy)}</li>`);
      if (s.policies.walk_in_policy) lines.push(`<li>Walk-ins — ${esc(s.policies.walk_in_policy)}</li>`);
      html += `<ul class="plain-list">${lines.join('')}</ul>`;
    }
    return html;
  }

  function renderReceptionist(s) {
    const rows = [];
    rows.push(`<div class="kv"><span class="kv__k">Introduces itself as</span><span class="kv__v">${s.display_name ? esc(s.display_name) : '<span class="know-faint">No name</span>'}</span></div>`);
    rows.push(`<div class="kv"><span class="kv__k">Tone</span><span class="kv__v">${s.tone === 'professional' ? 'Professional' : 'Warm'}</span></div>`);
    let html = rows.join('');
    html += s.languages.map((l) => `<div class="greet-row"><span class="greet-row__lang">${esc(LANG_LABEL[l] || l)}${l === s.default_language ? ' <span class="know-faint">(default)</span>' : ''}</span>
      <p class="greet-row__text ${l === 'te' ? 'lang-te' : l === 'hi' ? 'lang-hi' : ''}">${esc(s.greeting[l] || '')}</p></div>`).join('');
    return html;
  }

  function renderSafety(s) {
    let html = '';
    if (s.empty) {
      html += emptyCard('No clinic-specific emergency guidance or number was on file at this version.');
    } else {
      if (s.guidance) html += `<div class="kv"><span class="kv__k">Clinic guidance</span><span class="kv__v">${esc(s.guidance)}</span></div>`;
      if (s.emergency_number) html += `<div class="kv"><span class="kv__k">Number given out</span><span class="kv__v">${esc(s.emergency_number)}</span></div>`;
    }
    if (s.staff_numbers.length) {
      html += `<p class="know-lead" style="margin-top:8px">Staff numbers: ${esc(s.staff_numbers.join(', '))}</p>`;
    }
    return html;
  }

  function section(title, bodyHtml) {
    return `<div class="hist-detail-section"><div class="hist-detail-section__title">${esc(title)}</div>${bodyHtml}</div>`;
  }

  let openVersion = null;

  async function openDetail(version) {
    try {
      const res = await fetch(`/portal/api/history/${version}`, { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      const data = await res.json();
      openVersion = data.version;

      $('detailTitle').textContent = `Version ${data.version}`;
      $('detailSub').textContent = `${data.actor} · ${formatWhen(data.created_at)}`;

      const s = data.sections;
      let body = data.is_current
        ? '<p class="hist-current-note">This is your current, live version.</p>' : '';
      body += section('Your clinic', renderClinic(s.clinic));
      body += section('When you’re open', renderHours(s.hours));
      body += section('What you charge', renderPricing(s.pricing));
      body += section('Booking rules', renderBooking(s.booking));
      body += section('How it introduces itself', renderReceptionist(s.receptionist));
      body += section('In an emergency', renderSafety(s.safety));
      $('detailBody').innerHTML = body;

      $('restoreBtn').hidden = !!data.is_current;
      openModal('detailModal');
    } catch (_) {
      toast('Couldn’t load this version. Try again.', false);
    }
  }

  // ── Restore ──────────────────────────────────────────────────────────────────
  async function doRestore() {
    if (openVersion == null) return;
    const btn = $('confirmRestoreBtn');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Restoring…';
    try {
      const res = await fetch(`/portal/api/history/${openVersion}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast((data && data.error) || 'Couldn’t restore this version.', false);
        return;
      }
      closeModal('confirmModal');
      closeModal('detailModal');
      toast(`Restored · now v${data.version}`, true);
      await load();
    } catch (_) {
      toast('Couldn’t restore this version. Try again.', false);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ── Modals ───────────────────────────────────────────────────────────────────
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  document.addEventListener('click', (e) => {
    const closeTarget = e.target.closest('[data-close]');
    if (closeTarget) closeModal(closeTarget.dataset.close === 'detail' ? 'detailModal' : 'confirmModal');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('confirmModal').hidden) closeModal('confirmModal');
    else if (!$('detailModal').hidden) closeModal('detailModal');
  });
  $('restoreBtn').addEventListener('click', () => {
    $('confirmSub').textContent = `This creates a new version using v${openVersion}’s settings.`;
    openModal('confirmModal');
  });
  $('confirmRestoreBtn').addEventListener('click', doRestore);

  // ── Toast ────────────────────────────────────────────────────────────────────
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
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

  // ── Load ─────────────────────────────────────────────────────────────────────
  async function load() {
    try {
      const res = await fetch('/portal/api/history', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      const data = await res.json();

      $('loadCard').hidden = true;
      if (!data.revisions.length) {
        $('emptyCard').hidden = false;
        $('listCard').hidden = true;
        $('truncatedNote').hidden = true;
        return;
      }
      $('emptyCard').hidden = true;
      $('listCard').hidden = false;
      renderList(data.revisions);
      $('truncatedNote').hidden = !data.truncated;
    } catch (_) {
      const msg = $('loadMsg');
      msg.textContent = 'We couldn’t load your history. Refresh the page to try again.';
      msg.className = 'state-msg state-msg--error';
    }
  }

  async function main() {
    try { await window.Portal.me; } catch (_) { return; } // shell redirected to login
    await load();
  }

  main();
})();
