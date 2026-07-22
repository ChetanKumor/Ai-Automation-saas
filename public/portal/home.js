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
  // Moved to shell.js in PORTAL-P6-S18 and read through here. It used to live on
  // this page, with a parallel actor/material table in the shell for the header
  // control — two copies of the same classification, free to drift. It now has
  // one home, because the blocked-go-live dialog needs the same copy on every
  // page, not just this one. Signature unchanged, so PortalHome.metaFor (the
  // wizard's Review step) is untouched.
  const metaFor = (name) => window.Portal.checkMeta(name);

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

  // `opts.bannerEl` lets a caller render into a different element (the
  // onboarding wizard's Review step, PORTAL-P6-S16 — see window.PortalHome
  // below); defaults to this page's own #banner, so the call from main() below
  // is byte-identical to before this option existed.
  function renderBanner(status, opts) {
    const b = BANNER[status] || BANNER.draft;
    const el = (opts && opts.bannerEl) || document.getElementById('banner');
    el.innerHTML =
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

  // `opts.cardEl`/`opts.checksEl` let a caller render into different elements
  // (the onboarding wizard's Review step — see window.PortalHome below);
  // `opts.stepFor` is threaded through to checkRow (see there). Both default to
  // this page's own containers with no override, so main()'s call below is
  // byte-identical to before these options existed.
  function renderReadiness(run, opts) {
    const card = (opts && opts.cardEl) || document.getElementById('readinessCard');
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

    const checksEl = (opts && opts.checksEl) || document.getElementById('checks');
    checksEl.innerHTML = renderChecks(run, opts);
  }

  // Row state → { cls, icon, badge, badgeCls }
  function rowState(c, m) {
    const failed = c.severity === 'fail';
    // A check the run SKIPPED never made a claim, and for an operator check the
    // reason is always that the channel is switched off for this clinic (the
    // catalog's own gate). Saying "Operator-run" there would imply Prantivo has
    // something outstanding to do — so a skipped row says what's actually true:
    // it isn't part of this setup (PORTAL-P6-S18).
    if (c.severity === 'skipped') {
      return { icon: IC.op, iconCls: 'op', badge: 'Not in use', badgeCls: 'muted', skipped: true };
    }
    if (m.actor === 'operator') {
      return { icon: IC.op, iconCls: 'op', badge: 'Operator-run', badgeCls: 'muted' };
    }
    if (!failed) {
      return { icon: IC.check, iconCls: 'pass', badge: 'Ready', badgeCls: 'ok' };
    }
    return { icon: IC.alert, iconCls: 'fail', badge: 'Action needed', badgeCls: 'warn' };
  }

  // `opts.stepFor(meta)` lets a caller redirect a check's fix-link to a wizard
  // step instead of the standalone page it normally points at (the onboarding
  // wizard's Review step — see window.PortalHome below): return a step index
  // and the row renders a same-page `data-goto-step` link the wizard binds
  // itself, instead of a real `href` navigation. Returns null/undefined (the
  // default — no opts passed) for the ordinary standalone-page href, so this
  // page's own rendering is unchanged.
  function checkRow(c, opts) {
    const m = metaFor(c.name);
    const st = rowState(c, m);
    const advisory = !m.material;

    // Sub-line: for a failing owner item show the fix; for operator items the note.
    let sub = '';
    if (advisory) {
      sub = c.severity === 'warn'
        ? '<div class="check__fix">An older instruction format is in use — Prantivo can refresh it.</div>' : '';
    } else if (st.skipped) {
      sub = '<div class="check__fix">Not part of your current setup.</div>';
    } else if (m.actor === 'owner' && c.severity === 'fail' && m.fix) {
      sub = `<div class="check__fix">${esc(m.fix)}</div>`;
    } else if (m.actor === 'operator' && m.note) {
      sub = `<div class="check__fix">${esc(m.note)}</div>`;
    }

    // Link chip → the page (or wizard step) that fixes it. Every owner-actionable
    // check in CHECK_META now has a built page, so the old non-navigating
    // "Coming soon" fallback was unreachable and is gone (PORTAL-P6-S18): a v1
    // portal has no dead links, and an owner told to fix something is always
    // given somewhere to fix it.
    const step = (opts && opts.stepFor) ? opts.stepFor(m) : null;
    const link = (m.actor === 'owner' && c.severity === 'fail' && m.link && m.href)
      ? (step != null
          ? `<a class="check__link" href="#" data-goto-step="${step}">${esc(m.link)}${IC.arrow}</a>`
          : `<a class="check__link" href="${esc(m.href)}">${esc(m.link)}${IC.arrow}</a>`)
      : '';

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

  // Returns the checks HTML (previously wrote directly to #checks — now
  // returned so a caller can target a different container, e.g. the wizard's
  // Review step). `opts` is threaded straight through to checkRow.
  function renderChecks(run, opts) {
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
    html += material.concat(skippedOps).map((c) => checkRow(c, opts)).join('');
    if (advisory.length) {
      html += '<p class="checks__group-label checks__advisory-label">Advisory</p>';
      html += advisory.map((c) => checkRow(c, opts)).join('');
    }
    html += '</div>';
    return html;
  }

  function renderEmpty(opts) {
    const el = (opts && opts.cardEl) || document.getElementById('readinessCard');
    el.innerHTML =
      `<div class="empty">
        <div class="empty__mark">${IC.spark}</div>
        <div class="empty__title">No readiness check has run yet</div>
        <div class="empty__body">Fill in your clinic’s details, then press <strong>Go live</strong> —
          that runs the readiness check and tells you what’s still missing.</div>
      </div>`;
  }

  function renderError(opts) {
    const el = (opts && opts.cardEl) || document.getElementById('readinessCard');
    el.innerHTML =
      `<div class="state-msg">We couldn’t load your readiness just now. Refresh the page to try again.</div>`;
  }

  // Onboarding entry point (PORTAL-P6-S16, spec §6 + Deliverable 6). Three
  // states, from `me.onboarding` (carried on /api/me):
  //   • never started (step === null, !completed) → redirect straight into the
  //     wizard; a first-login owner should never land on an empty readiness
  //     page with no idea where to begin.
  //   • exited early (step set, !completed) → stay on Home, but show a quiet
  //     "Continue setting up" entry point (they left on purpose — don't
  //     re-trap them in the wizard).
  //   • completed → stay on Home, no banner.
  function renderOnboardingBanner(onboarding) {
    const host = document.getElementById('onboardingBanner');
    if (!host) return;
    if (!onboarding || onboarding.completed) { host.innerHTML = ''; return; }
    const resuming = onboarding.step != null;
    host.innerHTML =
      `<div class="setup-cta">
        <div class="setup-cta__body">
          <div class="setup-cta__title">${resuming ? 'Finish setting up your receptionist' : 'Set up your receptionist'}</div>
          <div class="setup-cta__sub">${resuming
            ? 'Pick up right where you left off — it only takes a few minutes.'
            : 'A short guided setup walks you through everything your receptionist needs.'}</div>
        </div>
        <a class="btn btn--primary" href="wizard.html">${resuming ? 'Continue setup' : 'Start setup'}</a>
      </div>`;
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function main() {
    let me;
    try {
      me = await window.Portal.me; // session guard already ran in the shell
    } catch (_) {
      return; // shell redirected to login
    }

    // A first-login owner (never touched the wizard) lands in it directly —
    // everything below this line is for an owner who has at least started.
    if (me.onboarding && me.onboarding.step == null && !me.onboarding.completed) {
      window.location.replace('wizard.html');
      return;
    }
    renderOnboardingBanner(me.onboarding);

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

    render(data);

    // A go-live / pause / resume fired from the header control re-renders the
    // whole page state from the action's OWN response (PORTAL-P6-S18) — the
    // banner and ring must not keep claiming "Draft" after the owner just went
    // live. The shell owns the control and the request; Home just re-renders.
    document.addEventListener('portal:lifecycle', (e) => {
      const r = e.detail && e.detail.readiness;
      if (r) render({ status: e.detail.status || r.status, run: r.run });
    });
  }

  // One render pass over a readiness payload — used on load and after every
  // lifecycle action, so both paths can never diverge.
  function render(data) {
    window.Portal.renderLifecycle(data.status, window.Portal.deriveGoLive(data.run));
    renderBanner(data.status);
    if (!data.run) { renderEmpty(); return; }
    renderReadiness(data.run);
  }

  // Boot ONLY on the real Home page. The onboarding wizard (PORTAL-P6-S16)
  // loads this file solely for window.PortalHome below (its Review step reuses
  // the ring/check rendering) and has none of #banner/#readinessCard/#checks —
  // running main() there would be a guaranteed, pointless null-element error.
  if (document.body.getAttribute('data-page') === 'home') main();

  // Exported for reuse by the onboarding wizard's Review step (PORTAL-P6-S16) —
  // the exact same ring/check-row rendering, never a second implementation.
  // Every function here is pure (data + DOM targets in, no hidden state) and
  // every option defaults to this page's own behavior, so nothing above changes.
  window.PortalHome = {
    metaFor, computeScore, ringSvg, renderBanner, renderReadiness, renderChecks,
    checkRow, renderEmpty, renderError, fmtDate,
  };
})();
