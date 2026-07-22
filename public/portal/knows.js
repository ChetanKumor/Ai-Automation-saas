/* ============================================================================
 * What it knows (PORTAL-P5-S15) — read-only reflection of the assembled
 * knowledge, fetched whole from GET /portal/api/knowledge-summary.
 *
 * No form, no Save, no writes anywhere on this page. Every card either shows
 * real saved data or an honest fallback sentence ("hasn't been added yet /
 * receptionist offers to check") — never a blank card and never a claim the
 * config doesn't back. The server route is the single source of what counts as
 * "empty"; this file only renders whatever it says.
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rupee = (n) => '₹' + Number(n).toLocaleString('en-IN');

  const LANG_LABEL = {
    te: { label: 'Telugu', font: 'lang-te' },
    hi: { label: 'Hindi', font: 'lang-hi' },
    en: { label: 'English', font: '' },
  };
  const PAYMENT_LABEL = { upi: 'UPI', cash: 'cash', card: 'card' };
  const INSURANCE_LABEL = { not_accepted: 'Not accepted', selected_insurers: 'Selected insurers', note: 'Custom note' };

  function emptyCard(text) {
    return `<p class="know-empty">${esc(text)}</p>`;
  }
  function chip(text) {
    return `<span class="chip">${esc(text)}</span>`;
  }

  // ── Section renderers — each takes its slice of the payload, returns HTML ──
  function renderClinic(s) {
    const rows = [];
    rows.push(`<div class="kv"><span class="kv__k">Name</span><span class="kv__v">${esc(s.name)}</span></div>`);
    rows.push(`<div class="kv"><span class="kv__k">Address</span><span class="kv__v">${s.address ? esc(s.address) + (s.landmark ? ', ' + esc(s.landmark) : '') : '<span class="know-faint">Not added yet</span>'}</span></div>`);
    rows.push(`<div class="kv"><span class="kv__k">Phone</span><span class="kv__v">${s.phone_numbers.length ? esc(s.phone_numbers.join(', ')) : '<span class="know-faint">Not added yet</span>'}</span></div>`);
    const langs = s.languages.map((l) => chip((LANG_LABEL[l] || { label: l }).label)).join('');
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
    if (s.empty) return emptyCard(s.fallback);
    const lines = [];
    if (typeof s.fees.consultation_fee === 'number') lines.push(`<li>Consultation — ${rupee(s.fees.consultation_fee)}</li>`);
    if (typeof s.fees.follow_up_fee === 'number') lines.push(`<li>Follow-up visit — ${rupee(s.fees.follow_up_fee)}</li>`);
    if (typeof s.fees.emergency_fee === 'number') lines.push(`<li>Emergency visit — ${rupee(s.fees.emergency_fee)}</li>`);
    for (const t of s.treatments) {
      const amount = t.price_from ? `from ${rupee(t.price)}` : rupee(t.price);
      const extra = [];
      if (t.duration_minutes) extra.push(`~${t.duration_minutes} min`);
      if (t.notes) extra.push(esc(t.notes));
      lines.push(`<li>${esc(t.name)} — ${amount}${extra.length ? ` (${extra.join('; ')})` : ''}</li>`);
    }
    let html = `<ul class="plain-list">${lines.join('')}</ul>`;
    if (s.payment_methods.length) {
      html += `<div class="kv"><span class="kv__k">Payment</span><span class="kv__v chip-row">${s.payment_methods.map((m) => chip(PAYMENT_LABEL[m] || m)).join('')}</span></div>`;
    }
    if (s.insurance && s.insurance.stance !== 'not_accepted') {
      html += `<div class="kv"><span class="kv__k">Insurance</span><span class="kv__v">${esc(INSURANCE_LABEL[s.insurance.stance] || s.insurance.stance)}${s.insurance.note ? ' — ' + esc(s.insurance.note) : ''}</span></div>`;
    }
    return html;
  }

  function renderDoctors(s) {
    if (s.empty) return emptyCard(s.fallback);
    return `<ul class="plain-list">${s.doctors.map((d) =>
      `<li><strong>${esc(d.name)}</strong>${d.specialization ? ' — ' + esc(d.specialization) : ''}<br>
       <span class="know-faint">${esc(d.days.join(', '))} · ${esc(d.start)}–${esc(d.end)}</span></li>`).join('')}</ul>`;
  }

  function renderBooking(s) {
    let html = `<p class="know-lead">${esc(s.summary)}</p>`;
    if (s.empty) {
      html += emptyCard(s.fallback);
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
    rows.push(`<div class="kv"><span class="kv__k">Introduces itself as</span><span class="kv__v">${s.display_name ? esc(s.display_name) : '<span class="know-faint">No name — introduces itself as your clinic’s receptionist</span>'}</span></div>`);
    rows.push(`<div class="kv"><span class="kv__k">Tone</span><span class="kv__v">${s.tone === 'professional' ? 'Professional' : 'Warm'}</span></div>`);
    let html = rows.join('');
    html += '<div class="know-subhead">Greeting</div>';
    html += s.languages.map((l) => {
      const meta = LANG_LABEL[l] || { label: l, font: '' };
      return `<div class="greet-row"><span class="greet-row__lang">${esc(meta.label)}${l === s.default_language ? ' <span class="know-faint">(default)</span>' : ''}</span>
        <p class="greet-row__text ${meta.font}">${esc(s.greeting[l] || '')}</p></div>`;
    }).join('');
    return html;
  }

  function renderFaqs(s) {
    if (s.empty) return emptyCard(s.fallback);
    return `<p class="know-lead">${s.count} FAQ${s.count === 1 ? '' : 's'} on file</p>
      <ul class="plain-list faq-list">${s.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>`;
  }

  function renderSafety(s) {
    let html = '';
    if (s.empty) {
      html += emptyCard(s.fallback);
    } else {
      if (s.guidance) html += `<div class="kv"><span class="kv__k">Clinic guidance</span><span class="kv__v">${esc(s.guidance)}</span></div>`;
      if (s.emergency_number) html += `<div class="kv"><span class="kv__k">Number given out</span><span class="kv__v">${esc(s.emergency_number)}</span></div>`;
    }
    html += `<p class="know-lead" style="margin-top:12px">${s.handoff_enabled
      ? 'If it can’t help, or a patient asks for a human, it offers a callback from clinic staff.'
      : 'It does not currently offer a callback from clinic staff — it keeps trying to help on its own.'}</p>`;
    if (s.staff_numbers.length) {
      html += `<p class="know-faint">Staff numbers on file: ${esc(s.staff_numbers.join(', '))}. Nothing rings these automatically — a team member follows up manually.</p>`;
    }
    return html;
  }

  function renderProtections(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    const shield = (window.Portal && window.Portal.icons && window.Portal.icons.shield) || '';
    $('protList').innerHTML = list.map((p) => `
      <li class="prot__item">
        <span class="prot__icon" aria-hidden="true">${shield}</span>
        <div class="prot__body">
          <div class="prot__title">${esc(p.title)}</div>
          <p class="prot__detail">${esc(p.detail)}</p>
          ${(p.instructions || []).map((t) => `<p class="prot__quote">${esc(t)}</p>`).join('')}
        </div>
      </li>`).join('');
  }

  function render(data) {
    $('metaLine').textContent = `Last updated · config v${data.version}`;
    $('metaLine').hidden = false;

    const s = data.sections;
    $('body-clinic').innerHTML = renderClinic(s.clinic);
    $('body-hours').innerHTML = renderHours(s.hours);
    $('body-pricing').innerHTML = renderPricing(s.pricing);
    $('body-doctors').innerHTML = renderDoctors(s.doctors);
    $('body-booking').innerHTML = renderBooking(s.booking);
    $('body-receptionist').innerHTML = renderReceptionist(s.receptionist);
    $('body-faqs').innerHTML = renderFaqs(s.faqs);
    $('body-safety').innerHTML = renderSafety(s.safety);
    renderProtections(s.protections.protections);

    $('loadCard').hidden = true;
    $('sections').hidden = false;
  }

  async function main() {
    try { await window.Portal.me; } catch (_) { return; } // shell redirected to login
    try {
      const res = await fetch('/portal/api/knowledge-summary', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      render(await res.json());
    } catch (_) {
      const msg = $('loadMsg');
      msg.textContent = 'We couldn’t load what your receptionist knows. Refresh the page to try again.';
      msg.className = 'state-msg state-msg--error';
    }
  }

  main();
})();
