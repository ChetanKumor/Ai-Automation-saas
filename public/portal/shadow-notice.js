/* ============================================================================
 * "Your receptionist isn't reading this yet" notice (F-F001).
 *
 * Some clinics were set up with a hand-written script instead of the settings
 * in this portal. For those, the receptionist reads the script and IGNORES
 * every prompt field these pages write — but the portal still showed "Saved ·
 * v{N}" and a readiness row reading "Using the latest instruction format".
 * A success state that lies, on the surface whose whole job is to tell the
 * owner what their receptionist knows.
 *
 * This file is the single source for that warning: which pages are affected,
 * what each one loses, what still works, and the qualified save confirmation.
 *
 * ── Where the signal comes from ─────────────────────────────────────────────
 * The `tenant.legacy_prompt` validation check, already projected to the owner
 * by readinessSnapshot (src/portal/routes.js) as {name, severity}:
 *   severity 'warn' → a script is set; these pages are inert    → warn
 *   severity 'pass' → no script; the settings are live          → say nothing
 *   check absent / no run yet / no readiness payload            → say NOTHING
 * The third case is the important one. That endpoint reads the LATEST PERSISTED
 * validation run and never triggers a new one, so a clinic that has never been
 * validated genuinely has no verdict. Guessing either way would replace one
 * false claim with another, so `isShadowed` returns null and every caller
 * stays silent. We warn only from evidence.
 *
 * Staleness does NOT apply here, deliberately. `run.stale` means the CONFIG
 * moved after the run; this verdict reads `tenants.ai_prompt`, which no portal
 * route can write and no config edit touches. A stale run's legacy verdict is
 * still current.
 *
 * ── Why a shared UMD-lite file (cf. booking-summary.js) ─────────────────────
 * No build step (spec §2), and the logic is pure, so the same file the browser
 * loads is the one node:test requires. The wording is asserted against the
 * shipped source rather than a copy that can drift.
 * ========================================================================== */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ShadowNotice = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // The validation check that carries the verdict.
  const CHECK_NAME = 'tenant.legacy_prompt';

  // ── Affected pages, keyed by <body data-page> ──────────────────────────────
  // Straight off A-007's "Shadowed" table: every config path rendered only by
  // templates/clinic.js, mapped to the page that writes it. `what` names the
  // owner's OWN words back to them — "your prices", not "pricing.*" — because a
  // warning that says only "something here is wrong" makes an owner re-check
  // everything (spec §1: named by what the owner recognises).
  //
  // Deliberately ABSENT — these bypass the prompt head and work normally, so a
  // notice on them would itself be false: doctors (tenant_entities), FAQs and
  // documents (knowledge_chunks, injected into the prompt TAIL), history, and
  // the test page. The test page especially: it runs the real brain through the
  // real script, so it is the one page showing an affected clinic the truth.
  // `what` is a bare noun phrase, never a clause, and the sentence that carries
  // it takes no verb agreeing with it ("Saved but not in use: your prices").
  // These phrases are a mix of singular and plural — an earlier draft read
  // "Your prices is saved to your account", caught in the rendered page.
  const SHADOWED = {
    profile: {
      what: 'your clinic’s name, address, phone numbers and languages',
    },
    hours: {
      what: 'your opening hours and holiday closures',
      also: 'Bookings are still refused outside the hours you set here — your receptionist just won’t quote them.',
    },
    pricing: {
      what: 'your prices',
    },
    booking: {
      what: 'the booking wording on this page',
      // The sharpest distinction in A-007: enforcement is server-side
      // (appointmentService reads the config document directly), so the rules
      // hold even while the receptionist can't describe them. Saying otherwise
      // would send an owner chasing a booking bug that does not exist.
      also: 'Your booking rules themselves are still enforced — appointments outside them are refused as normal.',
    },
    receptionist: {
      what: 'your receptionist’s name, tone, reply length and greeting',
    },
    safety: {
      what: 'your handoff and escalation wording',
      also: 'Your escalation phone number still receives handoffs.',
    },
    // Read-only summary page: nothing to save, so the copy shifts from "your
    // edit is inert" to "this page is describing settings your receptionist
    // isn't reading".
    knows: {
      what: 'the clinic details on this page',
      readonly: true,
    },
  };

  // What survives, verbatim in spirit from A-007's "Survives" list. Stated on
  // EVERY notice: an owner told only that something is broken will assume the
  // whole portal is dead, which is its own falsehood.
  const SURVIVES =
    'Still working normally: appointment booking, your doctors and their hours, and your FAQ answers.';

  const TITLE = 'Your receptionist is following a custom script';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * The verdict, from a readiness run.
   * @returns {boolean|null} true = shadowed, false = not, null = not known.
   */
  function isShadowed(run) {
    if (!run || !Array.isArray(run.checks)) return null;
    const c = run.checks.find((x) => x && x.name === CHECK_NAME);
    if (!c) return null;
    return c.severity === 'warn';
  }

  /** Per-page copy, or null if this page writes nothing that gets shadowed. */
  function pageNotice(pageId) {
    return SHADOWED[pageId] || null;
  }

  /**
   * The notice, as an HTML string — '' whenever we should stay quiet, so a
   * caller can assign it unconditionally.
   */
  function noticeHtml(pageId, run) {
    const page = pageNotice(pageId);
    if (!page) return '';
    if (isShadowed(run) !== true) return '';

    const middle = page.readonly
      ? `<strong>Shown here but not in use:</strong> ${esc(page.what)}. Your receptionist answers from a script Prantivo wrote by hand, so what it actually says may differ from what you see here.`
      : `<strong>Saved but not in use:</strong> ${esc(page.what)}. Your receptionist answers from a script Prantivo wrote by hand, so nothing you change here reaches it until Prantivo moves you across.`;

    const also = page.also ? `<p class="shadow-notice__also">${esc(page.also)}</p>` : '';

    return `<div class="shadow-notice" role="status">
      <svg class="shadow-notice__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/></svg>
      <div class="shadow-notice__body">
        <p class="shadow-notice__title">${esc(TITLE)}</p>
        <p class="shadow-notice__text">${middle}</p>
        ${also}
        <p class="shadow-notice__text">${esc(SURVIVES)}</p>
        <p class="shadow-notice__ask">Ask Prantivo to switch this clinic over to your saved settings.</p>
      </div>
    </div>`;
  }

  /**
   * The save confirmation. Unqualified "Saved · v3" is exactly the false
   * success A-008 names, so on an affected page it gains the caveat. Unknown
   * verdict → the plain message, never a guess.
   */
  function savedMessage(version, run, pageId) {
    const base = 'Saved · v' + version;
    if (pageId && !pageNotice(pageId)) return base;
    return isShadowed(run) === true ? base + ' — not reaching your receptionist yet' : base;
  }

  return { CHECK_NAME, SHADOWED, SURVIVES, TITLE, isShadowed, pageNotice, noticeHtml, savedMessage };
});
