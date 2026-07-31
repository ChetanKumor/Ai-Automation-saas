/* ============================================================================
 * The TRUTH STRIP, and the F-F001 notice it grew out of.
 *
 * ── What this file is now (D3) ──────────────────────────────────────────────
 * One component, not two. It began as the per-page "your receptionist isn't
 * reading this yet" notice; D3 promotes it to the portal-wide strip described
 * in spec §2.9 — a band between the top bar and the page header that renders
 * ONLY when the system's state and the owner's reasonable expectation diverge,
 * and does not exist at all when they agree.
 *
 * It was deliberately NOT built as a second component alongside the notice.
 * A parallel global strip would have put two amber blocks on every shadowed
 * page, both reporting one condition. One component makes that impossible by
 * construction rather than by discipline.
 *
 * So the copy resolves page-aware from the single SHADOWED table below:
 *   • on a shadowed page → the strip names what THIS page loses
 *   • anywhere else      → the general sentence
 *   • the full explanation (what still works, what to ask for) moved into the
 *     "What this affects" modal, where an owner who wants it can ask for it —
 *     rather than occupying six lines of every page, permanently.
 *
 * Three conditions ship, in priority order: a custom script is in use, the
 * receptionist is paused, the receptionist is not live yet. A fourth
 * ("partially connected") was specified and is NOT built: /portal/api/readiness
 * carries no channel-connection state, and deriving it from the whatsapp/voice
 * checks is unsound — a SKIPPED voice check means voice is switched off for the
 * clinic, not "not set up yet", and since voice.config is material a tenant
 * with it failing can never be live, so the not-live condition would always
 * win. It would have been unreachable code.
 *
 * ── The original notice, unchanged in substance ─────────────────────────────
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
  //
  // ⚠ HAND-MAINTAINED against A-007's audited snapshot of what the renderer
  // actually reads (docs/specs/issue-34-legacy-prompt-shadows-portal-config.md).
  // Nothing derives it and no test can catch it drifting: if shadowing
  // behaviour changes and this table does not, the strip's "What this affects"
  // modal will list the wrong sections — confidently, in the owner's own words,
  // which is worse than listing none. Re-audit this table against
  // templates/clinic.js whenever the prompt head changes. Issue 34 closed the
  // hazard that created legacy tenants; it did not change what they shadow.
  //
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

  // ══════════════════════════════════════════════════════════════════════════
  // THE TRUTH STRIP (spec §2.9)
  // ══════════════════════════════════════════════════════════════════════════

  const ICON_ALERT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';
  const ICON_INFO =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';

  // The reassurance clause is identical across every legacy-condition variant,
  // general or page-specific, so the two never read as different severities of
  // the same fact.
  const SAFE = 'Prantivo is fixing this — your saved changes are safe.';

  /**
   * Which condition holds, or null for none. Priority is the order of the
   * checks below and it is not arbitrary:
   *   1. a custom script is in use — the owner's edits are silently inert, the
   *      only condition where what they are doing right now is wasted effort;
   *   2. paused — the receptionist WAS answering and has stopped;
   *   3. not live — the receptionist has never answered yet, which is the
   *      expected state during setup and the least urgent of the three.
   *
   * `readiness` is the {status, run} payload the lifecycle control already
   * consumes. No verdict (never validated, no payload) → the legacy condition
   * cannot be evaluated and is skipped rather than guessed, exactly as
   * isShadowed does; the lifecycle conditions read `status`, which is always
   * present.
   *
   * `opts.embedded` — this page is a step inside the onboarding wizard's
   * iframe. Only the legacy condition may render there, and that exclusion is
   * the whole rule stated back to itself: during setup, "your receptionist
   * isn't answering calls yet" is not a divergence between system state and
   * the owner's expectation, it is a description of the task they are in the
   * middle of. The legacy condition stays because an owner in the wizard is the
   * single person about to waste the most effort on settings that are inert.
   *
   * @returns {null|{key,tone,icon,text,action}}
   */
  function stripFor(pageId, readiness, opts) {
    if (!readiness) return null;
    const run = readiness.run;
    const status = readiness.status;
    const embedded = !!(opts && opts.embedded);

    if (isShadowed(run) === true) {
      const page = pageNotice(pageId);
      // On a shadowed page the strip says what THIS page loses — the same claim
      // the inline notice used to make, in one line. Elsewhere it generalises.
      const text = page
        ? `${page.readonly ? 'Shown here but not in use' : 'Saved but not in use'}: ${page.what}. ${SAFE}`
        : `Some of your settings aren’t reaching your receptionist yet. ${SAFE}`;
      return {
        key: 'legacy:' + (page ? pageId : '*'),
        tone: 'warn',
        icon: ICON_ALERT,
        text,
        action: { label: 'What this affects', modal: 'affects' },
      };
    }

    if (embedded) return null; // see opts.embedded above

    if (status === 'paused') {
      return {
        key: 'paused',
        tone: 'warn',
        icon: ICON_ALERT,
        text: 'Your receptionist is paused. Calls and messages aren’t being answered.',
        // Fires the shell's existing delegated lifecycle handler — same action,
        // same confirmation dialog, same single request path as the header
        // control. The strip adds a second way to reach it, not a second
        // implementation of it.
        action: { label: 'Resume', lifecycle: 'resume' },
      };
    }

    // "Not live" covers `validated` as well as `draft` (spec §2.9's row is
    // *Not live*, not *draft*). A validated tenant has passed its checks and
    // still answers nothing until someone presses Go live — telling that owner
    // nothing would be the strip lying by omission on the one screen where the
    // remaining action is theirs.
    if (status === 'draft' || status === 'validated') {
      return {
        key: 'notlive',
        tone: 'info',
        icon: ICON_INFO,
        text: 'Your receptionist isn’t answering calls yet. Changes are saved and will apply when you go live.',
        // On Home the checks list IS "what's left" and it is already on screen;
        // a link to the page you are standing on is a dead affordance.
        action: pageId === 'home' ? null : { label: 'See what’s left', href: 'index.html' },
      };
    }

    return null;
  }

  /** The strip as HTML — '' when no condition holds, so a caller can assign it. */
  function stripHtml(pageId, readiness, opts) {
    const s = stripFor(pageId, readiness, opts);
    if (!s) return '';
    let action = '';
    if (s.action && s.action.href) {
      action = `<a class="ts__a" href="${esc(s.action.href)}">${esc(s.action.label)}</a>`;
    } else if (s.action && s.action.lifecycle) {
      action = `<button class="ts__a" type="button" data-lifecycle="${esc(s.action.lifecycle)}">${esc(s.action.label)}</button>`;
    } else if (s.action && s.action.modal) {
      action = `<button class="ts__a" type="button" data-ts-modal="${esc(s.action.modal)}">${esc(s.action.label)}</button>`;
    }
    return `<div class="ts ts--${esc(s.tone)}">${s.icon}<span>${esc(s.text)}</span>${action}</div>`;
  }

  /**
   * Body for the "What this affects" modal: every section a hand-written script
   * shadows, not merely the current page's.
   *
   * `hrefFor(pageId)` is supplied by the caller (shell.js owns the nav table) so
   * this file never carries a second copy of the portal's URLs — a link here
   * that disagreed with the sidebar would be its own small lie. A page with no
   * resolvable href renders as plain text rather than a dead link.
   *
   * The scope is NEVER guessed. It is read from SHADOWED, which is the audited
   * list; if a page is missing from that table this modal under-reports rather
   * than inventing an entry.
   */
  function affectsHtml(pageId, run, hrefFor, labelFor) {
    const rows = Object.keys(SHADOWED).map((id) => {
      const label = (labelFor && labelFor(id)) || id;
      const href = hrefFor && hrefFor(id);
      const link = href ? `<a class="lc-block__link" href="${esc(href)}">Open</a>` : '';
      return `<li class="lc-block">
        <div class="lc-block__body">
          <div class="lc-block__label">${esc(label)}</div>
          <div class="lc-block__sub">${esc(SHADOWED[id].what)}</div>
        </div>${link}
      </li>`;
    }).join('');

    // The page-specific notice leads when there is one: an owner who opened
    // this from Pricing wants their prices addressed first, then the rest.
    const lead = noticeHtml(pageId, run);
    return `${lead}<ul class="lc-blocks">${rows}</ul>`;
  }

  return {
    CHECK_NAME, SHADOWED, SURVIVES, TITLE, SAFE,
    isShadowed, pageNotice, noticeHtml, savedMessage,
    stripFor, stripHtml, affectsHtml,
  };
});
