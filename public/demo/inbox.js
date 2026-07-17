/* DEMO-02 — renders the conversations inbox from public/demo/inbox.json.
 * No framework, no bundler, no backend. Only Sravani's row navigates (to the
 * real timeline, index.html); every other row is list-level only. Snippets are
 * English summaries from the fixture — never fabricated Telugu. */
'use strict';

/* ── Inline icons (no external asset requests) ── */
const IC = {
  phone:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.9.36 1.78.7 2.62a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.46-1.27a2 2 0 0 1 2.11-.45c.84.34 1.72.57 2.62.7A2 2 0 0 1 22 16.92z"/></svg>',
  wa:     '<svg viewBox="0 0 24 24"><path fill="#25D366" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.149-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347M12.05 21.785h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.999-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.002-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884Z"/></svg>',
  check:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  alert:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/></svg>',
  arrow:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
};

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const initials = (name) =>
  String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();

// "…T11:04:00+05:30" -> "11:04 AM" (read straight off the ISO string; no tz shift)
function clock(ts) {
  const m = String(ts).match(/T(\d{2}):(\d{2})/);
  if (!m) return '';
  let h = +m[1];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

// Deterministic, "now"-free relative time. today comes from the fixture, not Date.now().
function timeLabel(ts, today) {
  const d = String(ts).slice(0, 10);
  if (d === today) return clock(ts);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const toUTC = (s) => { const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return Date.UTC(+m[1], +m[2] - 1, +m[3]); };
  const days = Math.round((toUTC(today) - toUTC(ts)) / 86400000);
  if (days === 1) return 'Yesterday';
  const day = new Date(toUTC(ts));
  return wd[day.getUTCDay()];
}

const LANG = { Telugu: 'te', Hindi: 'hi', English: 'en' };
const CHAN = {
  voice:    { icon: IC.phone, cls: 'chan--voice', label: 'Voice call' },
  whatsapp: { icon: IC.wa,    cls: 'chan--whatsapp', label: 'WhatsApp' },
};

function rowHtml(t, today) {
  const lang = LANG[t.language] || 'en';
  const chan = CHAN[t.channel] || CHAN.voice;
  const needs = t.status === 'needs_staff';
  const open = !!t.href;

  const status = needs
    ? `<span class="status status--needs">${IC.alert}Needs staff</span>`
    : `<span class="status status--handled">${IC.check}AI handled</span>`;

  const nameExtra = t.real ? '<span class="row__real">Real call</span>' : '';
  const badge = `<span class="badge badge--${lang}">${esc(t.language)}</span>`;

  const inner = `
    <span class="row__avatar" aria-hidden="true">${esc(initials(t.name))}</span>
    <span class="row__main">
      <span class="row__top">
        <span class="row__name">${esc(t.name)}</span>
        ${badge}${nameExtra}
      </span>
      <span class="row__snippet">
        <span class="chan ${chan.cls}" title="${chan.label}" aria-label="${chan.label}">${chan.icon}</span>
        <span class="row__snippet-text">${esc(t.snippet)}</span>
      </span>
    </span>
    <span class="row__meta">
      ${status}
      <span class="row__time">${esc(timeLabel(t.ts, today))}</span>
      ${open ? `<span class="row__open-hint">Open ${IC.arrow}</span>` : ''}
    </span>`;

  const attrs = `data-channel="${esc(t.channel)}" data-status="${esc(t.status)}"`;
  if (open) {
    return `<a class="row row--open" href="${esc(t.href)}" ${attrs}>${inner}</a>`;
  }
  // Non-navigating rows: a button with a subtle select state, never a fake detail view.
  return `<button type="button" class="row" ${attrs}>${inner}</button>`;
}

function render(data) {
  const today = data.today;
  const threads = data.threads || [];

  document.getElementById('topDate').textContent = new Date(Date.UTC(
    +today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10), 12
  )).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  const handled = threads.filter((t) => t.status === 'handled').length;
  const needs = threads.length - handled;
  document.getElementById('inboxSub').textContent =
    `${threads.length} conversations today · ${handled} handled by AI · ${needs} with staff`;

  // Filter counts
  const counts = {
    all: threads.length,
    voice: threads.filter((t) => t.channel === 'voice').length,
    whatsapp: threads.filter((t) => t.channel === 'whatsapp').length,
    needs_staff: needs,
  };
  document.querySelectorAll('.filter').forEach((btn) => {
    const c = counts[btn.dataset.filter];
    btn.insertAdjacentHTML('beforeend', ` <span class="filter__count">${c}</span>`);
  });

  const list = document.getElementById('list');
  list.innerHTML = threads.map((t) => rowHtml(t, today)).join('');

  // Non-navigating rows: toggle a subtle "select" state only. No detail view.
  list.querySelectorAll('button.row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const was = btn.classList.contains('is-selected');
      list.querySelectorAll('.row.is-selected').forEach((r) => r.classList.remove('is-selected'));
      if (!was) btn.classList.add('is-selected');
    });
  });

  // Filter chips (client-side; static list stays in the DOM, we just hide rows)
  const filters = document.getElementById('filters');
  filters.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter');
    if (!btn) return;
    const f = btn.dataset.filter;
    filters.querySelectorAll('.filter').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    let shown = 0;
    list.querySelectorAll('.row').forEach((row) => {
      const ok = f === 'all'
        || (f === 'needs_staff' ? row.dataset.status === 'needs_staff' : row.dataset.channel === f);
      row.style.display = ok ? '' : 'none';
      if (ok) shown += 1;
    });
    let empty = list.querySelector('.list-empty');
    if (!shown) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = 'No conversations in this filter.';
        list.appendChild(empty);
      }
    } else if (empty) {
      empty.remove();
    }
  });

  document.getElementById('listFoot').innerHTML =
    `${IC.shield}<span>Only <b>Sravani Reddy</b>'s thread opens — it's the one real captured call.
     Other rows are illustrative summaries of what the AI handled.</span>`;
}

fetch('./inbox.json')
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(render)
  .catch((err) => {
    document.querySelector('.wrap').innerHTML =
      `<div class="err"><b>Couldn't load inbox.json</b> (${esc(String(err.message || err))}).<br>
       Serve this folder over http — the page reads <code>./inbox.json</code>.</div>`;
  });
