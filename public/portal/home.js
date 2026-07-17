/* ============================================================================
 * Home / Readiness (PORTAL-P1-S2) — read-only.
 *
 * Reads GET /portal/api/readiness (latest validation run + lifecycle status for
 * the session's tenant, INV-1) and renders:
 *   • the status banner (Draft / Validated / Live / Paused + its meaning),
 *   • the readiness RING (material checks passed / material total — the signature
 *     element), and
 *   • per-check rows using the friendly copy map (spec §5.1). The owner never
 *     sees the raw catalog wording or check `detail` — that stays in the admin
 *     panel; here every check is translated to what the owner recognises.
 *
 * Nothing here triggers a validation run or writes anything (read-only session).
 * ========================================================================== */
'use strict';

(function () {
  const I = (window.Portal && window.Portal.icons) || {};
  const IC = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 16h.01"/></svg>',
    op:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── Friendly copy map (spec §5.1) ──────────────────────────────────────────
  // For every validation check name: an owner-recognisable label, who acts on it,
  // whether it counts toward the readiness score (material), and — for owner items
  // that fail — the one-line fix + the page that resolves it.
  //   actor:    'owner'  → the owner fixes it, on a portal page
  //             'system' → derived from the owner's saved settings (no direct link)
  //             'operator' → Prantivo handles it (owner-visible, not owner-actioned)
  //   material: true  → counts toward the ring (a go-live gate)
  //             false → advisory: shown subordinate, never scored
  const META = {
    'config.exists':   { label: 'Clinic details saved', actor: 'system', material: true },
    'config.schema':   { label: 'Clinic details are valid', actor: 'system', material: true },
    'prompt.renders':  { label: 'Receptionist instructions are ready', actor: 'system', material: true },
    'hours.sane':      { label: 'Clinic hours are set', actor: 'owner', material: true,
                         fix: 'Set your opening hours for each day', link: 'Hours & holidays' },
    'numbers.e164':    { label: 'Escalation phone number added', actor: 'owner', material: true,
                         fix: 'Add an escalation phone number', link: 'Safety & handoff' },
    'consent.lines':   { label: 'Call recording notice', actor: 'system', material: true },
    'kb.populated':    { label: 'Knowledge added', actor: 'owner', material: true,
                         fix: 'Add at least 5 FAQs or upload one document', link: 'FAQs' },
    'kb.retrieval':    { label: 'Knowledge is searchable', actor: 'owner', material: true,
                         fix: 'Add at least 5 FAQs or upload one document', link: 'FAQs' },
    'doctor.schedule': { label: 'Doctor and weekly hours added', actor: 'owner', material: true,
                         fix: 'Add a doctor and their weekly hours', link: 'Doctors' },
    'whatsapp.config': { label: 'WhatsApp connection', actor: 'operator', material: true,
                         note: 'Handled by Prantivo during onboarding' },
    'whatsapp.live':   { label: 'WhatsApp connection verified', actor: 'operator', material: true,
                         note: 'Handled by Prantivo during onboarding' },
    'voice.config':    { label: 'Voice line configured', actor: 'operator', material: true,
                         note: 'Handled by Prantivo during onboarding' },
    'turn.scripted':   { label: 'Test call', actor: 'operator', material: true,
                         note: 'Run by Prantivo before go-live' },
    'tenant.legacy_prompt': { label: 'Using the latest instruction format', actor: 'system', material: false },
  };
  // Unknown/future check → a safe, honest default (prettified name, material system).
  const metaFor = (name) => META[name] || {
    label: name.replace(/[._]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
    actor: 'system', material: true,
  };

  const BANNER = {
    draft:     { label: 'Draft', meaning: 'Your receptionist isn’t live yet. Finish the setup below, then go live.' },
    validated: { label: 'Validated', meaning: 'Setup checks passed. You’re ready to go live.' },
    live:      { label: 'Live', meaning: 'Your receptionist is answering calls and messages.' },
    paused:    { label: 'Paused', meaning: 'Your receptionist is paused — calls and messages aren’t being answered.' },
  };

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let h = d.getHours();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${h}:${min} ${ap}`;
  }

  // ── Renderers ──────────────────────────────────────────────────────────────

  function renderBanner(status) {
    const b = BANNER[status] || BANNER.draft;
    document.getElementById('banner').innerHTML =
      `<div class="banner banner--${esc(status)}">
        <span class="banner__dot"></span>
        <div class="banner__body">
          <div class="banner__label">${esc(b.label)}</div>
          <div class="banner__meaning">${esc(b.meaning)}</div>
        </div>
      </div>`;
  }

  // Ring: material checks that RAN. numerator = not-failed; denominator = ran.
  // Advisory + skipped checks are excluded (a skipped check made no claim).
  function computeScore(checks) {
    let passed = 0, total = 0;
    for (const c of checks) {
      const m = metaFor(c.name);
      if (!m.material) continue;
      total += 1;
      if (c.severity !== 'fail') passed += 1;
    }
    return { passed, total };
  }

  function ringSvg(passed, total) {
    const R = 68, C = 2 * Math.PI * R;
    const frac = total > 0 ? passed / total : 0;
    const offset = C * (1 - frac);
    const complete = total > 0 && passed === total;
    return `<div class="ring${complete ? ' ring--complete' : ''}">
      <svg viewBox="0 0 160 160" aria-hidden="true">
        <circle class="ring__track" cx="80" cy="80" r="${R}"></circle>
        <circle class="ring__fill" cx="80" cy="80" r="${R}"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
      </svg>
      <div class="ring__center">
        <div class="ring__num">${passed}</div>
        <div class="ring__den">of ${total} ready</div>
      </div>
    </div>`;
  }

  function renderReadiness(run) {
    const card = document.getElementById('readinessCard');
    const { passed, total } = computeScore(run.checks);
    const complete = total > 0 && passed === total;

    // Any owner-actionable material check still failing?
    const ownerTodo = run.checks.some((c) => {
      const m = metaFor(c.name);
      return m.material && m.actor === 'owner' && c.severity === 'fail';
    });

    let headline, note;
    if (complete) {
      headline = 'All setup checks are ready';
      note = 'Every check that gates go-live has passed.';
    } else {
      headline = `${passed} of ${total} setup checks ready`;
      note = ownerTodo
        ? 'Complete the highlighted items below, then your receptionist can go live.'
        : 'The remaining items are handled by Prantivo before go-live.';
    }

    card.innerHTML =
      `<div class="readiness">
        ${ringSvg(passed, total)}
        <div class="readiness__summary">
          <div class="readiness__headline">${esc(headline)}</div>
          <div class="readiness__note">${esc(note)}</div>
          <div class="readiness__ran">Last checked ${esc(fmtDate(run.created_at))}</div>
        </div>
      </div>`;

    renderChecks(run);
  }

  // Row state → { cls, icon, badge, badgeCls }
  function rowState(c, m) {
    const failed = c.severity === 'fail';
    if (m.actor === 'operator') {
      return { icon: IC.op, iconCls: 'op', badge: 'Operator-run', badgeCls: 'muted' };
    }
    if (!failed) {
      return { icon: IC.check, iconCls: 'pass', badge: 'Ready', badgeCls: 'ok' };
    }
    return { icon: IC.alert, iconCls: 'fail', badge: 'Action needed', badgeCls: 'warn' };
  }

  function checkRow(c) {
    const m = metaFor(c.name);
    const st = rowState(c, m);
    const advisory = !m.material;

    // Sub-line: for a failing owner item show the fix; for operator items the note.
    let sub = '';
    if (advisory) {
      sub = c.severity === 'warn'
        ? '<div class="check__fix">An older instruction format is in use — Prantivo can refresh it.</div>' : '';
    } else if (m.actor === 'owner' && c.severity === 'fail' && m.fix) {
      sub = `<div class="check__fix">${esc(m.fix)}</div>`;
    } else if (m.actor === 'operator' && m.note) {
      sub = `<div class="check__fix">${esc(m.note)}</div>`;
    }

    // Link chip → the page that fixes it. Pages are unbuilt this session, so the
    // chip is a quiet, non-navigating reference (matches the disabled sidebar).
    const link = (m.actor === 'owner' && c.severity === 'fail' && m.link)
      ? `<span class="check__link" title="Coming soon">${esc(m.link)}${IC.arrow}</span>` : '';

    const badge = advisory ? '' :
      `<span class="badge badge--${st.badgeCls}">${st.badge}</span>`;

    return `<div class="check${advisory ? ' check--advisory' : ''}">
      <span class="check__icon check__icon--${st.iconCls}">${st.icon}</span>
      <div class="check__body">
        <div class="check__label">${esc(m.label)}</div>
        ${sub}
      </div>
      <div class="check__state">${link}${badge}</div>
    </div>`;
  }

  function renderChecks(run) {
    const host = document.getElementById('checks');
    const ran = new Map(run.checks.map((c) => [c.name, c]));

    // Material rows in catalog order (the order the run recorded them).
    const material = run.checks.filter((c) => metaFor(c.name).material);

    // Operator checks that were SKIPPED still appear (owner should know they exist
    // and that Prantivo owns them — §5.1). Skipped owner/system checks are omitted:
    // they're prerequisite noise the config rows already explain.
    const skippedOps = (run.skipped || [])
      .filter((s) => metaFor(s.name).actor === 'operator' && !ran.has(s.name))
      .map((s) => ({ name: s.name, severity: 'skipped' }));

    const advisory = run.checks.filter((c) => !metaFor(c.name).material);

    let html = '<div class="checks">';
    html += '<p class="checks__group-label">Setup checks</p>';
    html += material.concat(skippedOps).map(checkRow).join('');
    if (advisory.length) {
      html += '<p class="checks__group-label checks__advisory-label">Advisory</p>';
      html += advisory.map(checkRow).join('');
    }
    html += '</div>';
    host.innerHTML = html;
  }

  function renderEmpty() {
    document.getElementById('readinessCard').innerHTML =
      `<div class="empty">
        <div class="empty__mark">${IC.spark}</div>
        <div class="empty__title">No readiness check has run yet</div>
        <div class="empty__body">Once your clinic’s details are in, Prantivo runs the first
          readiness check before your receptionist goes live. Start by adding your clinic profile.</div>
      </div>`;
  }

  function renderError() {
    document.getElementById('readinessCard').innerHTML =
      `<div class="state-msg">We couldn’t load your readiness just now. Refresh the page to try again.</div>`;
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function main() {
    try {
      await window.Portal.me; // session guard already ran in the shell
    } catch (_) {
      return; // shell redirected to login
    }
    let data;
    try {
      const res = await fetch('/portal/api/readiness', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('readiness ' + res.status);
      data = await res.json();
    } catch (_) {
      renderError();
      return;
    }

    window.Portal.renderLifecycle(data.status);
    renderBanner(data.status);
    if (!data.run) { renderEmpty(); return; }
    renderReadiness(data.run);
  }

  main();
})();
