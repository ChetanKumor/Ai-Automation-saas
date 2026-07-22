/* ============================================================================
 * Onboarding wizard (PORTAL-P6-S16) — a guided pass over pages that already
 * exist. Spec §6: "no duplicate form code — each step embeds the page's card."
 *
 * How embedding works (see docs/specs/portal-v1-spec.md §6, session notes):
 * each form/multi-card step loads the step's own STANDALONE page (identical
 * URL an owner would visit directly) in a same-origin <iframe> — literally the
 * same HTML, same JS, same /portal/api/... endpoint, same validation. This file
 * never re-implements a form or a write path. It only:
 *   1. supplies the wizard's OWN chrome (step indicator, Back/Skip/Continue),
 *   2. sizes the iframe to its real content (same-origin → can read
 *      contentDocument.scrollHeight directly; no postMessage needed),
 *   3. for form-kind steps, triggers the embedded page's own submit and infers
 *      success/failure by polling that page's own saveBtn/saveNote DOM state
 *      (see watchIframeSave) — again reading, never re-implementing,
 *   4. persists the current step to meta.onboarding_step via
 *      /portal/api/onboarding (the ONE new write route this session adds).
 *
 * The Review step is the one step with no standalone page of its own; it
 * reuses window.PortalHome (home.js, loaded above this script) — the exact
 * ring/check-row rendering index.html's own Home page uses, via the same
 * /portal/api/readiness payload. Never a second readiness implementation.
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  // Step order, spec §6: Profile → Hours → Doctors → Pricing → Greeting → FAQs → Review.
  // `formId` is the id of the <form> the embedded page's OWN save() is bound to
  // (see each page's own boot — clinic-profile.js etc.) — Doctors/FAQs have no
  // single page-level form (each card saves itself), so `kind: 'multi'` skips
  // the save-and-watch step entirely; Continue there just advances.
  const STEPS = [
    { id: 'profile', title: 'Clinic profile', kind: 'form', page: 'clinic-profile.html', formId: 'profileForm' },
    { id: 'hours', title: 'Hours & holidays', kind: 'form', page: 'hours.html', formId: 'hoursForm',
      note: 'Going live needs valid opening hours for at least one day.' },
    { id: 'doctors', title: 'Doctors', kind: 'multi', page: 'doctors.html',
      note: 'Going live needs at least one doctor with weekly hours, so patients can book an appointment.' },
    { id: 'pricing', title: 'Pricing', kind: 'form', page: 'pricing.html', formId: 'pricingForm' },
    { id: 'greeting', title: 'Greeting', kind: 'form', page: 'receptionist.html', formId: 'receptionistForm' },
    { id: 'faqs', title: 'FAQs', kind: 'multi', page: 'faqs.html',
      note: 'Add at least 5 FAQs so your receptionist can answer common questions.' },
    { id: 'review', title: 'Review', kind: 'review' },
  ];
  const LAST = STEPS.length - 1;

  // Review-step "go fix this" links: redirect a check's fix-page to the wizard
  // step that owns it (spec Deliverable 5: "edit links back into steps"). A
  // check whose page isn't part of the wizard (e.g. Safety & handoff /
  // numbers.e164) falls through to home.js's own real href — see checkRow's
  // stepFor handling in home.js.
  const STEP_FOR_HREF = {
    'clinic-profile.html': 0, 'hours.html': 1, 'doctors.html': 2, 'pricing.html': 3, 'faqs.html': 5,
  };
  const stepFor = (m) => (m && m.href && STEP_FOR_HREF[m.href] != null) ? STEP_FOR_HREF[m.href] : null;

  const state = { step: 0, heightTimer: null };

  // ── Toast (same minimal pattern every portal page uses) ─────────────────────
  function toast(message, ok) {
    const host = $('toastHost');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (ok ? CHECK : '') + `<span>${message}</span>`;
    el.style.transition = 'opacity .3s ease, transform .3s ease';
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 2600);
    setTimeout(() => el.remove(), 2950);
  }

  // ── Iframe auto-height ───────────────────────────────────────────────────────
  // Same-origin (the wizard's SAMEORIGIN framing header, routes.js) means the
  // parent can read the embedded document's real height directly — no
  // postMessage contract to invent or keep in sync with 6 separate page files.
  function stopHeightWatch() {
    if (state.heightTimer) { clearInterval(state.heightTimer); state.heightTimer = null; }
  }
  function startHeightWatch(iframe) {
    stopHeightWatch();
    state.heightTimer = setInterval(() => {
      let doc;
      try { doc = iframe.contentDocument; } catch (_) { return; }
      if (!doc || !doc.documentElement) return;
      const h = Math.max(doc.documentElement.scrollHeight, (doc.body && doc.body.scrollHeight) || 0);
      if (h && Math.abs((iframe._lastH || 0) - h) > 2) {
        iframe.style.height = h + 'px';
        iframe._lastH = h;
      }
    }, 200);
  }

  // ── Watch an embedded form-kind step's OWN save button/note ──────────────────
  // Every form-kind page (clinic-profile.js/hours.js/pricing.js/receptionist.js)
  // shares one save() shape: saveBtn.disabled goes true→false around the fetch,
  // and saveNote gains class `save-note--saved` ONLY on a real 200 (see each
  // page's save()). Polling that public, already-stable DOM contract lets the
  // wizard know success/failure without a single line changed in those files.
  // onDone(true|false|null) — null means "never finished" (a hung request).
  function watchIframeSave(iframe, onDone) {
    let sawBusy = false;
    let elapsed = 0;
    const iv = setInterval(() => {
      elapsed += 120;
      let doc;
      try { doc = iframe.contentDocument; } catch (_) { doc = null; }
      const btn = doc && doc.getElementById('saveBtn');
      const note = doc && doc.getElementById('saveNote');
      if (!btn || !note) {
        if (elapsed > 20000) { clearInterval(iv); onDone(null); }
        return;
      }
      if (btn.disabled) { sawBusy = true; return; }
      if (!sawBusy) {
        if (elapsed > 20000) { clearInterval(iv); onDone(null); }
        return;
      }
      clearInterval(iv);
      onDone(note.classList.contains('save-note--saved'));
    }, 120);
  }

  // ── Progress persistence ─────────────────────────────────────────────────────
  // Best-effort: a failed write here never blocks navigation (the owner is
  // already looking at the next step) — worst case, resuming later lands one
  // step behind where they actually got to.
  async function persistStep(index) {
    try {
      const res = await fetch('/portal/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ step: index }),
      });
      if (res.status === 401) { window.location.replace('login.html'); }
    } catch (_) { /* best-effort — see above */ }
  }

  // ── Step chrome ──────────────────────────────────────────────────────────────
  function restingLabel(kind) {
    if (kind === 'review') return 'Done';
    if (kind === 'multi') return 'Continue';
    return 'Save & continue';
  }

  function setContinueBusy(busy) {
    const btn = $('wizContinue');
    btn.disabled = busy;
    if (busy) { btn.textContent = 'Saving…'; return; }
    btn.textContent = restingLabel(STEPS[state.step].kind);
  }

  function renderStep() {
    const step = STEPS[state.step];

    $('wizStepLabel').textContent = `Step ${state.step + 1} of ${STEPS.length} · ${step.title}`;
    const pct = Math.round((state.step / LAST) * 100);
    $('wizBarFill').style.width = pct + '%';
    $('wizBar').setAttribute('aria-valuenow', String(pct));
    $('wizTitle').textContent = step.title;

    const noteEl = $('wizNote');
    if (step.note) { noteEl.textContent = step.note; noteEl.hidden = false; } else { noteEl.hidden = true; }

    $('wizSaveNote').textContent = '';
    $('wizSaveNote').classList.remove('wiz__save-note--error');
    $('wizBack').disabled = state.step === 0;
    setContinueBusy(false);

    stopHeightWatch();

    if (step.kind === 'review') {
      $('wizFrameWrap').hidden = true;
      $('wizReview').hidden = false;
      $('wizSkip').hidden = true;
      loadReview();
      return;
    }

    $('wizReview').hidden = true;
    $('wizFrameWrap').hidden = false;
    $('wizSkip').hidden = step.kind !== 'form'; // multi-kind steps have nothing separate to skip

    const iframe = $('wizFrame');
    // Only reload when the target page actually changes — reloading the SAME
    // step (e.g. after a failed save, still fixing an inline error) would
    // discard whatever the owner just typed.
    if (iframe.dataset.loadedPage !== step.page) {
      iframe.src = step.page;
      iframe.dataset.loadedPage = step.page;
      iframe._lastH = 0;
    }
    startHeightWatch(iframe);
  }

  function goTo(index) {
    index = Math.max(0, Math.min(LAST, index));
    state.step = index;
    renderStep();
    persistStep(index);
  }

  // ── Nav actions ──────────────────────────────────────────────────────────────
  function onBackClick() {
    if (state.step > 0) goTo(state.step - 1);
  }

  function onSkipClick() {
    goTo(state.step + 1);
  }

  function onContinueClick() {
    const step = STEPS[state.step];
    if (step.kind === 'review') { window.location.href = 'index.html'; return; }
    if (step.kind === 'multi') { goTo(state.step + 1); return; }

    const iframe = $('wizFrame');
    let doc, form, loadCard;
    try {
      doc = iframe.contentDocument;
      form = doc && doc.getElementById(step.formId);
      loadCard = doc && doc.getElementById('loadCard');
    } catch (_) { form = null; }
    // Every embedded form page hides its shared #loadCard placeholder AFTER
    // wiring its own submit listener (see e.g. clinic-profile.js's main()) —
    // a universal, page-agnostic "ready for requestSubmit()" signal. Without
    // this guard a Continue click that lands mid-load would requestSubmit() a
    // form with no listener yet, and the browser's default submit would
    // navigate the iframe away from whatever the owner had just typed.
    if (!form || !loadCard || !loadCard.hidden) { toast('Still loading — try again in a moment.', false); return; }

    setContinueBusy(true);
    form.requestSubmit();
    watchIframeSave(iframe, (success) => {
      // The step may have changed while we were waiting (owner clicked Back) —
      // only act on the result if we're still looking at the step we saved.
      if (STEPS[state.step] !== step) return;
      setContinueBusy(false);
      if (success === true) {
        goTo(state.step + 1);
      } else if (success === false) {
        $('wizSaveNote').textContent = 'Fix the highlighted fields to continue, or skip for now.';
        $('wizSaveNote').classList.add('wiz__save-note--error');
      } else {
        toast('That’s taking a while — check your connection and try again.', false);
      }
    });
  }

  function onChecksClick(e) {
    const a = e.target.closest('[data-goto-step]');
    if (!a) return;
    e.preventDefault();
    goTo(Number(a.dataset.gotoStep));
  }

  // ── Review step ──────────────────────────────────────────────────────────────
  async function loadReview() {
    $('wizGolive').innerHTML = '';
    $('wizBanner').innerHTML = '';
    $('wizReadinessCard').innerHTML = '<div class="state-msg">Loading your readiness…</div>';
    $('wizChecks').innerHTML = '';

    let data;
    try {
      const res = await fetch('/portal/api/readiness', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('readiness ' + res.status);
      data = await res.json();
    } catch (_) {
      window.PortalHome.renderError({ cardEl: $('wizReadinessCard') });
      return;
    }

    // The Go-live control, in its real (display-only — S18 owns the action)
    // state — the exact same rendering the header uses everywhere else.
    window.Portal.renderLifecycle(data.status, window.Portal.deriveGoLive(data.run), $('wizGolive'));
    window.PortalHome.renderBanner(data.status, { bannerEl: $('wizBanner') });
    if (!data.run) { window.PortalHome.renderEmpty({ cardEl: $('wizReadinessCard') }); return; }
    window.PortalHome.renderReadiness(data.run, { cardEl: $('wizReadinessCard'), checksEl: $('wizChecks'), stepFor });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  async function main() {
    try { await window.Portal.me; } catch (_) { return; } // shell redirected to login

    let progress = { step: null, completed: false };
    try {
      const res = await fetch('/portal/api/onboarding', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (res.ok) progress = await res.json();
    } catch (_) { /* fall back to step 0 below */ }

    state.step = (typeof progress.step === 'number') ? Math.max(0, Math.min(LAST, progress.step)) : 0;

    $('wizBack').addEventListener('click', onBackClick);
    $('wizSkip').addEventListener('click', onSkipClick);
    $('wizContinue').addEventListener('click', onContinueClick);
    $('wizChecks').addEventListener('click', onChecksClick);

    $('wizLoadCard').hidden = true;
    $('wiz').hidden = false;
    renderStep();
  }

  main();
})();
