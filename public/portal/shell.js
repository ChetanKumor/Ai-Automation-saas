/* ============================================================================
 * Portal shell (PORTAL-P1-S2) — the chrome shared by every portal page.
 *
 * Responsibilities:
 *   1. Render the sidebar nav (spec §4 order). Unbuilt pages render as
 *      visible-but-disabled "Soon" rows — never a 404, never a dead link.
 *   2. The session guard: fetch /portal/api/me on load. 401 → login.html. All
 *      tenant data comes from authed /portal/api endpoints; an unauthenticated
 *      visitor is bounced to login before any tenant data is requested.
 *   3. Logout, the mobile drawer toggle, and the state-aware header lifecycle
 *      control (display-only this session).
 *
 * No framework, no bundler. Pages set <body data-page="home"> and await
 * `Portal.me` (a promise resolving to { user, tenant }).
 * ========================================================================== */
'use strict';

(function () {
  // ── Inline icons (no external asset requests) ──────────────────────────────
  const I = {
    home:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
    building:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M10 21v-4h4v4"/></svg>',
    clock:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    tag:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 3 12V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.6Z"/><path d="M7.5 7.5h.01"/></svg>',
    doctor:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v6a6 6 0 0 0 12 0V3"/><path d="M6 3H4M18 3h2"/><path d="M12 15v3a4 4 0 0 0 8 0v-1"/><circle cx="20" cy="14" r="2"/></svg>',
    calendar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    help:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3.5"/><path d="M12 17h.01"/></svg>',
    file:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>',
    bot:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 14h.01M15 14h.01"/><path d="M2 13v2M22 13v2"/></svg>',
    shield:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    message: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/></svg>',
    bulb:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.9v.2h5v-.2c0-.8.4-1.5 1-1.9A6 6 0 0 0 12 3Z"/></svg>',
    burger:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    logout:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
    check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  };

  // Sidebar order = the owner's mental model (spec §4), NOT system structure.
  // Every row navigates: v1 has no placeholder entries. Documents (spec §5.8)
  // was deferred to v1.1 with FAQ-only knowledge shipping instead (spec §10
  // Phase 4 allows exactly that), so PORTAL-P6-S18 removed its permanently
  // disabled "Soon" row rather than freeze a promise into v1 — and the kb check
  // copy below no longer tells owners to "upload a document" they cannot upload.
  const NAV = [
    { id: 'home',        label: 'Home',            icon: I.home,     href: 'index.html' },
    { id: 'profile',     label: 'Clinic profile',  icon: I.building, href: 'clinic-profile.html' },
    { id: 'hours',       label: 'Hours & holidays', icon: I.clock,   href: 'hours.html' },
    { id: 'pricing',     label: 'Pricing',         icon: I.tag,      href: 'pricing.html' },
    { id: 'doctors',     label: 'Doctors',         icon: I.doctor,   href: 'doctors.html' },
    { id: 'booking',     label: 'Booking rules',   icon: I.calendar, href: 'booking-rules.html' },
    { id: 'faqs',        label: 'FAQs',            icon: I.help,     href: 'faqs.html' },
    { id: 'receptionist',label: 'Receptionist',    icon: I.bot,      href: 'receptionist.html' },
    { id: 'safety',      label: 'Safety & handoff', icon: I.shield,  href: 'safety.html' },
    { id: 'knows',       label: 'What it knows',   icon: I.bulb,     href: 'knows.html' },
    { id: 'test',        label: 'Test',            icon: I.message,  href: 'test.html' },
    { id: 'history',     label: 'History',         icon: I.history,  href: 'history.html' },
  ];

  // One-line meaning per lifecycle state (spec §5.1 status banner + header control).
  const LIFECYCLE = {
    draft:     { label: 'Draft',     control: 'golive' },
    validated: { label: 'Validated', control: 'golive' },
    live:      { label: 'Live',      control: 'live' },
    paused:    { label: 'Paused',    control: 'paused' },
  };

  // ── Owner-facing check copy map (spec §5.1) — THE single source ────────────
  // For every validation check name: an owner-recognisable label, who acts on
  // it, whether it gates go-live (material), and — for owner items — the
  // one-line fix plus the page that resolves it.
  //   actor:    'owner'    → the owner fixes it, on a portal page
  //             'system'   → derived from saved settings (no direct link)
  //             'operator' → Prantivo handles it (owner-visible, not owner-actioned)
  //   material: true  → counts toward the readiness ring and gates go-live
  //             false → advisory: shown subordinate, never scored
  //
  // Lives in the SHELL, not on Home (PORTAL-P6-S18): it used to exist twice —
  // Home's copy map and a parallel actor/material table here — which is a
  // standing drift risk between the ring and the header control. It also has to
  // be readable on EVERY page now, because a blocked go-live names its blocking
  // checks in a dialog that can be opened from anywhere. Home and the wizard's
  // Review step both read it through Portal.checkMeta().
  const CHECK_META = {
    'config.exists':   { label: 'Clinic details saved', actor: 'system', material: true },
    'config.schema':   { label: 'Clinic details are valid', actor: 'system', material: true },
    'prompt.renders':  { label: 'Receptionist instructions are ready', actor: 'system', material: true },
    'hours.sane':      { label: 'Clinic hours are set', actor: 'owner', material: true,
                         fix: 'Set your opening hours for each day', link: 'Hours & holidays', href: 'hours.html' },
    'numbers.e164':    { label: 'Escalation phone number added', actor: 'owner', material: true,
                         fix: 'Add an escalation phone number', link: 'Safety & handoff', href: 'safety.html' },
    'consent.lines':   { label: 'Call recording notice', actor: 'system', material: true },
    'kb.populated':    { label: 'Knowledge added', actor: 'owner', material: true,
                         fix: 'Add at least 5 FAQs so your receptionist can answer questions',
                         link: 'FAQs', href: 'faqs.html' },
    'kb.retrieval':    { label: 'Knowledge is searchable', actor: 'owner', material: true,
                         fix: 'Add at least 5 FAQs so your receptionist can answer questions',
                         link: 'FAQs', href: 'faqs.html' },
    'doctor.schedule': { label: 'Doctor and weekly hours added', actor: 'owner', material: true,
                         fix: 'Add a doctor and their weekly hours', link: 'Doctors', href: 'doctors.html' },
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
  // Unknown/future check → a safe, honest default (prettified name, material system):
  // a check we don't have copy for still counts against readiness rather than
  // silently vanishing from the ring.
  const checkMeta = (name) => CHECK_META[name] || {
    label: String(name).replace(/[._]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
    actor: 'system', material: true,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);

  function renderNav(activeId) {
    const nav = $('#nav');
    if (!nav) return;
    nav.innerHTML = NAV.map((item) => {
      if (item.soon) {
        return `<span class="nav__item nav__item--soon" aria-disabled="true" title="Coming soon">
          ${item.icon}<span>${item.label}</span><span class="nav__soon">Soon</span></span>`;
      }
      const active = item.id === activeId ? ' nav__item--active' : '';
      return `<a class="nav__item${active}" href="${item.href}"${active ? ' aria-current="page"' : ''}>
        ${item.icon}<span>${item.label}</span></a>`;
    }).join('');
  }

  // ── Eligibility (spec §5.13) ───────────────────────────────────────────────
  // Derive the Go-live control's state from a readiness run.
  //
  // `run.passed` is the ONLY eligibility signal, deliberately: it is exactly what
  // the backend chain concludes, so the button and the server can't disagree.
  // The blocker counts below are for the REASON copy when it's disabled, never
  // for the decision. (Counting skipped operator checks as "pending" would be
  // wrong — voice.config skips when voice is off, and the run still passes.)
  //
  // Two cases enable the button without a passing run, both honest:
  //   • no run at all — nothing has ever been checked, so pressing IS the check.
  //   • run.stale — config moved after the run, so its verdict has expired
  //     (the same freshness invariant lifecycleService enforces at activate).
  //     Without this an owner who fixes their last blocker would sit behind a
  //     permanently disabled button with no way to re-check.
  // Returns { eligible, blockers, operatorPending, stale, unknown }.
  function deriveGoLive(run) {
    if (!run || !run.checks) return { eligible: true, unknown: true, blockers: 0 };

    let blockers = 0;
    for (const c of run.checks) {
      const m = checkMeta(c.name);
      if (m.material && m.actor === 'owner' && c.severity === 'fail') blockers += 1;
    }
    const operatorPending = run.checks.some((c) => {
      const m = checkMeta(c.name);
      return m.material && m.actor === 'operator' && c.severity === 'fail';
    });

    if (run.stale) return { eligible: true, stale: true, blockers, operatorPending };
    if (run.passed) return { eligible: true, blockers: 0, operatorPending: false };
    return { eligible: false, blockers, operatorPending };
  }

  // State-aware header control — REAL as of PORTAL-P6-S18 (S2 shipped it
  // display-only). Renders the one lifecycle action available in each state:
  //   live            → "Live" badge + Pause
  //   paused          → "Paused" badge + Resume
  //   draft/validated → Go live, enabled per deriveGoLive above; when disabled,
  //                     the reason sits beside it rather than in a tooltip alone.
  // `hostEl` lets a caller render into an element other than the header's own
  // #lifecycle (the wizard's Review step surfaces the control inline —
  // PORTAL-P6-S16); defaults to #lifecycle.
  function renderLifecycle(status, opts, hostEl) {
    const host = hostEl || $('#lifecycle');
    if (!host) return;
    const meta = LIFECYCLE[status] || LIFECYCLE.draft;

    if (meta.control === 'live') {
      host.innerHTML =
        `<div class="golive">
          <span class="badge badge--ok"><span class="badge__dot"></span>Live</span>
          <button class="btn" type="button" data-lifecycle="pause">Pause</button>
        </div>`;
      return;
    }
    if (meta.control === 'paused') {
      host.innerHTML =
        `<div class="golive">
          <span class="badge badge--warn">Paused</span>
          <button class="btn btn--primary" type="button" data-lifecycle="resume">Resume</button>
        </div>`;
      return;
    }

    const st = opts || {};
    let reason = '';
    let title = 'Start answering calls and messages';
    if (!st.eligible) {
      if (st.blockers > 0) {
        reason = `<span class="golive__reason">${st.blockers} ${st.blockers === 1 ? 'item needs' : 'items need'} your attention</span>`;
        title = 'Finish the highlighted setup items, then go live';
      } else if (st.operatorPending) {
        reason = `<span class="golive__reason golive__reason--muted">Waiting on Prantivo</span>`;
        title = 'Prantivo completes the remaining go-live steps with you';
      } else {
        reason = `<span class="golive__reason">Setup checks haven’t passed yet</span>`;
        title = 'Setup checks haven’t passed yet';
      }
    }
    const dis = st.eligible ? '' : ' disabled aria-disabled="true"';
    host.innerHTML =
      `<div class="golive">${reason}<button class="btn btn--primary" type="button"
        data-lifecycle="activate"${dis} title="${title}">Go live</button></div>`;
  }

  // ── Lifecycle actions (PORTAL-P6-S18) ──────────────────────────────────────
  // The control is shell chrome, so its dialogs are built here and injected into
  // <body> on demand — no page HTML changes, and one implementation shared by
  // all 13 pages plus the wizard's Review step.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  // A modal that resolves true (confirmed) / false (dismissed). Reuses the
  // shared .modal component from tokens.css (S17's first user) — backdrop click,
  // Escape and the close button all dismiss. `confirmLabel: null` renders a
  // single acknowledge button (the blocked-go-live notice, which has no action).
  function dialog({ title, sub, body, confirmLabel, confirmClass, dismissLabel }) {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.className = 'modal-host';
      host.innerHTML =
        `<div class="modal__backdrop" data-dismiss></div>
         <div class="modal" role="dialog" aria-modal="true" aria-labelledby="lcTitle">
           <div class="modal__head">
             <div>
               <div class="modal__title" id="lcTitle">${esc(title)}</div>
               ${sub ? `<p class="modal__sub">${esc(sub)}</p>` : ''}
             </div>
             <button class="modal__close" type="button" data-dismiss aria-label="Close">${X_ICON}</button>
           </div>
           ${body ? `<div class="modal__body">${body}</div>` : ''}
           <div class="modal__foot">
             <button class="btn" type="button" data-dismiss>${esc(dismissLabel || 'Cancel')}</button>
             ${confirmLabel ? `<button class="btn ${confirmClass || 'btn--primary'}" type="button" data-confirm>${esc(confirmLabel)}</button>` : ''}
           </div>
         </div>`;
      document.body.appendChild(host);

      const done = (v) => {
        document.removeEventListener('keydown', onKey);
        host.remove();
        resolve(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      document.addEventListener('keydown', onKey);
      host.addEventListener('click', (e) => {
        if (e.target.closest('[data-dismiss]')) return done(false);
        if (e.target.closest('[data-confirm]')) return done(true);
      });
      const focusBtn = host.querySelector('[data-confirm]') || host.querySelector('[data-dismiss]');
      if (focusBtn) focusBtn.focus();
    });
  }

  // The refusal, in the owner's words. The server names the blocking checks by
  // NAME only (operator `detail` wording never crosses the wire); the label, the
  // fix line and the page link come from CHECK_META above — so this dialog and
  // Home's check rows always say the same thing about the same check.
  function blockedBody(blocking) {
    // Owner-actionable blockers first: this dialog answers "what do I do now?",
    // and burying the two things the owner CAN fix under four they can't is the
    // difference between a to-do list and a wall. Operator/system items keep
    // their catalog order underneath.
    const ordered = (blocking || []).slice().sort((a, b) =>
      (checkMeta(a.name).actor === 'owner' ? 0 : 1) - (checkMeta(b.name).actor === 'owner' ? 0 : 1));
    const rows = ordered.map((b) => {
      const m = checkMeta(b.name);
      const sub = m.actor === 'operator' ? m.note : m.fix;
      const link = (m.actor === 'owner' && m.href)
        ? `<a class="lc-block__link" href="${esc(m.href)}">${esc(m.link)}</a>` : '';
      return `<li class="lc-block">
        <div class="lc-block__body">
          <div class="lc-block__label">${esc(m.label)}</div>
          ${sub ? `<div class="lc-block__sub">${esc(sub)}</div>` : ''}
        </div>${link}
      </li>`;
    }).join('');
    return rows
      ? `<ul class="lc-blocks">${rows}</ul>`
      : `<p class="lc-note">Run the setup checks again once your details are complete.</p>`;
  }

  // POST a lifecycle action and reflect the result immediately. Returns the new
  // status, or null when the action was refused/failed (the dialog explains why).
  // Every call site re-renders from the RESPONSE's readiness, never from an
  // optimistic guess — a refused go-live must not leave the header claiming Live.
  async function runLifecycle(action, btn) {
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = action === 'pause' ? 'Pausing…' : 'Checking…'; }
    let res, data;
    try {
      res = await fetch(`/portal/api/lifecycle/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(action === 'pause' ? { confirm: true } : {}),
      });
      data = await res.json().catch(() => null);
    } catch (_) {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      await dialog({
        title: 'Couldn’t reach Prantivo',
        sub: 'Check your connection and try again — nothing changed.',
        dismissLabel: 'Close',
      });
      return null;
    }
    if (res.status === 401) { window.location.replace('login.html'); return null; }

    if (!res.ok) {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      // A refusal still carries fresh readiness — re-render so the control shows
      // the real current state rather than the one we optimistically left it in.
      if (data && data.readiness) applyLifecycle(data.readiness);
      if (data && data.code === 'NOT_READY') {
        await dialog({
          title: 'Not ready to go live yet',
          sub: 'These setup checks still need to pass before your receptionist can answer.',
          body: blockedBody(data.blocking),
          dismissLabel: 'Close',
        });
      } else {
        await dialog({
          title: 'Couldn’t make that change',
          sub: (data && data.error) || 'Something went wrong. Try again.',
          dismissLabel: 'Close',
        });
      }
      return null;
    }

    applyLifecycle(data.readiness, data.status);
    toast(data.status === 'live'
      ? 'Your receptionist is live'
      : 'Your receptionist is paused');
    return data.status;
  }

  // Re-render every surface that shows lifecycle state, from ONE payload.
  // Home listens for `portal:lifecycle` to refresh its banner + ring; pages that
  // don't listen still get the correct control because we render it here.
  function applyLifecycle(readiness, statusOverride) {
    const status = statusOverride || (readiness && readiness.status);
    if (!status) return;
    const opts = deriveGoLive(readiness && readiness.run);

    // Re-render EVERY mounted control, not just the header's: the wizard's
    // Review step mounts a second one in its own card (PORTAL-P6-S16), and an
    // action fired from either must leave both showing the new state.
    const hosts = new Set();
    const header = $('#lifecycle');
    if (header) hosts.add(header);
    document.querySelectorAll('.golive').forEach((g) => {
      if (g.parentElement) hosts.add(g.parentElement);
    });
    hosts.forEach((h) => renderLifecycle(status, opts, h));

    document.dispatchEvent(new CustomEvent('portal:lifecycle', {
      detail: { status, readiness },
    }));
  }

  // Minimal toast (tokens.css .toast). Pages that already own a toast keep
  // theirs; this is only for actions fired from the shell's own control.
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // One delegated handler for the whole document: the control is re-rendered
  // constantly (and by the wizard into its own host), so binding per-render
  // would leak listeners and miss re-renders.
  const CONFIRM = {
    activate: {
      title: 'Go live?',
      sub: 'Your receptionist will start answering calls and messages.',
      confirmLabel: 'Go live',
    },
    resume: {
      title: 'Resume your receptionist?',
      sub: 'Your receptionist will start answering calls and messages again.',
      confirmLabel: 'Resume',
    },
    pause: {
      title: 'Pause your receptionist?',
      sub: 'Paused: calls and messages are not answered by the receptionist.',
      confirmLabel: 'Pause',
      confirmClass: 'btn--danger',
    },
  };

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-lifecycle]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const action = btn.getAttribute('data-lifecycle');
    const copy = CONFIRM[action];
    if (!copy) return;
    if (await dialog(copy)) await runLifecycle(action, btn);
  });

  // Populate the header Go-live control on pages OTHER than Home (Home renders its
  // own, richer, from its readiness fetch, so we skip it to avoid a double render).
  // Pure chrome: any failure leaves the header empty and never blocks the page.
  async function renderHeaderLifecycle() {
    try { await window.Portal.me; } catch (_) { return; }
    if (activeId === 'home') return;
    try {
      const res = await fetch('/portal/api/readiness', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      renderLifecycle(data.status, deriveGoLive(data.run));
    } catch (_) { /* header stays empty — non-critical */ }
  }

  function wireChrome() {
    const app = $('#app');
    const openDrawer = (on) => app && app.classList.toggle('is-open', on);
    const burger = $('#burger');
    if (burger) burger.addEventListener('click', () => openDrawer(!app.classList.contains('is-open')));
    const scrim = $('.side__scrim');
    if (scrim) scrim.addEventListener('click', () => openDrawer(false));

    const logout = $('#logout');
    if (logout) logout.addEventListener('click', async () => {
      try { await fetch('/portal/api/logout', { method: 'POST' }); } catch (_) {}
      window.location.replace('login.html');
    });
  }

  // Session guard + brand fill. Returns { user, tenant }. 401 → login.html.
  async function bootstrap() {
    let res;
    try {
      res = await fetch('/portal/api/me', { headers: { Accept: 'application/json' } });
    } catch (_) {
      // Network failure — treat as unauthenticated rather than leak a shell.
      window.location.replace('login.html');
      throw new Error('offline');
    }
    if (res.status === 401) {
      window.location.replace('login.html');
      throw new Error('unauthenticated');
    }
    if (!res.ok) throw new Error('me failed: ' + res.status);
    const me = await res.json();
    const nameEl = $('#clinicName');
    if (nameEl && me.tenant && me.tenant.name) nameEl.textContent = me.tenant.name;
    return me;
  }

  // Embedded mode (PORTAL-P6-S16): this exact page, unmodified, loaded inside
  // the onboarding wizard's same-origin <iframe> (see wizard.js) so a step never
  // re-implements a page's form. The wizard supplies its OWN chrome (step
  // indicator, Back/Continue, page title) — this page's own sidebar/header would
  // just be redundant nested chrome, so it's hidden via CSS (tokens.css
  // `.is-embedded`) and its header go-live fetch is skipped (nothing renders it).
  // `window.top` throws cross-origin, never same-origin — safe without a try/catch.
  const embedded = window.self !== window.top;
  const app = document.getElementById('app');
  if (embedded && app) {
    app.classList.add('is-embedded');
    document.body.classList.add('is-embedded'); // lets tokens.css flatten the body background too
  }

  const activeId = document.body.getAttribute('data-page') || 'home';
  renderNav(activeId);
  wireChrome();

  // Kick auth off immediately; pages await Portal.me before requesting data.
  window.Portal = {
    icons: I,
    me: bootstrap(),
    renderLifecycle,
    deriveGoLive,
    checkMeta,     // the single owner-facing check copy map (Home + wizard read it)
    applyLifecycle,
    embedded,
  };

  // Header go-live control on non-home pages (Home renders its own from home.js).
  // Skipped when embedded — the header itself is hidden, so rendering into it
  // would be a wasted fetch.
  if (!embedded) renderHeaderLifecycle();
})();
