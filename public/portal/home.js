/* ============================================================================
 * Home / Readiness (PORTAL-P1-S2) — read-only.
 *
 * Reads GET /portal/api/readiness (latest validation run + lifecycle status for
 * the session's tenant, INV-1) and renders:
 *   • the status banner (Draft / Validated / Live / Paused + its meaning),
 *   • the readiness RING (owner-scope material checks passed / owner-scope
 *     material total — the signature element. The operator's checks are shown
 *     but never scored, so the denominator is exactly the list the owner can
 *     act on), and
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

  // `draft` is a BACKEND lifecycle value and its label is not ours to reword.
  // Its MEANING line is, and it had one wording for four different situations —
  // it told a clinic whose own setup was finished to "finish the setup below",
  // which is the contradiction this session exists to remove. The line is now
  // chosen by draftMeaning() from the run renderBanner is handed.
  //
  // The variants share their first sentence on purpose: "isn't live yet" is the
  // half of `draft` that is never in doubt. Only the second sentence — what the
  // owner should do about it — depends on the checks. validated / live / paused
  // are untouched.
  const BANNER = {
    draft:     { label: 'Draft', meaning: 'Your receptionist isn’t live yet. Finish the setup below, then go live.' },
    validated: { label: 'Validated', meaning: 'Setup checks passed. You’re ready to go live.' },
    live:      { label: 'Live', meaning: 'Your receptionist is answering calls and messages.' },
    paused:    { label: 'Paused', meaning: 'Your receptionist is paused — calls and messages aren’t being answered.' },
  };
  const DRAFT_OPERATOR = 'Your receptionist isn’t live yet. Nothing more is needed from you — Prantivo is finishing the last steps.';
  const DRAFT_READY = 'Your receptionist isn’t live yet. Everything’s ready — press Go live when you are.';

  // NO RUN keeps the baseline line, and that is not caution — render() below
  // calls renderBanner BEFORE it knows whether a run exists, so the no-run arm
  // is also Home's never-checked state, the one where renderEmpty draws
  // "Nothing has been checked yet." A banner claiming the checks below show
  // anything would be a fresh untruth on exactly that screen.
  function draftMeaning(run) {
    if (!run || !run.checks) return BANNER.draft.meaning;
    if (ownerWorkOutstanding(run)) return BANNER.draft.meaning;
    return operatorFails(run).length ? DRAFT_OPERATOR : DRAFT_READY;
  }

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

  // How old the run is, in the words an owner would use. Only rendered beside a
  // STALE run: age is not interesting on a current one, and printing "6 days ago"
  // under a green ring would invent a worry the check does not support.
  // Deliberately coarse — the point is "before your changes", not a stopwatch.
  function fmtAge(iso) {
    const then = new Date(iso);
    if (isNaN(then)) return '';
    const mins = Math.floor((Date.now() - then.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  // ── Renderers ──────────────────────────────────────────────────────────────

  // `opts.bannerEl` lets a caller render into a different element (the
  // onboarding wizard's Review step, PORTAL-P6-S16 — see window.PortalHome
  // below); defaults to this page's own #banner, so the call from main() below
  // is byte-identical to before this option existed.
  // `opts.run` is optional and read for the DRAFT state ONLY (see draftMeaning).
  // Absent, the draft line is the one it has always been — so every caller that
  // has no run to hand over stays correct without knowing this option exists.
  function renderBanner(status, opts) {
    const b = BANNER[status] || BANNER.draft;
    const el = (opts && opts.bannerEl) || document.getElementById('banner');
    const meaning = b === BANNER.draft ? draftMeaning(opts && opts.run) : b.meaning;
    el.innerHTML =
      `<div class="banner banner--${esc(status)}">
        <span class="banner__dot"></span>
        <div class="banner__body">
          <div class="banner__label">${esc(b.label)}</div>
          <div class="banner__meaning">${esc(meaning)}</div>
        </div>
      </div>`;
  }

  // ── The owner-scope line ───────────────────────────────────────────────────
  // ONE predicate, read by the ring, the headline, the banner and the
  // onboarding CTA — four surfaces describing the same progress from three
  // different predicates is how they came to disagree with each other.
  //
  // Owner scope is everything that is NOT the operator's. `system` checks
  // (config.schema, prompt.renders, consent.lines) are derived from settings
  // the owner saved and are nobody else's to fix, so they belong on the owner's
  // side of the line; the unknown-check default is `system` too (shell.js:166),
  // which keeps a future check inside the score rather than silently outside it.
  const ownerScope = (m) => m.material && m.actor !== 'operator';

  function ownerWorkOutstanding(run) {
    return (run.checks || []).some((c) => ownerScope(metaFor(c.name)) && c.severity === 'fail');
  }

  // Operator work the owner is WAITING ON. FAILING only. A skipped operator
  // check is not outstanding — it is a channel this clinic does not use ("Not
  // in use", see the skipped branch of the row-state map below), and the run
  // passes with it skipped. Counting one as outstanding would tell every live
  // clinic with its voice line switched off that Prantivo is still finishing
  // something.
  function operatorFails(run) {
    return (run.checks || []).filter((c) => {
      const m = metaFor(c.name);
      return m.material && m.actor === 'operator' && c.severity === 'fail';
    });
  }

  // Ring: material OWNER-SCOPE checks that RAN. numerator = not-failed;
  // denominator = ran. Advisory and skipped checks are excluded as they always
  // were (a skipped check made no claim); OPERATOR checks are excluded as of
  // this session.
  //
  // The denominator is now exactly the rows rendered under "Needed to go live".
  // renderChecks has grouped by `actor !== 'operator'` since PORTAL-P6-S18
  // while the ring scored by `material` alone, so the ring counted rows the
  // owner was shown under a different heading, told they were Prantivo's, and
  // given no link to act on: a clinic whose own work was finished read "8 of
  // 11" beside a list of 8. Nothing about eligibility moves — `run.passed` is
  // the only signal deriveGoLive reads and it is the server's.
  function computeScore(checks) {
    let passed = 0, total = 0;
    for (const c of checks) {
      const m = metaFor(c.name);
      if (!ownerScope(m)) continue;
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

  // A distinct operator CONCERN, taken from the check's own namespace rather
  // than a second lookup table: whatsapp.config and whatsapp.live are one thing
  // for an owner to be waiting on, not two.
  const concernOf = (name) => String(name).split('.')[0];

  // The note for a finished owner setup with Prantivo still working. It names
  // the outstanding item only when there is exactly ONE concern — two or more
  // stops being a sentence and starts being a list, and the "Handled by
  // Prantivo" rows immediately below already ARE that list, named exactly. The
  // label is the one from CHECK_META, so this sentence and the row it refers to
  // can never call the same thing two different things.
  function operatorNote(fails) {
    const concerns = new Set(fails.map((c) => concernOf(c.name)));
    return concerns.size === 1
      ? `Nothing more is needed from you. Prantivo is finishing the last step — ${metaFor(fails[0].name).label} — and your receptionist can go live once that’s done.`
      : 'Nothing more is needed from you. Prantivo is finishing the last steps — your receptionist can go live once that’s done.';
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
    const opFails = operatorFails(run);

    // Any owner-scope material check still failing? The SAME predicate the ring
    // scores with, so the number and the sentence beside it can no longer be
    // describing different sets of checks. It used to be `actor === 'owner'`,
    // which left the four `system` checks outside it.
    const ownerTodo = ownerWorkOutstanding(run);

    let headline, note;
    if (complete && opFails.length) {
      headline = 'Your setup is complete';
      note = operatorNote(opFails);
    } else if (complete) {
      headline = 'All setup checks are ready';
      note = 'Every check that gates go-live has passed.';
    } else {
      headline = `${passed} of ${total} setup checks ready`;
      // The second arm is DEFENSIVE. With an owner-scope denominator `ownerTodo`
      // is equivalent to `!complete` for every total > 0, so it is reachable
      // only at total === 0 — a run in which no owner-scope material check ran
      // at all. That payload shape is real (a run carrying nothing but operator
      // checks), and "0 of 0 setup checks ready" under an instruction to
      // complete highlighted items that do not exist would be worse than this.
      note = ownerTodo
        ? 'Complete the highlighted items below, then your receptionist can go live.'
        : 'The remaining items are handled by Prantivo before go-live.';
    }

    // ── Stale (F1) ────────────────────────────────────────────────────────────
    // The payload has carried `run.stale` since PORTAL-P6-S18 and NO surface has
    // ever rendered it: a run whose verdict had expired was drawn exactly like a
    // current one, ring, score, check rows and all. That is the same defect class
    // as F-F001 — a screen asserting something it cannot vouch for — and here it
    // was load-bearing, because the score the owner is being shown is the reason
    // they can or cannot go live.
    //
    // So: state the condition, do not deny it, and do not quietly repair it
    // either. The ring keeps the number the RUN produced rather than a guess at
    // what a new one would say — inventing a score is worse than an old one — and
    // the block below says which changes it predates and offers the re-check that
    // settles it. No auto-refresh on load: a page that silently re-ran the checks
    // would hide the mechanism and spend a Meta ping plus a model turn on every
    // visit to Home.
    const ran = run.stale
      ? `<div class="readiness__expired">
          <div class="readiness__expired-t">
            <span class="readiness__expired-dot"></span>These results are out of date
          </div>
          <p class="readiness__expired-d">Your settings changed after this check ran, so the score above
            doesn’t include them yet. Last checked ${esc(fmtDate(run.created_at))} · ${esc(fmtAge(run.created_at))}.</p>
          <button class="btn btn--primary" type="button" data-recheck>Check again</button>
        </div>`
      : `<div class="readiness__ran">Last checked ${esc(fmtDate(run.created_at))}</div>`;

    card.innerHTML =
      `<div class="readiness">
        ${ringSvg(passed, total)}
        <div class="readiness__summary">
          <div class="readiness__headline">${esc(headline)}</div>
          <div class="readiness__note">${esc(note)}</div>
          ${ran}
        </div>
      </div>`;

    const checksEl = (opts && opts.checksEl) || document.getElementById('checks');
    checksEl.innerHTML = renderChecks(run, opts);
    animateRing(card);
  }

  // ── Check again (F1) ───────────────────────────────────────────────────────
  // Re-runs the setup checks WITHOUT going live, via the owner-scoped
  // POST /portal/api/readiness/check. The response is the same shape
  // GET /api/readiness returns, so it goes straight back through render() — the
  // one render path, shared with page load and with every lifecycle action.
  //
  // Delegated from the document because the card is re-rendered on every one of
  // those, so a per-render binding would leak listeners and miss re-renders. It
  // also means the wizard's Review step, which mounts renderReadiness into its
  // own card, gets the button working for free.
  async function recheck(btn) {
    window.Portal.setBusy(btn, true, 'Checking…');
    let res, data;
    try {
      res = await fetch('/portal/api/readiness/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      });
      data = await res.json().catch(() => null);
    } catch (_) {
      window.Portal.setBusy(btn, false);
      window.Portal.toast('Couldn’t reach Prantivo. Nothing changed.', false);
      return;
    }
    if (res.status === 401) { window.location.replace('login.html'); return; }
    if (!res.ok) {
      window.Portal.setBusy(btn, false);
      window.Portal.toast((data && data.error) || 'Couldn’t check your setup. Try again.', false);
      return;
    }
    // No setBusy(false): the re-render below replaces the card, button and all.
    //
    // renderReadiness is mounted on TWO surfaces — this page and the wizard's
    // Review step, which passes its own cardEl/checksEl (PORTAL-P6-S16). Calling
    // render() unconditionally would reach for #banner/#readinessCard, which the
    // wizard does not have, and a button that throws is worse than one that isn't
    // there. Home renders itself; anywhere else re-renders from the event, which
    // is how the wizard's Review step gets a working control without this file
    // knowing anything about the wizard's DOM.
    if (document.body.getAttribute('data-page') === 'home') render(data);
    else document.dispatchEvent(new CustomEvent('portal:rechecked', { detail: data }));
    window.Portal.toast('Setup checked');
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-recheck]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    recheck(btn);
  });

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
  //
  // `run` is the readiness payload's run, HANDED in by main() rather than
  // fetched here — Home is a one-readiness-round-trip page and this must not
  // become the second. Null (no run yet, or the fetch failed) means the state
  // is unknown, and an unknown state keeps the banner: an owner cannot be told
  // they are finished on the strength of a check that never ran.
  function renderOnboardingBanner(onboarding, run) {
    const host = document.getElementById('onboardingBanner');
    if (!host) return;
    if (!onboarding || onboarding.completed) { host.innerHTML = ''; return; }
    const resuming = onboarding.step != null;
    // A resuming owner with nothing owner-scope failing has nothing to resume.
    // This CTA is the loudest element on the page and it was telling a clinic
    // that had finished to go and finish — into a wizard whose own Review step
    // would then have shown them the complete ring they had just been sent away
    // from. Only the RESUMING banner is suppressed; the never-started case is
    // handled by main()'s redirect above and is untouched.
    if (resuming && run && !ownerWorkOutstanding(run)) { host.innerHTML = ''; return; }
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


  // ==========================================================================
  // THE GREETING BLOCK (Portal Phase 1)
  //
  // Home mentioned the receptionist four times and showed her none. Her actual
  // words lived only inside the editing pages' preview panel, behind a 44px
  // strip labelled "Preview" that is one click from a permanent, cross-session
  // exile — so an owner could use this product and never once read a line their
  // receptionist would say. This block is what fixes that, and it comes FIRST
  // on the page: you meet her, then you read the bookkeeping about her.
  //
  // ── One round trip stays one round trip ────────────────────────────────────
  // GET /portal/api/readiness carries no persona at all — its owner-safe
  // projection is {name, severity} and nothing else (routes.js). The greeting
  // lives on GET /portal/api/knowledge-summary, the same owner-scoped endpoint
  // the Verbatim panel and `Everything it knows` already read. So this is a
  // SECOND fetch, and it is fired AFTER render() has painted, never awaited by
  // it, never in front of it. No route was added.
  //
  // Any failure empties the host and takes no space. A block that cannot state
  // the greeting truthfully states nothing — it must never become a third way
  // for this page to show an error, and it must never render half a claim.
  //
  // ── Honesty on a legacy clinic ─────────────────────────────────────────────
  // On a clinic running a hand-written script the stored greeting is NOT what
  // the receptionist says, so this block may not say it is. The verdict comes
  // from the run Home ALREADY HOLDS, through ShadowNotice.isShadowed — the same
  // field the truth strip and the panel's header read, with no second request —
  // and the words are the panel's own, SAVED_ONLY. Three surfaces, one
  // vocabulary; an unknown verdict changes nothing, as everywhere else.
  // ==========================================================================
  const GC = window.GreetingCopy;

  // The one link out. Names the page's own subject — `sections.receptionist`
  // is titled "How it introduces itself" by the very payload this block reads.
  const GREET_LINK = 'Change how it introduces itself';
  // What she is called when `personality.display_name` is blank, which is the
  // schema default and the common case for a fresh clinic. receptionist.html
  // says the same thing about the same field: "it introduces itself as your
  // clinic's receptionist, with no name".
  const GREET_NONAME = 'Your receptionist';
  // What this line IS. receptionist.html's Greeting card, verbatim.
  const GREET_WHEN = 'The first thing a caller or customer hears';

  function renderGreeting(rec, shadowed) {
    const host = document.getElementById('greeting');
    if (!host) return;

    const langs = rec.languages || [];
    const lang = rec.default_language || langs[0] || 'en';
    const line = String((rec.greeting || {})[lang] || '').trim();
    const name = String(rec.display_name || '').trim();

    // The qualifier is the claim. On a shadowed clinic there is no claim to
    // make about what is heard, so it takes the panel's word for that state
    // rather than a second one invented here.
    const when = shadowed ? window.ShadowNotice.SAVED_ONLY : GREET_WHEN;

    let body;
    if (line) {
      // NEVER truncated and never line-clamped. The schema caps a greeting at
      // 300 characters; a long one producing a tall block is the product
      // telling the truth about a greeting that is too long to say out loud.
      body = `<p class="greet__line" lang="${esc(lang)}">${esc(line)}</p>`;
      // Mandatory beside a vernacular line, never aria-hidden (spec 2.10) —
      // and its three answers are greeting-copy.js's, shared verbatim with the
      // panel so the two surfaces cannot gloss the same line two ways.
      const gloss = GC.glossFor(lang, langs, () => String((rec.greeting || {}).en || '').trim());
      if (gloss) {
        body += `<p class="greet__gloss"><b>${esc(gloss.label)}</b>${esc(gloss.text)}</p>`;
      }
    } else {
      // Defensive. clinicDefaults ships a real greeting in all three languages
      // and writeTenantConfig merges onto it, so a clinic with a config
      // document always has one — a fresh clinic sees the DEFAULT line, which
      // does not name their clinic and is its own prompt to change it. This arm
      // is for a document that predates the field.
      body = `<p class="greet__none">${esc(GC.noGreeting(lang))}</p>`;
    }

    host.classList.remove('sk-wrap');
    host.innerHTML =
      `<p class="greet__who"><span class="greet__name">${esc(name || GREET_NONAME)}</span>`
      + `<span class="greet__when">${esc(when)}</span></p>`
      + body
      + `<a class="greet__link" href="receptionist.html">${esc(GREET_LINK)}${IC.arrow}</a>`;
  }

  // Fired after the readiness render, never awaited by it. `run` is the payload
  // Home already has; it is read for the legacy verdict only.
  async function loadGreeting(run) {
    const host = document.getElementById('greeting');
    if (!host) return;
    let data;
    try {
      const res = await fetch('/portal/api/knowledge-summary', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('summary ' + res.status);
      data = await res.json();
    } catch (_) {
      host.innerHTML = '';           // silent: no error surface, no partial claim
      host.classList.remove('sk-wrap');
      return;
    }
    const rec = data && data.sections && data.sections.receptionist;
    if (!rec) { host.innerHTML = ''; host.classList.remove('sk-wrap'); return; }
    renderGreeting(rec, window.ShadowNotice && window.ShadowNotice.isShadowed(run) === true);
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
    // The onboarding CTA is rendered AFTER the readiness fetch, because whether
    // to render it at all depends on the run (see renderOnboardingBanner). It
    // still renders on the failure path below, with a null run: onboarding
    // state is not readiness state, and hiding the owner's way back into the
    // wizard because a fetch failed would put a second failure on top of the
    // first. #onboardingBanner keeps its place in the document either way, so
    // nothing moves — only when it is filled in.
    let data;
    try {
      const res = await fetch('/portal/api/readiness', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('readiness ' + res.status);
      data = await res.json();
    } catch (_) {
      renderOnboardingBanner(me.onboarding, null);
      renderError();
      // The greeting still loads. It comes from a DIFFERENT endpoint and is
      // still true when readiness is not available — and leaving the block on
      // its skeleton forever, because a request it does not depend on failed,
      // would be a second failure stacked on the first. `null` means the legacy
      // verdict is unknown, which changes nothing here exactly as it changes
      // nothing in the panel: we only ever withdraw a claim from evidence.
      loadGreeting(null);
      return;
    }

    renderOnboardingBanner(me.onboarding, data.run);
    render(data);
    // AFTER the paint above, and deliberately not awaited: the readiness round
    // trip is the one this page is measured on and the greeting may not delay
    // it by a millisecond.
    loadGreeting(data.run);

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
    renderBanner(data.status, { run: data.run });
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
