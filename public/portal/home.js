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
    // The `Handled by Prantivo` group's badge. A lock is the honest glyph for a
    // check the owner can see and cannot action (spec §2.9 badge list).
    lock:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    plug:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0Z"/><path d="M12 17v5"/></svg>',
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
  // `severity` is optional and only affects checks whose LABEL depends on the
  // verdict (F-F001's tenant.legacy_prompt). Callers reading actor/material
  // keep passing the name alone.
  const metaFor = (name, severity) => window.Portal.checkMeta(name, severity);

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

  // ── The readiness ring (spec §3.2) ─────────────────────────────────────────
  // 132px, 10px stroke, --line-2 track, --teal-700 progress, round cap; green
  // with a check at 100%. The product's ONE bold element and its only
  // orchestrated moment, spent here because Home is the screen an owner opens
  // every day.
  //
  // Accessibility is the reason this is two nodes and not one. `.ring` is
  // role="img" with the whole sentence as its label — which makes its subtree
  // presentational, so the numeral inside it can never itself be a live region.
  // The spec asks for both a labelled image AND a score that announces after a
  // save, so the live region is a visually-hidden sibling carrying the same
  // sentence. Screen readers therefore read the ring once on arrival and once
  // per change, never twice for the same event.
  const RING_R = 61;
  const RING_C = 2 * Math.PI * RING_R;

  function ringSvg(passed, total) {
    const frac = total > 0 ? passed / total : 0;
    const offset = RING_C * (1 - frac);
    const complete = total > 0 && passed === total;
    const label = `${passed} of ${total} checks complete`;
    return `<div class="ring${complete ? ' ring--complete' : ''}" role="img" aria-label="${esc(label)}">
      <svg viewBox="0 0 132 132">
        <circle class="ring__track" cx="66" cy="66" r="${RING_R}"></circle>
        <circle class="ring__fill" cx="66" cy="66" r="${RING_R}"
          stroke-dasharray="${RING_C.toFixed(1)}"
          stroke-dashoffset="${offset.toFixed(1)}" data-offset="${offset.toFixed(1)}"></circle>
      </svg>
      <div class="ring__center" aria-hidden="true">
        ${complete
          ? `<div class="ring__done">${IC.check}</div>`
          : `<div class="ring__num">${passed}</div><div class="ring__den">of ${total}</div>`}
      </div>
    </div>
    <p class="vh" role="status">${esc(label)}</p>`;
  }

  // Draws 0 → value over --dur-4, ONCE per session. A ring that re-animates on
  // every visit stops being a moment and becomes a delay; sessionStorage is
  // what makes it the former. Under reduced motion it is never started at all,
  // so the markup's final offset simply stands — the ring is correct before
  // this function runs, and this only ever adds the transition.
  const RING_DRAWN = 'portal.ring.drawn';
  function animateRing(root) {
    const fill = (root || document).querySelector('.ring__fill');
    if (!fill) return;
    let seen = false;
    try { seen = sessionStorage.getItem(RING_DRAWN) === '1'; } catch (_) { seen = true; }
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (seen || reduced) return;
    try { sessionStorage.setItem(RING_DRAWN, '1'); } catch (_) { /* private mode — draw anyway */ }

    const target = fill.getAttribute('data-offset');
    fill.style.transition = 'none';
    fill.setAttribute('stroke-dashoffset', RING_C.toFixed(1)); // empty
    // Two frames: one for the empty state to be painted, one for the transition
    // to have something to interpolate from. A single rAF collapses both writes
    // into one style recalculation and the ring appears already full.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.style.transition = `stroke-dashoffset var(--dur-4) var(--ease-out)`;
      fill.setAttribute('stroke-dashoffset', target);
    }));
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
    animateRing(card);
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
      return { icon: IC.op, iconCls: 'op', badge: 'Operator-run', badgeCls: 'muted', lock: true };
    }
    // An ADVISORY warn is not "ready" (F-F001). `warn` isn't `fail`, so this row
    // used to take the green tick below — putting a reassuring ✓ in the loudest
    // element of the row, directly beside copy saying the owner's settings
    // aren't reaching their receptionist. Amber alert instead (--fail is already
    // amber, not red: nothing is broken). Advisory rows render no badge, so the
    // icon is the whole signal.
    //
    // Deliberately scoped to NON-MATERIAL rows: doctor.schedule also warns
    // ("3/4 doctors bookable"), and re-badging a material check is a change to
    // the readiness surface this finding doesn't call for.
    if (!m.material && c.severity === 'warn') {
      return { icon: IC.alert, iconCls: 'fail' };
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
    // Severity-aware (F-F001): this row used to render the label
    // "Using the latest instruction format" directly above a sub-line saying an
    // older one was in use — the row contradicted itself, and the reassuring
    // half was the bigger, bolder half.
    const m = metaFor(c.name, c.severity);
    const st = rowState(c, m);
    const advisory = !m.material;

    // Sub-line: for a failing owner item show the fix; for operator items the note.
    let sub = '';
    if (advisory) {
      // Names the CONSEQUENCE, not the mechanism. "An older instruction format"
      // told an owner nothing they could act on or even worry about correctly;
      // what they need to know is that their saved settings aren't being read.
      sub = c.severity === 'warn'
        ? '<div class="check__fix">Your saved settings aren’t reaching your receptionist yet — Prantivo can switch this over.</div>' : '';
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
      `<span class="badge badge--${st.badgeCls}">${st.lock ? IC.lock : ''}${st.badge}</span>`;

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
  // Grouped by WHO ACTS (spec §3.2). The copy map from portal-v1 §5.1 is
  // binding and unchanged — this is grouping only, no rewording.
  //
  // The second group is the honest presentation of an operator-run check: it
  // carries the lock badge and no fix link, which stops an owner hunting for a
  // control that does not exist. That was already true of the rows; what was
  // missing was a header saying so, leaving six checks in one undifferentiated
  // list of which four were not the owner's to do.
  //
  // `tenant.legacy_prompt` is removed from the rendered list entirely (spec
  // §3.2). It is not a task an owner can complete, and a checklist row implies
  // otherwise; it surfaces as the truth strip and only as the strip. Filtered by
  // NAME rather than by `!material` on purpose — a future advisory check should
  // still render, and silently swallowing every non-material check would be the
  // same class of bug as the unknown-check default exists to prevent.
  const HIDDEN_CHECKS = ['tenant.legacy_prompt'];

  function renderChecks(run, opts) {
    const ran = new Map(run.checks.map((c) => [c.name, c]));
    const shown = run.checks.filter((c) => !HIDDEN_CHECKS.includes(c.name));

    // Catalog order is preserved within each group (the order the run recorded).
    const needed = shown.filter((c) => {
      const m = metaFor(c.name);
      return m.material && m.actor !== 'operator';
    });
    const operator = shown.filter((c) => {
      const m = metaFor(c.name);
      return m.material && m.actor === 'operator';
    });

    // Operator checks that were SKIPPED still appear (owner should know they exist
    // and that Prantivo owns them — §5.1). Skipped owner/system checks are omitted:
    // they're prerequisite noise the config rows already explain.
    const skippedOps = (run.skipped || [])
      .filter((s) => metaFor(s.name).actor === 'operator' && !ran.has(s.name))
      .map((s) => ({ name: s.name, severity: 'skipped' }));

    const advisory = shown.filter((c) => !metaFor(c.name).material);

    const group = (label, rows, extraCls) => (rows.length
      ? `<p class="checks__group-label${extraCls || ''}">${label}</p>`
        + rows.map((c) => checkRow(c, opts)).join('')
      : '');

    return '<div class="checks">'
      + group('Needed to go live', needed)
      + group('Handled by Prantivo', operator.concat(skippedOps), ' checks__group-label--later')
      + group('Advisory', advisory, ' checks__advisory-label')
      + '</div>';
  }

  // Nothing has been checked yet. Names the action, not the absence — "no
  // readiness check has run" describes the system's bookkeeping; what the owner
  // needs to know is that pressing Go live is what runs it.
  function renderEmpty(opts) {
    const el = (opts && opts.cardEl) || document.getElementById('readinessCard');
    el.innerHTML =
      `<div class="emp">
        <div class="emp__i">${IC.spark}</div>
        <div class="emp__t">Let’s check your setup</div>
        <p class="emp__d">Nothing has been checked yet. Fill in your clinic’s details, then press
          Go live — that runs the check and tells you exactly what’s still missing.</p>
      </div>`;
  }

  // The validation run itself failed (spec §3.2). The ring is NOT rendered and
  // no score is shown: a false green here is worse than an error, and a ring
  // drawn from a failed request would be a number we invented. Retry reloads
  // rather than re-fetching in place — the whole page derives from this one
  // payload, so a partial recovery would leave the banner and the checks list
  // describing different runs.
  function renderError(opts) {
    const el = (opts && opts.cardEl) || document.getElementById('readinessCard');
    el.innerHTML =
      `<div class="pg-err">
        <div class="pg-err__i">${IC.alert}</div>
        <div class="pg-err__t">Couldn’t check your setup</div>
        <p class="pg-err__d">Your settings are safe. This is a problem on our side.</p>
        <button class="btn btn--primary" type="button" data-retry>Try again</button>
      </div>`;
    const btn = el.querySelector('[data-retry]');
    if (btn) btn.addEventListener('click', () => window.location.reload());
    const checksEl = (opts && opts.checksEl) || document.getElementById('checks');
    if (checksEl) checksEl.innerHTML = '';
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
    // The truth strip is shell chrome, but Home is the one page that fetches
    // readiness itself — so it HANDS the payload over rather than letting the
    // strip request its own. That is what keeps this page at exactly one
    // readiness round trip, and it is why shell.js contains a single fetch.
    document.dispatchEvent(new CustomEvent('portal:readiness', { detail: data }));
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
    metaFor, computeScore, ringSvg, animateRing, renderBanner, renderReadiness, renderChecks,
    checkRow, renderEmpty, renderError, fmtDate,
  };
})();
