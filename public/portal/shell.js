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

  // ── Sidebar IA (v2 spec §3.0) ──────────────────────────────────────────────
  // The order is still the owner's mental model (portal-v1 §4), NOT system
  // structure — only the GROUPING is new. A flat 12-item list was the single
  // clearest "internal admin panel" signal left in the portal.
  //
  // Groups are labels, not accordions: nothing collapses. With twelve items,
  // collapsing hides more than it helps.
  //
  // `today` is DELIBERATELY EMPTY. It is the reserved Tier 2 slot
  // (Conversations · Appointments · Patients, spec §0.4) and renders nothing
  // until it has items. Declaring it now is the whole point: it is what stops
  // Tier 2 forcing an IA rewrite, and it costs one array entry to reserve.
  const GROUPS = [
    { id: 'root',      label: null },              // Home — ungrouped, no header
    { id: 'today',     label: 'Today' },           // reserved for Tier 2; empty by design
    { id: 'clinic',    label: 'Your clinic' },
    { id: 'knowledge', label: 'What it knows' },
    { id: 'behaviour', label: 'How it behaves' },
    { id: 'check',     label: 'Check' },
  ];

  // Documents (spec §5.8) still does not exist. It is listed as an INERT `Soon`
  // row rather than hidden, per spec §3.0: "an owner who reads the nav learns
  // the product's shape". PORTAL-P6-S18 had removed this row to avoid freezing
  // a promise into v1; the v2 spec reverses that deliberately, and the row
  // navigates nowhere, so it can never 404.
  //
  // `knows` sits under CHECK, not under WHAT IT KNOWS. It is a read-only
  // summary the owner INSPECTS, not knowledge they edit — and in the v1 flat
  // order it already sat immediately adjacent to Test and History. Filing it
  // under WHAT IT KNOWS would also put a group header directly above an item
  // with the identical label.
  const NAV = [
    { id: 'home',        label: 'Home',             icon: I.home,     href: 'index.html',           group: 'root' },

    { id: 'profile',     label: 'Clinic profile',   icon: I.building, href: 'clinic-profile.html',  group: 'clinic' },
    { id: 'hours',       label: 'Hours & holidays', icon: I.clock,    href: 'hours.html',           group: 'clinic' },
    { id: 'pricing',     label: 'Pricing',          icon: I.tag,      href: 'pricing.html',         group: 'clinic' },
    { id: 'doctors',     label: 'Doctors',          icon: I.doctor,   href: 'doctors.html',         group: 'clinic' },
    { id: 'booking',     label: 'Booking rules',    icon: I.calendar, href: 'booking-rules.html',   group: 'clinic' },

    { id: 'faqs',        label: 'FAQs',             icon: I.help,     href: 'faqs.html',            group: 'knowledge' },
    { id: 'documents',   label: 'Documents',        icon: I.file,     soon: true,                   group: 'knowledge' },

    { id: 'receptionist',label: 'Receptionist',     icon: I.bot,      href: 'receptionist.html',    group: 'behaviour' },
    { id: 'safety',      label: 'Safety & handoff', icon: I.shield,   href: 'safety.html',          group: 'behaviour' },

    { id: 'knows',       label: 'What it knows',    icon: I.bulb,     href: 'knows.html',           group: 'check' },
    { id: 'test',        label: 'Test',             icon: I.message,  href: 'test.html',            group: 'check' },
    { id: 'history',     label: 'History',          icon: I.history,  href: 'history.html',         group: 'check' },
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
    // F-F001. This entry survives; the ROW does not — renderChecks omits this
    // check from the rendered list entirely (D3, spec §3.2). It is not a task an
    // owner can complete, and a checklist row implies otherwise. It surfaces as
    // the truth strip and only as the strip.
    //
    // The pass-state label used to read "Using the latest instruction format" —
    // affirmative, unconditional, and shown on precisely the clinics the check
    // was warning about. It now names what is being checked instead of asserting
    // the reassuring outcome, so neither verdict can read as a denial of the
    // other. `labelWarn` is unchanged.
    //
    // `material` stays FALSE on purpose. Making it material would NOT gate
    // go-live (deriveGoLive counts only `fail`, and this check is a `warn`) —
    // it would just add a row the ring scores as PASSED, making the ring less
    // honest, not more. The escalation this finding needs is the strip and the
    // qualified save, not a scoreboard entry.
    'tenant.legacy_prompt': { label: 'How your receptionist gets its instructions',
                              labelWarn: 'Following a custom script', actor: 'system', material: false },
  };
  // Unknown/future check → a safe, honest default (prettified name, material system):
  // a check we don't have copy for still counts against readiness rather than
  // silently vanishing from the ring.
  //
  // `severity` is optional: callers that only need actor/material keep passing
  // the name alone and get identical behaviour to before.
  const checkMeta = (name, severity) => {
    const m = CHECK_META[name] || {
      label: String(name).replace(/[._]/g, ' ').replace(/\b\w/g, (m2) => m2.toUpperCase()),
      actor: 'system', material: true,
    };
    if (severity === 'warn' && m.labelWarn) return Object.assign({}, m, { label: m.labelWarn });
    return m;
  };

  const $ = (sel, root) => (root || document).querySelector(sel);

  function navItemHtml(item, activeId) {
    if (item.soon) {
      return `<span class="nav__item nav__item--soon" aria-disabled="true" title="Coming soon">
        ${item.icon}<span>${item.label}</span><span class="nav__soon">Soon</span></span>`;
    }
    const active = item.id === activeId ? ' nav__item--active' : '';
    return `<a class="nav__item${active}" href="${item.href}"${active ? ' aria-current="page"' : ''}>
      ${item.icon}<span>${item.label}</span></a>`;
  }

  // Walks GROUPS in order and emits a `.grp` label above each group that has
  // items. A group with no items emits NOTHING — not an empty header, not a
  // stray gap — which is what lets `today` be declared and stay invisible.
  //
  // Each group is a role="group" wrapper named by its own label via
  // aria-labelledby, so the grouping a sighted owner sees is the grouping a
  // screen reader announces — a bare styled <div> would render the labels
  // decorative and flatten the nav back to twelve undifferentiated links.
  function renderNav(activeId) {
    const nav = $('#nav');
    if (!nav) return;
    nav.innerHTML = GROUPS.map((g) => {
      const items = NAV.filter((i) => i.group === g.id);
      if (!items.length) return '';
      const rows = items.map((i) => navItemHtml(i, activeId)).join('');
      if (!g.label) return `<div class="nav__grp" role="group">${rows}</div>`;
      const gid = 'grp-' + g.id;
      return `<div class="nav__grp" role="group" aria-labelledby="${gid}">
        <div class="grp" id="${gid}">${g.label}</div>${rows}</div>`;
    }).join('');
  }

  // ── Sidebar identity (spec §3.0) ───────────────────────────────────────────
  // Injected rather than added to thirteen HTML files, for the same reason the
  // nav and the shadow notice are: thirteen copies of a block cannot be kept
  // from drifting, and a page's markup should carry no placeholder for chrome
  // it does not own.
  //
  // The owner EMAIL the spec draws here is not available: GET /portal/api/me
  // returns `user: { id, role }` and no address (routes.js:171). Surfacing it
  // needs a route change, which this session does not make — so the second line
  // states the ROLE, which is true and already on the page. Recorded as a
  // finding rather than fabricated or silently dropped.
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '·';
    return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]).toUpperCase();
  }

  function renderIdentity(me) {
    const foot = $('.side__foot');
    if (!foot || foot.querySelector('.who')) return;
    const name = (me.tenant && me.tenant.name) || 'Your clinic';
    const role = (me.user && me.user.role) || '';
    const who = document.createElement('div');
    who.className = 'who';
    who.innerHTML =
      `<span class="av" aria-hidden="true">${esc(initials(name))}</span>
       <span class="who__body">
         <span class="who__name">${esc(name)}</span>
         <span class="who__sub">${esc(role ? role[0].toUpperCase() + role.slice(1) : 'Signed in')}</span>
       </span>`;
    foot.insertBefore(who, foot.firstChild);

    const avatar = $('#topUser');
    if (avatar) {
      avatar.textContent = initials(name);
      avatar.setAttribute('title', `${name} · signed in as ${role || 'owner'}`);
      avatar.hidden = false;
    }
  }

  // ── Top bar chrome (spec §3.0) ─────────────────────────────────────────────
  // Order: burger · breadcrumb (nested only) · spacer · lifecycle · ⌘K · avatar.
  // Injected into the existing `.top` so no page markup changes.
  //
  // The BREADCRUMB slot renders nothing today. The spec's only nested view is
  // History → snapshot, which is a MODAL rather than a route, so no portal page
  // is currently nested. The slot exists so the first genuinely nested screen
  // does not have to re-cut the top bar; it is the same reservation `today` is.
  const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>';

  function buildTopBar() {
    const top = $('.top');
    if (!top || top.querySelector('.kbd')) return;

    const spacer = top.querySelector('.top__spacer');
    const crumb = document.createElement('nav');
    crumb.className = 'crumb';
    crumb.id = 'crumb';
    crumb.setAttribute('aria-label', 'Breadcrumb');
    crumb.hidden = true; // nothing is nested yet — see above
    if (spacer) top.insertBefore(crumb, spacer);

    // Mac shows ⌘K, everything else Ctrl K. Reading the real platform beats
    // showing a Mac glyph to the Windows majority of Indian clinic owners.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const kbd = document.createElement('button');
    kbd.type = 'button';
    kbd.className = 'kbd';
    kbd.id = 'cmdkHint';
    kbd.setAttribute('aria-label', `Search pages (${mac ? 'Command' : 'Control'} K)`);
    kbd.innerHTML = `${SEARCH_ICON}<span>${mac ? '⌘' : 'Ctrl'} K</span>`;
    top.appendChild(kbd);

    const user = document.createElement('span');
    user.className = 'top__u';
    user.id = 'topUser';
    user.hidden = true; // unhidden by renderIdentity once the name is known
    top.appendChild(user);
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
  // Presentation is v2 spec §3.0's four-row table. The BEHAVIOUR is unchanged
  // from PORTAL-P6-S18: same `data-lifecycle` actions, same eligibility source,
  // same confirmation dialogs. Only what the owner sees changed.
  //
  // The important change is the ineligible case. It used to be a DISABLED
  // primary button with the reason beside it — a control whose most prominent
  // element is one the owner cannot press, and which offers no way to reach the
  // thing blocking it. It is now a status object that LINKS to Home, where the
  // blocking items actually live. A dead button is not a state; it is a dead end.
  //
  // `.golive` stays the wrapper class: applyLifecycle finds every mounted
  // control with it (including the wizard's second one, PORTAL-P6-S16), and
  // wizard.css keys `.wiz__golive:empty` off it.
  function renderLifecycle(status, opts, hostEl) {
    const host = hostEl || $('#lifecycle');
    if (!host) return;
    const meta = LIFECYCLE[status] || LIFECYCLE.draft;

    if (meta.control === 'live') {
      host.innerHTML =
        `<div class="golive">
          <span class="lc lc--live"><span class="dot dot--live"></span>Live</span>
          <button class="btn" type="button" data-lifecycle="pause">Pause</button>
        </div>`;
      return;
    }
    if (meta.control === 'paused') {
      host.innerHTML =
        `<div class="golive">
          <span class="lc lc--paused"><span class="dot"></span>Paused</span>
          <button class="btn btn--primary" type="button" data-lifecycle="resume">Resume</button>
        </div>`;
      return;
    }

    const st = opts || {};
    if (st.eligible) {
      host.innerHTML =
        `<div class="golive"><button class="btn btn--primary" type="button"
          data-lifecycle="activate" title="Start answering calls and messages">Go live</button></div>`;
      return;
    }

    // Ineligible. The count names what is left; "0 left" is never rendered —
    // when nothing is owner-actionable the remaining work is Prantivo's, and
    // saying so is more use than a zero.
    let tail = '';
    let title = 'Setup checks haven’t passed yet';
    if (st.blockers > 0) {
      tail = `<span class="lc__ct">${st.blockers} left</span>`;
      title = 'Finish the highlighted setup items, then go live';
    } else if (st.operatorPending) {
      tail = `<span class="lc__ct">With Prantivo</span>`;
      title = 'Prantivo completes the remaining go-live steps with you';
    }
    host.innerHTML =
      `<div class="golive"><a class="lc lc--draft" href="index.html" title="${title}">
        <span class="dot"></span>Not live${tail}</a></div>`;
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
    setBusy(btn, true, action === 'pause' ? 'Pausing…' : 'Checking…');
    let res, data;
    try {
      res = await fetch(`/portal/api/lifecycle/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(action === 'pause' ? { confirm: true } : {}),
      });
      data = await res.json().catch(() => null);
    } catch (_) {
      setBusy(btn, false);
      await dialog({
        title: 'Couldn’t reach Prantivo',
        sub: 'Check your connection and try again — nothing changed.',
        dismissLabel: 'Close',
      });
      return null;
    }
    if (res.status === 401) { window.location.replace('login.html'); return null; }

    if (!res.ok) {
      setBusy(btn, false);
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

  // ── Error ladder, layer 3 (spec §2.9) ──────────────────────────────────────
  // The page could not load at all: alert icon, what failed, one muted line, one
  // retry. Ten pages were each rendering this as a bare grey sentence inside the
  // loading placeholder — the same string ten times, and the only state in the
  // portal with no way out of it except the browser's own reload button.
  //
  // The other three layers are untouched and stay where they are: field errors
  // inline (layer 1), the card banner on a failed save (layer 2), and the 401
  // redirect to sign-in (layer 4). This adds a shared implementation of one
  // layer; it does not collapse the ladder.
  //
  // Retry RELOADS rather than re-running the page's own loader: every one of
  // these pages derives its whole form from a single GET, so a partial recovery
  // could leave half the page describing one response and half another.
  const ALERT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';

  function pageError(host, what) {
    const el = typeof host === 'string' ? document.getElementById(host) : host;
    if (!el) return;
    el.hidden = false;
    el.innerHTML =
      `<div class="pg-err">
        <div class="pg-err__i">${ALERT_ICON}</div>
        <div class="pg-err__t">Couldn’t load ${esc(what)}</div>
        <p class="pg-err__d">Your settings are safe. This is a problem on our side.</p>
        <button class="btn btn--primary" type="button" data-page-retry>Try again</button>
      </div>`;
    const btn = el.querySelector('[data-page-retry]');
    if (btn) btn.addEventListener('click', () => window.location.reload());
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

  // One readiness fetch per page load, shared by the header control and the
  // shadow notice below so adding the notice costs no extra round trip. Home is
  // excluded at both call sites — it runs its own richer fetch in home.js.
  // Never rejects: a failure resolves to null and each consumer stays quiet.
  let readinessP = null;
  function readinessOnce() {
    if (!readinessP) {
      readinessP = fetch('/portal/api/readiness', { headers: { Accept: 'application/json' } })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
    }
    return readinessP;
  }

  // Populate the header Go-live control on pages OTHER than Home (Home renders its
  // own, richer, from its readiness fetch, so we skip it to avoid a double render).
  // Pure chrome: any failure leaves the header empty and never blocks the page.
  async function renderHeaderLifecycle() {
    try { await window.Portal.me; } catch (_) { return; }
    if (activeId === 'home') return;
    const data = await readinessOnce();
    if (!data) return;
    renderLifecycle(data.status, deriveGoLive(data.run));
  }

  // ── Truth strip (spec §2.9, F-F001) ────────────────────────────────────────
  // A full-width band between the top bar and the page header, rendered ONLY
  // when system state and the owner's reasonable expectation diverge. The
  // conditions and every word of copy live in shadow-notice.js; this places the
  // result and wires its two actions.
  //
  // It REPLACES the inline per-page notice this function used to insert into
  // `.content` after `.page-head`. One component, not two: a global strip built
  // alongside the working per-page notice would have put two amber blocks on
  // every shadowed page reporting one condition. The per-page copy did not go
  // away — it is what the strip says when it is standing on a shadowed page,
  // and its full text is the lead of the "What this affects" modal.
  //
  // Injected rather than added to twelve HTML files so it can never drift page
  // to page, and so a page's markup carries no dead placeholder on the clinics
  // (the overwhelming majority) where no condition holds.

  // The live region is mounted EMPTY and synchronously, before any fetch. A
  // screen reader announces a polite region when its contents change, not when
  // an already-populated region is inserted — so filling this node later is what
  // produces the single announcement. Mounting it pre-filled would produce none.
  function mountStripHost() {
    const main = $('.main');
    const top = $('.top');
    if (!main || !top || $('#truthStrip')) return null;
    const host = document.createElement('div');
    host.id = 'truthStrip';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    main.insertBefore(host, top.nextSibling);
    return host;
  }

  // `lastStripKey` is the re-announcement guard. Every caller below re-runs on
  // lifecycle changes and after saves; without the key an identical strip would
  // be rewritten into a live region each time and announced again. undefined =
  // never rendered, null = rendered as absent.
  let lastStripKey;
  function applyTruthStrip(readiness) {
    const SN = window.ShadowNotice;
    const host = $('#truthStrip') || mountStripHost();
    if (!SN || !host) return;
    const opts = { embedded };
    const s = SN.stripFor(activeId, readiness, opts);
    const key = s ? s.key : null;
    if (key === lastStripKey) return; // same condition — do not re-announce
    lastStripKey = key;
    host.innerHTML = s ? SN.stripHtml(activeId, readiness, opts) : '';
  }

  // Runs EVEN WHEN EMBEDDED, unlike the header control: an owner going through
  // the onboarding wizard is the single person about to waste the most effort,
  // so the wizard's iframed steps are the last place to suppress this.
  async function renderShadowNotice() {
    if (!window.ShadowNotice) return;
    mountStripHost();
    try { await window.Portal.me; } catch (_) { return; }
    // Home fetches its own readiness (a richer render) and hands it here via
    // `portal:readiness` — see the listener below. Awaiting readinessOnce() on
    // Home too would be the second round trip this strip is required not to
    // make, and shell.js is asserted to hold exactly one readiness fetch.
    if (activeId === 'home') return;
    applyTruthStrip(await readinessOnce());
  }

  // Two ways the strip learns the state, neither of them a request of its own:
  //   • `portal:readiness` — Home dispatching the payload it already fetched.
  //   • `portal:lifecycle` — any Pause/Resume/Go-live response, from any page.
  // A pause updating the strip with no network call is the point.
  document.addEventListener('portal:readiness', (e) => applyTruthStrip(e.detail));
  document.addEventListener('portal:lifecycle', (e) => {
    const d = e.detail || {};
    if (!d.readiness) return;
    applyTruthStrip({ status: d.status || d.readiness.status, run: d.readiness.run });
  });

  // "What this affects" — the strip's one modal. Lists every section a
  // hand-written script shadows, with the nav's OWN hrefs and labels passed in,
  // so this dialog can never link somewhere the sidebar doesn't.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ts-modal]');
    if (!btn) return;
    e.preventDefault();
    const SN = window.ShadowNotice;
    if (!SN) return;
    const data = await readinessOnce();
    const navItem = (id) => NAV.find((n) => n.id === id) || {};
    // Titled from the BUTTON, not from SN.TITLE — the notice inside the body
    // already carries SN.TITLE as its own heading, and using it twice made the
    // dialog open with the same sentence stacked on itself.
    await dialog({
      title: 'What this affects',
      sub: 'Every setting your receptionist isn’t reading yet. Everything else works normally.',
      body: SN.affectsHtml(activeId, data && data.run,
        (id) => navItem(id).href, (id) => navItem(id).label),
      dismissLabel: 'Close',
    });
  });

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

    // Page header gains a shadow once the content has scrolled under it. Only
    // meaningful where the header is sticky (mobile), and cheap enough that
    // gating it on a media query would cost more than it saves.
    const head = $('.page-head');
    if (head) {
      const onScroll = () => head.classList.toggle('is-stuck', window.scrollY > 4);
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    mountSaveBar();
  }

  // ── Sticky save bar (spec §2.9), mobile only ───────────────────────────────
  //
  // THE SAVE PATH IS NOT TOUCHED. This function reads two things and writes
  // neither: the dirty class the page already puts on #saveNote, and the busy
  // state setBusy() already puts on #saveBtn. Its own Save forwards a click to
  // the real footer button — which is type="submit" inside the page's <form>, so
  // the page's existing submit handler runs and `fill(data.section)` still
  // refills the SERVER's returned value. There is one save path; this is a
  // second button pointing at it, not a second implementation.
  //
  // MOUNTED BY FEATURE DETECT, not a page allowlist: a single #saveNote and
  // #saveBtn inside one .card__foot. That is exactly the six single-form writing
  // pages (clinic-profile, hours, pricing, booking-rules, receptionist, safety).
  //
  // NOT on Doctors and FAQs, deliberately. Those write a .save-note per CARD —
  // one doctor, one FAQ, each with its own save button — so a single global Save
  // has no referent. Their footers also sit directly beneath the fields just
  // edited, which is the condition this bar exists to fix.
  //
  // Discard is a reload. The page refetches and refills from the server, which
  // IS what discarding unsaved changes means, and it needs no knowledge of any
  // page's baseline snapshot.
  function mountSaveBar() {
    if (embedded) return;
    const note = $('#saveNote');
    const btn = $('#saveBtn');
    if (!note || !btn || !note.closest('.card__foot')) return;

    const bar = document.createElement('div');
    bar.className = 'save-bar';
    bar.id = 'stickySave';
    bar.hidden = true;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Unsaved changes');
    bar.innerHTML =
      '<button class="btn btn--ghost" id="stickyDiscardBtn" type="button">Discard</button>' +
      '<button class="btn btn--primary save-bar__save" id="stickySaveBtn" type="button">Save changes</button>';
    document.body.appendChild(bar);

    const save = bar.querySelector('#stickySaveBtn');
    save.addEventListener('click', () => btn.click());
    bar.querySelector('#stickyDiscardBtn').addEventListener('click', () => window.location.reload());

    // The bar exists only while the card is dirty. `has-save-bar` is what pads
    // the scroll container, so the padding appears and disappears with the bar
    // rather than reserving 68px of a phone viewport permanently.
    const sync = () => {
      const dirty = note.classList.contains('save-note--dirty');
      bar.hidden = !dirty;
      document.body.classList.toggle('has-save-bar', dirty);
    };
    new MutationObserver(sync).observe(note, { attributes: true, attributeFilter: ['class'] });

    // Mirror the real button's busy state so the bar cannot be pressed a second
    // time mid-save. Observation only — setBusy is called on the footer button
    // by the page, never from here.
    new MutationObserver(() => setBusy(save, btn.hasAttribute('aria-busy')))
      .observe(btn, { attributes: true, attributeFilter: ['aria-busy'] });

    sync();
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
    renderIdentity(me);
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
  // Skipped when embedded: the whole `.top` is `display:none` inside the wizard
  // iframe, so building its controls would only add hidden nodes and a second
  // ⌘K listener competing with the parent frame's.
  if (!embedded) buildTopBar();
  wireChrome();

  // Kick auth off immediately; pages await Portal.me before requesting data.
  // The save confirmation for a config page (F-F001). "Saved · v3" alone is the
  // false success A-008 names: on an affected clinic the value is stored and
  // versioned, and the receptionist will never say it. Reads the verdict from
  // the SAVE RESPONSE'S own readiness payload — the freshest one in existence at
  // that instant — and degrades to the plain message whenever shadow-notice.js
  // isn't loaded or the verdict isn't known.
  function savedMessage(version, readiness) {
    const SN = window.ShadowNotice;
    if (!SN) return 'Saved · v' + version;
    return SN.savedMessage(version, readiness && readiness.run, activeId);
  }

  // ── Toast (spec §2.9) ──────────────────────────────────────────────────────
  //
  // ONE implementation, shared. Ten page scripts each carried their own copy of
  // this function and all ten did the same wrong thing: an error toast faded
  // itself out after 2.6 seconds. That is a message the owner can miss entirely,
  // and the thing they missed is that their change did not save — the failure
  // A-008 is about, in a different costume.
  //
  // Success: role="status", clears itself after 4s. Error: role="alert" and it
  // STAYS until dismissed. A toast never carries a validation error; those are
  // inline on the field that caused them (see .field__error).
  const T_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const T_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>';

  // ── Busy button (spec §2.9) ────────────────────────────────────────────────
  //
  // `Save changes` → `Saving…` with a spinner in the icon slot. The WIDTH IS
  // HELD: the two labels are ~40px apart, so without pinning it the button
  // shrinks mid-save and the card footer twitches at the exact moment the owner
  // is watching to see whether their edit took.
  //
  // DEVIATION FROM SPEC, DELIBERATE. §2.9 says a busy button is "non-interactive
  // but not disabled, so it keeps focus". Every save path in this portal uses
  // `disabled` as its ONLY double-submit guard — there is no re-entry flag — so
  // dropping it here would trade a real duplicate POST for a focus nicety.
  // `aria-busy` is added and `disabled` stays until a guard exists to replace
  // it. Recorded rather than silently resolved in either direction.
  const SPIN = '<svg class="btn__spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 2a10 10 0 0 1 10 10" opacity=".95"/><circle cx="12" cy="12" r="10" opacity=".28"/></svg>';

  function setBusy(btn, on, busyLabel) {
    if (!btn) return;
    if (on) {
      if (btn.dataset.restLabel === undefined) btn.dataset.restLabel = btn.textContent;
      btn.style.minWidth = btn.getBoundingClientRect().width + 'px';
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      btn.innerHTML = SPIN + esc(busyLabel || 'Saving…');
      return;
    }
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
    if (btn.dataset.restLabel !== undefined) {
      btn.textContent = btn.dataset.restLabel;
      delete btn.dataset.restLabel;
    }
    btn.style.minWidth = '';
  }

  function toast(message, ok) {
    const host = $('#toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast toast--' + (ok ? 'ok' : 'err');
    el.setAttribute('role', ok ? 'status' : 'alert');
    el.innerHTML = (ok ? T_OK : T_ERR) +
      `<div class="toast__body">${esc(message)}</div>` +
      (ok ? '' : `<button class="toast__x" type="button" aria-label="Dismiss">${X_ICON}</button>`);
    el.style.transition = 'opacity var(--dur-2) var(--ease-in-out), transform var(--dur-2) var(--ease-in-out)';
    host.appendChild(el);

    // Max 3 stacked; a fourth replaces the oldest, so a burst of failures cannot
    // grow a column that covers the form the owner is trying to fix.
    while (host.children.length > 3) host.removeChild(host.firstElementChild);

    if (!ok) {
      el.querySelector('.toast__x').addEventListener('click', () => el.remove());
      return;
    }
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 4000);
    setTimeout(() => el.remove(), 4350);
  }

  window.Portal = {
    icons: I,
    me: bootstrap(),
    renderLifecycle,
    deriveGoLive,
    checkMeta,     // the single owner-facing check copy map (Home + wizard read it)
    applyLifecycle,
    applyTruthStrip,   // Home calls this with the payload IT fetched — never a second request
    readinessOnce,     // the one shared readiness promise (non-Home pages)
    pageError,         // error ladder layer 3, shared by every page's loader
    savedMessage,
    toast,             // the one toast — errors persist, successes clear (§2.9)
    setBusy,           // busy button: spinner, aria-busy, width held (§2.9)
    embedded,
    activeId,
    // The command palette navigates the SAME list the sidebar renders, from the
    // same array — so a page can never be reachable from one and not the other.
    nav: NAV,
    groups: GROUPS,
  };

  // Header go-live control on non-home pages (Home renders its own from home.js).
  // Skipped when embedded — the header itself is hidden, so rendering into it
  // would be a wasted fetch.
  if (!embedded) renderHeaderLifecycle();
  renderShadowNotice(); // page content, not chrome — runs embedded too
})();
