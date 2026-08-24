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
    // The tab's indicator points LEFT, which is the direction the panel comes
    // from. A chevron is not a label and never stands alone here — it sits
    // beside the receptionist's name (see the rail markup below).
    chevLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  };

  // The copy this panel and Home's greeting block SHARE (greeting-copy.js).
  // Every string it holds was this file's; it holds them so the two surfaces
  // cannot describe the same greeting two different ways.
  const GC = window.GreetingCopy;
  const LANG_LABEL = GC.LANG_LABEL;
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
  // The three answers and their wording moved to greeting-copy.js verbatim when
  // Home grew a greeting block that has to give the same ones. The branch order
  // is unchanged and `greetingFor` is still passed as a THUNK, so the
  // English-not-enabled arm still never resolves a greeting it does not read.
  function glossFor(code) {
    const langs = summary.sections.receptionist.languages || [];
    return GC.glossFor(code, langs, () => greetingFor('en'));
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
      html += `<div class="vp__bub"><p class="vp__empty">${esc(GC.noGreeting(lang))}</p></div>`;
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
    <button class="vp__rail" type="button" aria-expanded="false" aria-controls="vpBody"
      data-unnamed aria-label="Your receptionist — open the preview">
      <span class="vp__dot" aria-hidden="true"></span>
      <span class="vp__rail-t">Your receptionist</span>
      <span class="vp__rail-chev" aria-hidden="true">${ICON.chevLeft}</span>
      <span class="vp__rail-peek" aria-hidden="true"></span>
    </button>
    <header class="vp__h">
      <span class="vp__lb" id="vpLabel"><span class="vp__dot" aria-hidden="true"></span>Live preview</span>
      <span class="vh" id="vpLangLbl">Preview language</span>
      <button class="vp__sel" id="vpLang" type="button" role="combobox"
        aria-labelledby="vpLangLbl vpLang" aria-controls="vpLangList" aria-expanded="false">
        <span class="vp__sel-in">
          <span class="vp__sel-v"></span>
          <span class="vp__sel-c" aria-hidden="true">${ICON.chevron}</span>
        </span>
      </button>
      <button class="vp__x" id="vpClose" type="button" aria-label="Collapse preview">${ICON.close}</button>
    </header>
    <div class="vp__opts" id="vpLangList" role="listbox" aria-labelledby="vpLangLbl" hidden></div>
    <p class="vp__note" id="vpLangWhy" hidden>Only one language is switched on. Add another on Clinic profile to preview it here.</p>
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
  const langValEl = $('.vp__sel-v', panel);
  const listEl = $('#vpLangList', panel);
  const gripEl = $('#vpGrip', panel);
  const railEl = $('.vp__rail', panel);
  const railName = $('.vp__rail-t', panel);
  const railPeek = $('.vp__rail-peek', panel);
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

  // Press feedback on POINTER-DOWN, not click. `click` fires after the finger
  // lifts, which is 100-300ms of a control that looks inert while it is being
  // pressed. The class only scales and fades (see verbatim.css) — no layout —
  // and it is cleared on every way a press can end, including the one where the
  // pointer leaves the control and no click ever arrives.
  [railEl, gripBtn].forEach((el) => {
    const off = () => el.classList.remove('is-press');
    el.addEventListener('pointerdown', () => el.classList.add('is-press'));
    ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach((ev) =>
      el.addEventListener(ev, off));
  });
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

  // ── The language control ─────────────────────────────────────────────────
  //
  // It was the OS's native <select>: white chrome, system font, a blue system
  // highlight and a popup drawn outside the page — the one element in the
  // product that did not belong to the surface it sat on, and it sat on the
  // panel's ink ground.
  //
  // The replacement is a real button-and-listbox (`role="combobox"` +
  // `role="listbox"`), not a div with click handlers. It is STILL a
  // `<button id="vpLang">`, so every native property the element carried is
  // carried still: `.disabled` is the button's own (and a disabled button
  // leaves the tab order exactly as a disabled <select> did — the one-language
  // focusable count stays 3), and `.focus()` works unchanged.
  //
  // THE LISTBOX IS IN FLOW, not floated. A popup dropped under the trigger
  // intersects the greeting bubble by 80 x 32.5px at 1440 — the bubble spans
  // the panel's full inner width and starts 27.5px below the header, so there
  // is no clear air to open into at any width. Rather than manage that
  // collision, the listbox is a `flex: none` block between the header and the
  // body, which is the slot #vpLangWhy already occupies: flex siblings in a
  // column cannot overlap, so the guarantee is structural rather than
  // arithmetic. Opening it shortens `.vp__b` (which is `flex: 1`) and the
  // bubble moves down with it, still whole.
  //
  // That reflow is INSTANT and unanimated, which is the same rule the collapse
  // mechanism follows for the same reason: a transition on a layout property
  // is the one thing this panel's motion rules forbid. Only the rows fade in.
  //
  // The read path is untouched. Choosing a language sets the module-local
  // `lang` and calls render() — what the <select>'s `change` handler did, verb
  // for verb. Nothing is fetched, posted or stored.
  function listOpen() { return !listEl.hidden; }

  function openList() {
    if (langEl.disabled || listOpen()) return;
    listEl.hidden = false;
    langEl.setAttribute('aria-expanded', 'true');
    const sel = $('.vp__opt[aria-selected="true"]', listEl) || listEl.firstElementChild;
    if (sel) sel.focus();
  }

  // `restore` is false when focus is already going somewhere else of the user's
  // choosing (a click outside, a Tab that has been handed the trigger already).
  // Stealing it back would fight them.
  function closeList(restore) {
    if (!listOpen()) return;
    listEl.hidden = true;
    langEl.setAttribute('aria-expanded', 'false');
    if (restore) langEl.focus();
  }

  function choose(code) {
    closeList(true);
    if (!code || code === lang) return;
    lang = code;
    render();
  }

  langEl.addEventListener('keydown', (e) => {
    const k = e.key;
    // Escape is handled here so it never reaches the document listener below,
    // which would collapse the whole sheet out from under an owner who only
    // meant to dismiss a two-row list.
    if (k === 'Escape') {
      if (!listOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      closeList(true);
      return;
    }
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Down' || k === 'Up') {
      e.preventDefault();
      openList();          // focus moves into the list; further arrows are its own
      return;
    }
    if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
      e.preventDefault();  // and with it the button's synthesised click
      if (listOpen()) closeList(true); else openList();
    }
  });
  // A plain click handler, with no test for how the click arrived. The
  // preventDefault above is what stops Enter and Space reaching here twice —
  // verified, one toggle per keystroke — and screening on `detail === 0` to
  // catch a synthesised click would also throw away the one a screen reader
  // sends when it activates the control, which is not a case to guess at.
  langEl.addEventListener('click', () => {
    if (listOpen()) closeList(true); else openList();
  });

  listEl.addEventListener('keydown', (e) => {
    const opts = $$('.vp__opt', listEl);
    if (!opts.length) return;
    const k = e.key;
    const i = opts.indexOf(document.activeElement);
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Down' || k === 'Up') {
      e.preventDefault();
      const step = (k === 'ArrowDown' || k === 'Down') ? 1 : opts.length - 1;
      opts[i === -1 ? 0 : (i + step) % opts.length].focus();
      return;
    }
    if (k === 'Home' || k === 'End') {
      e.preventDefault();
      opts[k === 'Home' ? 0 : opts.length - 1].focus();
      return;
    }
    if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      if (i !== -1) choose(opts[i].dataset.code);
      return;
    }
    if (k === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeList(true);
      return;
    }
    // Tab closes. Hand the trigger the focus FIRST and let the default run, so
    // Tab continues from the control's own place in the order (-> #vpClose)
    // rather than from <body>, which is where hiding a focused row would drop
    // it and which would restart the page's tab order from the top.
    if (k === 'Tab') closeList(true);
  });

  listEl.addEventListener('click', (e) => {
    const opt = e.target.closest && e.target.closest('.vp__opt');
    if (opt) choose(opt.dataset.code);
  });

  // A press anywhere else dismisses it. Capture, so it lands before the page's
  // own handlers rather than after whatever they do to the DOM.
  document.addEventListener('pointerdown', (e) => {
    if (!listOpen() || langEl.contains(e.target) || listEl.contains(e.target)) return;
    closeList(false);
  }, true);

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

  // The rows are rebuilt only when the set or the selection actually moves.
  // render() runs on every debounce tick, and rewriting the list while it is
  // open would destroy the row the owner is standing on — focus would drop to
  // <body> mid-keystroke. `optsKey` is the same idea as `lastKey` below, for
  // the same reason: an identical regeneration must not disturb anything.
  let optsKey = '';
  function renderLangOptions() {
    const langs = (summary && summary.sections.receptionist.languages) || [];
    if (!lang || langs.indexOf(lang) === -1) {
      lang = summary ? (summary.sections.receptionist.default_language || langs[0] || 'en') : 'en';
    }
    const label = LANG_LABEL[lang] || lang;
    if (langValEl.textContent !== label) langValEl.textContent = label;

    const key = langs.join(',') + '|' + lang;
    if (key !== optsKey) {
      optsKey = key;
      listEl.innerHTML = langs.map((c) =>
        `<div class="vp__opt" role="option" id="vpLangOpt-${esc(c)}" data-code="${esc(c)}"` +
        ` tabindex="-1" aria-selected="${c === lang}">${esc(LANG_LABEL[c] || c)}</div>`).join('');
    }
    // A disabled control with no reason is a dead end (spec §2.9). The selector
    // goes inert when the clinic has one language, and until now said nothing
    // about why — leaving an owner clicking a switch that had no second setting
    // to reach. The reason sits directly beneath it and names where to fix it.
    langEl.disabled = langs.length < 2;
    if (langEl.disabled) closeList(false);
    const why = $('#vpLangWhy', panel);
    if (why) why.hidden = !langEl.disabled;
  }

  // ── The collapsed tab (Portal Phase 1) ────────────────────────
  // It read "Preview": one word, set vertically, in the panel's MUTED grey.
  // Three separate ways of not saying whose preview it was — on the surface an
  // owner meets before they meet anything else, and the one they are one click
  // away from living with permanently. A first-time viewer could not tell that
  // the strip was their receptionist, or that it opened.
  //
  // So the tab carries her NAME, horizontally, in the panel's foreground ink,
  // with a chevron pointing the way it opens. Most clinics have not set a name
  // — the schema defaults `personality.display_name` to '' — so the fallback
  // has to identify her too, and "Your receptionist" is what receptionist.html
  // already calls her when the field is blank ("it introduces itself as your
  // clinic's receptionist, with no name").
  //
  // The peek is the second half of the answer: hovering or focusing the tab
  // slides the greeting's opening words out from under it, which is what tells
  // a first-time viewer there is more in that direction. It is an affordance
  // for a pointer and a keyboard only — `aria-hidden`, `pointer-events: none`,
  // no layout — and nothing depends on it: a tap at >=1024 opens the panel
  // outright, because on touch there is no hover to discover anything with.
  //
  // Silent on a legacy clinic: applyLegacyHeader has already replaced these
  // words with "Saved", and naming the receptionist on a tab that is showing
  // saved settings rather than her voice is the exact claim `.vp--saved-only`
  // exists to withdraw. Guarded in BOTH directions — that function awaits a
  // readiness promise and can land either side of this one.
  const RAIL_FALLBACK = 'Your receptionist';
  function renderRail(firstLine) {
    if (!railName || panel.classList.contains('vp--saved-only')) return;
    const name = ((summary && summary.sections.receptionist.display_name) || '').trim();
    railName.textContent = name || RAIL_FALLBACK;
    // `data-unnamed` is the switch verbatim.css narrows the fallback on at
    // 1024-1279. It is set HERE, where the label is chosen, so the two can
    // never disagree — and it carries no meaning to assistive tech, which
    // reads `aria-label` and nothing else. The attribute is on the static
    // markup too: the fallback is what the tab paints before the summary
    // lands, so it must already be narrow, not snap.
    railEl.toggleAttribute('data-unnamed', !name);
    railEl.setAttribute('aria-label', name
      ? `${name} — your receptionist. Open the preview.`
      : 'Your receptionist — open the preview.');
    if (railPeek) {
      railPeek.textContent = firstLine || '';
      if (firstLine) railPeek.setAttribute('lang', lang); else railPeek.removeAttribute('lang');
      railPeek.hidden = !firstLine;
    }
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
      renderRail(first);
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

  // ── F-V004: what this panel is allowed to call itself ────────────────────
  //
  // The panel showed "Live preview" beside a pulsing teal dot. On a clinic
  // running a hand-written script that was a direct contradiction of the truth
  // strip 40px above it, which was at that moment saying these settings are not
  // reaching the receptionist. Two components, one screen, opposite claims —
  // and the confident one was the one that was wrong.
  //
  // So when the legacy condition holds, the header says what the panel is
  // actually showing: SAVED SETTINGS. The live dot goes with it, because the dot
  // is the live indicator (spec §2.1(e)) and nothing here is live.
  //
  // The verdict comes from the SAME field shadow-notice.js reads — the
  // `tenant.legacy_prompt` check's severity, via SN.isShadowed — through the
  // SAME shared readiness promise the strip and the header control already
  // await. No new fetch, no second source of truth: if the two ever disagreed
  // it would be this component that had gone stale, which is the failure being
  // fixed. An unknown verdict changes nothing, exactly as everywhere else — we
  // only ever warn from evidence.
  async function applyLegacyHeader() {
    const SN = window.ShadowNotice;
    const P = window.Portal;
    if (!SN || !P || typeof P.readinessOnce !== 'function') return;
    const data = await P.readinessOnce();
    if (SN.isShadowed(data && data.run) !== true) return;

    // Both words are shadow-notice.js's now — SAVED_ONLY / SAVED_ONLY_SHORT —
    // because Home's greeting block has to say the same thing about the same
    // clinic and a second literal would be a second vocabulary waiting to
    // drift. The values are unchanged: 'Saved settings' and 'Saved'.
    const LABEL = SN.SAVED_ONLY;
    const labelEl = $('#vpLabel', panel);
    if (labelEl) labelEl.textContent = LABEL;      // drops the dot with the markup
    panel.setAttribute('aria-label', LABEL);
    if (railName) railName.textContent = SN.SAVED_ONLY_SHORT;
    // The tab is not showing a nameless receptionist here, it is showing
    // "Saved". Without this the CSS fallback would paint "Receptionist" over
    // it at 1024-1279 on any legacy clinic that renderRail's guard returns
    // early for — which is every one of them.
    railEl.removeAttribute('data-unnamed');
    // The tab's ACCESSIBLE name follows its visible one. At rest the tab now
    // identifies the receptionist by name — and on this clinic that is exactly
    // the claim `.vp--saved-only` exists to withdraw, so it reads out the same
    // label the header and the sheet handle already take.
    railEl.setAttribute('aria-label', LABEL);
    if (railPeek) railPeek.remove();               // no greeting is being previewed
    const railDot = $('.vp__rail .vp__dot', panel);
    if (railDot) railDot.remove();
    const gripLabel = $('#vpGripLabel', panel);
    if (gripLabel) gripLabel.textContent = LABEL;
    panel.classList.add('vp--saved-only');
  }

  async function main() {
    try { await window.Portal.me; } catch (_) { return; } // shell redirected to login
    panel.classList.add('is-busy');
    applyLegacyHeader();   // independent of the summary; must not gate the preview
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
