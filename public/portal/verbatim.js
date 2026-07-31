/* ============================================================================
 * Verbatim preview panel (spec §2.10, §1.3) — D4
 *
 * What the receptionist will actually SAY, in the clinic's own languages, while
 * the owner edits — rather than behind a separate preview page.
 *
 * READ-ONLY. No write path of any kind: no POST, no configService, no mutation
 * of any page's form. The only client storage is the collapse preference.
 *
 * ── Data source ────────────────────────────────────────────────────────────
 * There is NO prompt-preview endpoint under /portal/api/ — D4 Phase 0 walked all
 * 36 portal routes and none renders the composed prompt to an owner. The nearest
 * thing is GET /portal/api/knowledge-summary, which is owner-scoped and is what
 * knows.html already consumes. It deliberately does NOT return the rendered
 * composite (its own comment: "their returned prompt TEXT never crosses this
 * route") — it returns the assembled FACTS. So the panel is honest about what it
 * is: the greeting bubble shows the clinic's STORED greeting, not a rendered
 * turn, and the FACTS block shows what the receptionist has been told.
 *
 * This session added no route and no endpoint. The missing rendered-composite
 * preview is filed as a finding.
 *
 * ── Why the DOM is read at all ─────────────────────────────────────────────
 * The endpoint returns SAVED state. The panel's whole point is that it moves
 * while the owner types, so each mounted page contributes a small `live()`
 * reader that overlays the page's current form values on top of the saved
 * payload. Reading is all it does — it never writes a value back.
 * ========================================================================== */
'use strict';

