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
    burger:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    logout:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
    check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  };

  // Sidebar order = the owner's mental model (spec §4), NOT system structure.
  // Only Home is built this session; the rest are inert "Soon" rows.
  const NAV = [
    { id: 'home',        label: 'Home',            icon: I.home,     href: 'index.html' },
    { id: 'profile',     label: 'Clinic profile',  icon: I.building, soon: true },
    { id: 'hours',       label: 'Hours & holidays', icon: I.clock,   soon: true },
    { id: 'pricing',     label: 'Pricing',         icon: I.tag,      soon: true },
    { id: 'doctors',     label: 'Doctors',         icon: I.doctor,   soon: true },
    { id: 'booking',     label: 'Booking rules',   icon: I.calendar, soon: true },
    { id: 'faqs',        label: 'FAQs',            icon: I.help,     soon: true },
    { id: 'documents',   label: 'Documents',       icon: I.file,     soon: true },
    { id: 'receptionist',label: 'Receptionist',    icon: I.bot,      soon: true },
    { id: 'safety',      label: 'Safety & handoff', icon: I.shield,  soon: true },
    { id: 'test',        label: 'Test',            icon: I.message,  soon: true },
    { id: 'history',     label: 'History',         icon: I.history,  soon: true },
  ];

  // One-line meaning per lifecycle state (spec §5.1 status banner + header control).
  const LIFECYCLE = {
    draft:     { label: 'Draft',     control: 'golive' },
    validated: { label: 'Validated', control: 'golive' },
    live:      { label: 'Live',      control: 'live' },
    paused:    { label: 'Paused',    control: 'paused' },
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

  // State-aware header control (display-only this session — no lifecycle writes).
  function renderLifecycle(status) {
    const host = $('#lifecycle');
    if (!host) return;
    const meta = LIFECYCLE[status] || LIFECYCLE.draft;
    if (meta.control === 'live') {
      host.innerHTML = `<span class="badge badge--ok"><span class="badge__dot"></span>Live</span>`;
    } else if (meta.control === 'paused') {
      host.innerHTML = `<span class="badge badge--warn">Paused</span>`;
    } else {
      // draft / validated → a Go live control, disabled this session.
      host.innerHTML = `<button class="btn btn--primary" disabled aria-disabled="true"
        title="Finish setup, then go live from here">Go live</button>`;
    }
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

  const activeId = document.body.getAttribute('data-page') || 'home';
  renderNav(activeId);
  wireChrome();

  // Kick auth off immediately; pages await Portal.me before requesting data.
  window.Portal = {
    icons: I,
    me: bootstrap(),
    renderLifecycle,
  };
})();