(function () {
  // The nine mounts (spec §2.10: the eight editing pages plus Test). Never Home
  // — §1.4 segregates the two signatures, the readiness ring is Home's and this
  // is the product's, and they never share a screen.
  const MOUNTS = new Set([
    'profile', 'hours', 'pricing', 'doctors', 'booking',
    'faqs', 'receptionist', 'safety', 'test',
  ]);

  const PAGE = document.body.dataset.page;
  if (!MOUNTS.has(PAGE)) return;
  // The wizard embeds these same pages in a same-origin iframe (S16) with the
  // chrome hidden. A 360px ink panel inside a wizard step is not the wizard's
  // design, and the step is already narrow.
  if (window.Portal && window.Portal.embedded) return;

  const STORE_KEY = 'portal.verbatim.collapsed';
  const DEBOUNCE = 600;

  const ICON = {
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 17.5A1.9 1.9 0 0 0 4 20.4h16a1.9 1.9 0 0 0 1.6-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  };

  const LANG_LABEL = { te: 'Telugu', hi: 'Hindi', en: 'English' };
  const LANG_CLASS = { te: 'vp__te', hi: 'vp__hi', en: 'vp__en' };
  const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ₹ then the number, no space, Indian grouping (spec §2.2). U+20B9 now
  // resolves from 'Noto Sans' itself — F-V001 closed in this session's Phase 0
  // — so the sign and the digits beside it come from one family at one weight.
  const rupee = (n) => '₹' + Number(n).toLocaleString('en-IN');

  // 12-hour, lowercase meridiem, ':00' dropped (spec §2.2): 9:30 am, 8 pm.
  function clock(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return String(hhmm || '');
    const h = Number(m[1]);
    const mm = m[2];
    const mer = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return mm === '00' ? `${h12} ${mer}` : `${h12}:${mm} ${mer}`;
  }
  const range = (a, b) => `${clock(a)} – ${clock(b)}`;

  // hoursSummary() speaks 24h ("Mon–Sat 09:30–20:00; closed Sun"). The portal
  // shows 12h everywhere, so rewrite the times without re-deriving the summary.
  const humanSummary = (s) => String(s || '').replace(
    /(\d{1,2}:\d{2})–(\d{1,2}:\d{2})/g, (_, a, b) => range(a, b));

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const val = (sel) => { const el = $(sel); return el ? el.value.trim() : null; };

  // ── State ────────────────────────────────────────────────────────────────
  let summary = null;      // the server's saved reflection — the baseline
  let failed = false;
  let lang = null;
  let collapsed = readCollapsed();
  let timer = null;
  let lastKey = '';        // D3's lesson: an identical regeneration must NOT
                           // rewrite the live region, or a screen reader
                           // re-announces text that did not change.

  function readCollapsed() {
    try {
      const v = window.localStorage.getItem(STORE_KEY);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (_) { /* private mode — fall through to the default */ }
    // Default: docked open where there is room for it, a closed sheet below.
    // A sheet that opens over the form by default would be hostile.
    return !window.matchMedia('(min-width: 1280px)').matches;
  }
  function writeCollapsed(v) {
    try { window.localStorage.setItem(STORE_KEY, v ? '1' : '0'); } catch (_) {}
  }

  // ── Live overlay ─────────────────────────────────────────────────────────
  // Per page, the unsaved values currently in the form. Selectors mirror each
  // page's own collect(); they READ only. A page not listed here has no
  // typeable facts (doctors and FAQs mutate through row CRUD, which lands in
  // the DOM as a mutation and is picked up by the observer below).
  const LIVE = {
    profile() {
      return {
        name: val('#display_name'),
        address: val('#address'),
        landmark: val('#landmark'),
        phones: $$('.phone-row .input').map((i) => i.value.trim()).filter(Boolean),
        languages: $$('.lang-toggle[aria-pressed="true"]').map((b) => b.dataset.code),
      };
    },
    hours() {
      const days = {};
      $$('.day').forEach((row) => {
        const key = row.dataset.day;
        if (!key) return;
        const closed = !!(row.querySelector('.day__cb') || {}).checked;
        days[key] = closed ? { closed: true } : {
          closed: false,
          open: (row.querySelector('[data-role="open"]') || {}).value || '',
          close: (row.querySelector('[data-role="close"]') || {}).value || '',
        };
      });
      const holidays = $$('.holiday-row')
        .map((r) => ({
          date: (r.querySelector('.holiday__date') || {}).value || '',
          name: ((r.querySelector('.holiday__name') || {}).value || '').trim(),
        }))
        .filter((h) => h.date);
      return { days, holidays };
    },
    pricing() {
      return {
        consultation_fee: val('#consultation_fee'),
        follow_up_fee: val('#follow_up_fee'),
        emergency_fee: val('#emergency_fee'),
        treatments: $$('.tr')
          .filter((row) => row.dataset.archived !== '1')
          .map((row) => ({
            name: (row.querySelector('.tr__name') || {}).value || '',
            price: (row.querySelector('.tr__price') || {}).value || '',
            price_from: !!(row.querySelector('.tr__from') || {}).checked,
          })),
      };
    },
    booking() {
      return {
        slot_minutes: val('#slot_minutes'),
        cancellation_policy: val('#cancellation_policy'),
        reschedule_policy: val('#reschedule_policy'),
        walk_in_policy: val('#walk_in_policy'),
      };
    },
    receptionist() {
      const langs = (summary && summary.sections.receptionist.languages) || [];
      const greeting = {};
      langs.forEach((l) => { const el = $(`#greet-${l}`); if (el) greeting[l] = el.value.trim(); });
      return { display_name: val('#displayName'), greeting };
    },
    safety() {
      return {
        guidance: val('#emergency_guidance'),
        emergency_number: val('#emergency_number'),
        staff: $$('.phone-row .input').map((i) => i.value.trim()).filter(Boolean),
      };
    },
  };

  function live() {
    const fn = LIVE[PAGE];
    if (!fn) return {};
    try { return fn() || {}; } catch (_) { return {}; }
  }

  // ── The greeting bubble ──────────────────────────────────────────────────
  // The clinic's stored greeting in the selected language. Tenant-authored —
  // this file ships no Telugu or Devanagari of its own, deliberately: inventing
  // vernacular copy without a native reader is how a demo breaks.
  function greetingFor(code) {
    const r = summary.sections.receptionist;
    const l = live();
    const g = (PAGE === 'receptionist' && l.greeting && l.greeting[code] != null)
      ? l.greeting[code]
      : (r.greeting || {})[code];
    return (g || '').trim();
  }

  // The gloss is MANDATORY and never aria-hidden (spec §2.10). It is the
  // clinic's own English greeting, labelled as that rather than passed off as a
  // translation of the Telugu — the panel cannot translate and will not pretend
  // to. When there is no English greeting to check against, the panel says so;
  // an unverifiable preview is exactly the theatre the gloss rule exists to
  // prevent, and silence would hide it.
  function glossFor(code) {
    if (code === 'en') return null;
    const langs = summary.sections.receptionist.languages || [];
    if (langs.indexOf('en') === -1) {
      return { label: 'No English to check against',
        text: 'English isn’t switched on for your clinic, so there’s no English version of this line to compare.' };
    }
    const en = greetingFor('en');
    if (!en) {
      return { label: 'No English to check against',
        text: 'You haven’t written the English greeting yet. Add it on Receptionist and it will show here, so you can check this line reads right.' };
    }
    return { label: 'Your English greeting', text: en };
  }

  // ── FACTS ────────────────────────────────────────────────────────────────
  // What THIS page controls, plus the always-relevant pair (today's hours and
  // the consultation fee) that a patient asks for on any call (spec §2.10).
  const NONE = { none: true };
  const fact = (label, value) => ({ label, value });

  function pageFacts() {
    const s = summary.sections;
    const l = live();
    switch (PAGE) {
      case 'profile': {
        const langs = (l.languages && l.languages.length ? l.languages : s.clinic.languages) || [];
        return [
          fact('Clinic', l.name || s.clinic.name || NONE),
          fact('Address', l.address != null ? (l.address || NONE) : (s.clinic.address || NONE)),
          fact('Phone', (l.phones && l.phones.length ? l.phones : s.clinic.phone_numbers).join(', ') || NONE),
          fact('Speaks', langs.map((c) => LANG_LABEL[c] || c).join(', ') || NONE),
        ];
      }
      case 'hours': {
        const out = [fact('Open today', todayHours() || NONE)];
        const hol = (l.holidays || s.hours.holidays || []).length;
        out.push(fact('Holidays listed', hol ? String(hol) : NONE));
        return out;
      }
      case 'pricing': {
        const out = [
          fact('Consultation', money(l.consultation_fee, s.pricing.fees.consultation_fee)),
          fact('Follow-up', money(l.follow_up_fee, s.pricing.fees.follow_up_fee)),
          fact('Emergency', money(l.emergency_fee, s.pricing.fees.emergency_fee)),
        ];
        const tr = (l.treatments && l.treatments.length)
          ? l.treatments.filter((t) => t.name)
          : (s.pricing.treatments || []).map((t) => ({ name: t.name, price: t.price, price_from: t.price_from }));
        tr.slice(0, 6).forEach((t) => {
          const p = t.price === '' || t.price == null ? NONE
            : (t.price_from ? `from ${rupee(t.price)}` : rupee(t.price));
          out.push(fact(t.name, p));
        });
        if (tr.length > 6) out.push(fact(`+ ${tr.length - 6} more`, ''));
        return out;
      }
      case 'doctors': {
        const docs = s.doctors.doctors || [];
        if (!docs.length) return [fact('Bookable doctors', NONE)];
        return docs.slice(0, 5).map((d) =>
          fact(d.name, `${(d.days || []).length} days · ${range(d.start, d.end)}`));
      }
      case 'booking': {
        const slot = l.slot_minutes || null;
        return [
          fact('Appointment slots', slot ? `${slot} min` : humanSummary(s.booking.summary) || NONE),
          fact('Cancellations', textOr(l.cancellation_policy, (s.booking.policies || {}).cancellation_policy)),
          fact('Rescheduling', textOr(l.reschedule_policy, (s.booking.policies || {}).reschedule_policy)),
          fact('Walk-ins', textOr(l.walk_in_policy, (s.booking.policies || {}).walk_in_policy)),
        ];
      }
      case 'faqs': {
        const n = $$('.faq').length || s.faqs.count || 0;
        return [fact('Questions it can answer', n ? String(n) : NONE)];
      }
      case 'receptionist': {
        const r = s.receptionist;
        return [
          fact('Introduces itself as', (l.display_name != null ? l.display_name : r.display_name) || NONE),
          fact('Tone', r.tone === 'professional' ? 'Professional' : 'Warm'),
          fact('Speaks', (r.languages || []).map((c) => LANG_LABEL[c] || c).join(', ') || NONE),
        ];
      }
      case 'safety': {
        const sf = s.safety;
        return [
          fact('Emergency advice', textOr(l.guidance, sf.guidance)),
          fact('Number it gives out', (l.emergency_number != null ? l.emergency_number : sf.emergency_number) || NONE),
          fact('Offers a callback', sf.handoff_enabled ? 'Yes' : 'No'),
        ];
      }
      default:
        return [];
    }
  }

  // Today's hours. On hours.html the day rows are in the DOM, so the panel can
  // name TODAY exactly; elsewhere the endpoint gives only the week summary, so
  // the label changes to match what is actually being shown rather than
  // claiming a precision the data does not have.
  function todayHours() {
    const key = DAY_KEYS[new Date().getDay()];
    const l = live();
    const d = l.days && l.days[key];
    if (!d) return null;
    if (d.closed) return 'Closed';
    return d.open && d.close ? range(d.open, d.close) : null;
  }

  function money(liveVal, savedVal) {
    const v = liveVal != null && liveVal !== '' ? liveVal : savedVal;
    if (v == null || v === '') return NONE;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? rupee(n) : String(v);
  }
  function textOr(liveVal, savedVal) {
    const v = liveVal != null ? liveVal : savedVal;
    return v ? 'Written' : NONE;
  }

  // The always-relevant pair, appended on every page that does not already own
  // it — a patient asks these on any call regardless of what is being edited.
  function alwaysFacts() {
    const s = summary.sections;
    const out = [];
    if (PAGE !== 'hours') {
      out.push(fact('Hours', humanSummary(s.hours.summary) || NONE));
    }
    if (PAGE !== 'pricing') {
      out.push(fact('Consultation', s.pricing.empty ? NONE : money(null, s.pricing.fees.consultation_fee)));
    }
    return out;
  }

  // ── Warnings ─────────────────────────────────────────────────────────────
  // Only about what THIS page controls, so the field a warning names is always
  // on screen and focusing it is always possible. Portal-wide conditions are
  // the truth strip's job (D3) and are not repeated here.
  // `find` is a function, not a selector string, so a warning can point at the
  // FIRST OFFENDING row rather than the first row of that kind — `$('.tr__price')`
  // would focus whichever price input comes first in the document, which on a
  // page of six treatments is almost never the empty one the warning is about.
  function warnings() {
    const s = summary.sections;
    const l = live();
    const out = [];
    const add = (text, find) => out.push({ text, find });
    const byId = (id) => () => $('#' + id);

    if (PAGE === 'pricing') {
      const tr = (l.treatments || []).filter((t) => t.name);
      const unpriced = tr.filter((t) => !String(t.price || '').trim()).length;
      if (unpriced) {
        add(`${unpriced} treatment${unpriced === 1 ? ' has' : 's have'} no price — your receptionist won’t quote ${unpriced === 1 ? 'it' : 'them'}.`,
          () => $$('.tr').filter((r) => r.dataset.archived !== '1')
            .map((r) => r.querySelector('.tr__price'))
            .find((i) => i && i.value.trim() === '' && i.closest('.tr').querySelector('.tr__name').value.trim()));
      }
      if (!String(l.consultation_fee || '').trim()) {
        add('No consultation fee — the most-asked price on any call.', byId('consultation_fee'));
      }
    }
    if (PAGE === 'profile') {
      if (!(l.address || '').trim()) add('No address — your receptionist can’t tell a patient where you are.', byId('address'));
      if (!(l.phones || []).length) add('No phone number on file.', () => $('.phone-row .input'));
    }
    if (PAGE === 'receptionist') {
      (s.receptionist.languages || []).forEach((code) => {
        if (!greetingFor(code)) {
          add(`No ${LANG_LABEL[code] || code} greeting — it opens with a default line instead.`, byId('greet-' + code));
        }
      });
    }
    if (PAGE === 'safety' && !(l.guidance || '').trim()) {
      add('No clinic emergency advice — it falls back to “call emergency services”.', byId('emergency_guidance'));
    }
    if (PAGE === 'hours') {
      const days = l.days || {};
      const open = Object.keys(days).filter((k) => days[k] && !days[k].closed).length;
      if (Object.keys(days).length && !open) {
        add('Every day is marked closed.', () => $('.day .day__cb'));
      }
    }
    if (PAGE === 'booking' && !(l.cancellation_policy || '').trim()) {
      add('No cancellation policy — it offers to check with the clinic instead.', byId('cancellation_policy'));
    }
    if (PAGE === 'faqs' && !$$('.faq').length) {
      add('No FAQs yet — nothing specific from your clinic to draw on.', byId('addFaq'));
    }
    if (PAGE === 'doctors' && !(s.doctors.doctors || []).length) {
      add('No bookable doctor — it can’t offer an appointment.', byId('addDoctor'));
    }
    return out;
  }

  // ── Markup ───────────────────────────────────────────────────────────────
  function factRow(f) {
    const none = f.value === NONE;
    const v = none ? 'Not set' : f.value;
    return `<div class="vp__fact"><span class="vp__fact-l">${esc(f.label)}</span>` +
      `<span class="vp__fact-v${none ? ' vp__fact-v--none' : ''}">${esc(v)}</span></div>`;
  }

  function bodyHtml() {
    if (failed) {
      return '<p class="vp__empty">Couldn’t load the preview just now. Your settings are safe — reload the page to try again.</p>';
    }
    if (!summary) return '<p class="vp__empty">Loading…</p>';

    const greeting = greetingFor(lang);
    const cls = LANG_CLASS[lang] || 'vp__en';
    let html = '';

    if (greeting) {
      html += `<div class="vp__bub"><p class="${cls}" lang="${esc(lang)}">${esc(greeting)}</p></div>`;
    } else {
      html += `<div class="vp__bub"><p class="vp__empty">You haven’t written a ${esc(LANG_LABEL[lang] || lang)} greeting yet — ` +
        'your receptionist opens with a plain line naming your clinic.</p></div>';
    }

    const gloss = greeting ? glossFor(lang) : null;
    if (gloss) {
      html += `<p class="vp__gloss"><b>${esc(gloss.label)}</b>${esc(gloss.text)}</p>`;
    }

    html += '<hr class="vp__hr">';
    html += '<p class="vp__k">What it knows right now' +
      '<a href="knows.html">See all</a></p>';
    html += pageFacts().concat(alwaysFacts()).map(factRow).join('');

    const warns = warnings();
    if (warns.length) {
      html += '<hr class="vp__hr">';
      html += warns.map((w, i) =>
        `<button class="vp__warn" type="button" data-warn="${i}">${ICON.warn}<span>${esc(w.text)}</span></button>`
      ).join('');
    }
    return html;
  }

  // ── Mount ────────────────────────────────────────────────────────────────
  const panel = document.createElement('aside');
  panel.className = 'vp';
  panel.id = 'verbatim';
  // <aside> is a complementary landmark (spec §2.11). The sidebar is also an
  // <aside>, so this one is named to tell the two apart in a landmark list.
  panel.setAttribute('aria-label', 'Live preview');
  panel.innerHTML = `
    <div class="vp__prog" aria-hidden="true"></div>
    <button class="vp__grip" type="button" aria-expanded="false" aria-controls="vpBody">
      <span class="vp__grip-bar" aria-hidden="true"></span>
      <span class="vp__grip-row">
        <span class="vp__grip-te" id="vpGrip"></span>
        <span class="vp__grip-chev" aria-hidden="true">${ICON.chevron}</span>
      </span>
      <span class="vh" id="vpGripLabel">Live preview</span>
    </button>
    <button class="vp__rail" type="button" aria-expanded="false" aria-controls="vpBody">
      <span class="vp__dot" aria-hidden="true"></span>
      <span class="vp__rail-t">Preview</span>
    </button>
    <header class="vp__h">
      <span class="vp__lb"><span class="vp__dot" aria-hidden="true"></span>Live preview</span>
      <select class="vp__sel" id="vpLang" aria-label="Preview language"></select>
      <button class="vp__x" id="vpClose" type="button" aria-label="Collapse preview">${ICON.close}</button>
    </header>
    <div class="vp__b" id="vpBody">
      <div id="vpLive" aria-live="polite"></div>
    </div>
    <footer class="vp__f">
      <button class="vp__btn" type="button" disabled>${ICON.play}Hear it</button>
      <span class="vp__why">Needs a paid voice key and a live deploy</span>
      ${PAGE === 'test' ? '' : '<a class="vp__btn vp__btn--end" href="test.html">Open test →</a>'}
    </footer>`;

  const app = document.getElementById('app');
  if (!app) return;
  app.appendChild(panel);

  const progEl = $('.vp__prog', panel);
  const liveEl = $('#vpLive', panel);
  const langEl = $('#vpLang', panel);
  const gripEl = $('#vpGrip', panel);
  const railEl = $('.vp__rail', panel);
  const gripBtn = $('.vp__grip', panel);

  function applyCollapsed() {
    panel.classList.toggle('is-collapsed', collapsed);
    railEl.setAttribute('aria-expanded', String(!collapsed));
    gripBtn.setAttribute('aria-expanded', String(!collapsed));
  }
  function setCollapsed(v) {
    collapsed = v;
    writeCollapsed(v);
    applyCollapsed();
  }
  applyCollapsed();

  railEl.addEventListener('click', () => setCollapsed(false));
  gripBtn.addEventListener('click', () => setCollapsed(!collapsed));
  $('#vpClose', panel).addEventListener('click', () => setCollapsed(true));

  // Escape collapses the sheet / overlay (spec §2.11). Above 1280 the panel is
  // docked beside the content rather than over it, so Escape leaves it alone —
  // it is not covering anything and closing it would be a surprise.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || collapsed) return;
    if (window.matchMedia('(min-width: 1280px)').matches) return;
    setCollapsed(true);
    railEl.focus();
  });

  langEl.addEventListener('change', () => { lang = langEl.value; render(); });

  // Warnings focus the field they are about (spec §2.10).
  liveEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-warn]');
    if (!btn) return;
    const w = warnings()[Number(btn.dataset.warn)];
    if (!w) return;
    let target = null;
    try { target = w.find(); } catch (_) { return; }
    if (!target) return;
    if (!collapsed && !window.matchMedia('(min-width: 1280px)').matches) setCollapsed(true);
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
  });

  function renderLangOptions() {
    const langs = (summary && summary.sections.receptionist.languages) || [];
    if (!lang || langs.indexOf(lang) === -1) {
      lang = summary ? (summary.sections.receptionist.default_language || langs[0] || 'en') : 'en';
    }
    langEl.innerHTML = langs.map((c) =>
      `<option value="${esc(c)}"${c === lang ? ' selected' : ''}>${esc(LANG_LABEL[c] || c)}</option>`).join('');
    langEl.disabled = langs.length < 2;
  }

  function render() {
    if (!summary && !failed) return;
    renderLangOptions();

    const html = bodyHtml();
    // The key guard (D3). aria-live announces on CONTENT CHANGE, so rewriting
    // the region with identical markup would re-announce the whole preview on
    // every debounce tick — the owner's screen reader would talk over them
    // while they type. Compare first, write only on a real change.
    if (html !== lastKey) {
      lastKey = html;
      liveEl.innerHTML = html;
    }

    // The persistent sheet handle carries the greeting's first line, so even
    // collapsed the owner sees their receptionist's voice (spec §2.10).
    if (summary) {
      const g = greetingFor(lang);
      // The first LINE, not the first sentence. Splitting on sentence
      // punctuation leaves a two-syllable greeting word ("నమస్తే") on the
      // handle, which shows the owner nothing about how their receptionist
      // sounds. CSS truncates with an ellipsis at whatever the width allows.
      const first = (g.split('\n')[0] || '').trim() || g;
      gripEl.textContent = first || 'Live preview';
      if (g) gripEl.setAttribute('lang', lang); else gripEl.removeAttribute('lang');
    }
    panel.classList.remove('is-busy');
  }

  // Regenerates 600ms after typing stops. The progress line goes up
  // immediately; the previous value stays on screen the whole time.
  function schedule(delay) {
    panel.classList.add('is-busy');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; render(); }, delay == null ? DEBOUNCE : delay);
  }

  // Typing anywhere in the page's form.
  document.addEventListener('input', (e) => {
    if (panel.contains(e.target)) return;
    schedule();
  }, true);
  document.addEventListener('change', (e) => {
    if (panel.contains(e.target)) return;
    schedule();
  }, true);

  // A save. The page re-fills its form from the server's response, so the panel
  // re-reads the DOM and also re-fetches the summary — the server may have
  // normalised a value, and other sections' facts (which this page cannot see)
  // can move with it. If the save FAILED the re-fetch simply returns the
  // unchanged saved state and the overlay keeps showing what is in the form,
  // which is the honest result either way.
  document.addEventListener('submit', (e) => {
    if (panel.contains(e.target)) return;
    schedule(120);
    panel.classList.add('is-busy');
    window.setTimeout(refresh, 1000);
  }, true);

  // Doctors and FAQs change through row CRUD rather than typing, so their
  // updates land as a DOM mutation in the list rather than as an input event.
  //
  // Scoped to those two list containers ONLY, deliberately. Observing `.content`
  // instead looks more general and is actively wrong: every page's `input`
  // handler calls markDirty(), which writes the save-note text into the DOM, so
  // a broad observer turns each keystroke into a mutation and the fast path
  // preempts the 600ms debounce — the panel would then re-render on every
  // keystroke and the previous value would NOT stay readable, which is the one
  // behaviour §2.10 is explicit about.
  const list = $('#doctors') || $('#faqs');
  if (list && window.MutationObserver) {
    const mo = new MutationObserver(() => schedule(150));
    mo.observe(list, { childList: true, subtree: true });
  }

  // ── Load ─────────────────────────────────────────────────────────────────
  async function fetchSummary() {
    const res = await fetch('/portal/api/knowledge-summary', { headers: { Accept: 'application/json' } });
    if (res.status === 401) return null;   // the shell owns the redirect
    if (!res.ok) throw new Error('preview ' + res.status);
    return res.json();
  }

  async function refresh() {
    try {
      const data = await fetchSummary();
      if (data) { summary = data; failed = false; }
    } catch (_) { /* keep the last good preview on screen */ }
    render();
  }

  async function main() {
    try { await window.Portal.me; } catch (_) { return; } // shell redirected to login
    panel.classList.add('is-busy');
    try {
      const data = await fetchSummary();
      if (!data) return;
      summary = data;
    } catch (_) {
      failed = true;
    }
    render();
  }

  main();
})();
