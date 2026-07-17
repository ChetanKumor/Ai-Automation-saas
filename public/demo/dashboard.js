/* DEMO-02 — renders the clinic snapshot from public/demo/dashboard.json.
 * No framework, no bundler, no backend. Static, honest demo numbers; the CSS/SVG
 * bar row needs no chart library. */
'use strict';

const IC = {
  phone:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.9.36 1.78.7 2.62a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.46-1.27a2 2 0 0 1 2.11-.45c.84.34 1.72.57 2.62.7A2 2 0 0 1 22 16.92z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  moon:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
  globe:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  bolt:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
  users:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
};

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LANG_CLS = { Telugu: 'te', Hindi: 'hi', English: 'en' };

function card({ icon, label, value, unit = '', note = '', hero = false }) {
  return `
    <div class="card${hero ? ' card--hero' : ''}">
      <div class="card__top">
        <span class="card__icon">${icon}</span>
        <span class="card__label">${esc(label)}</span>
      </div>
      <div class="card__value">${esc(String(value))}${unit ? `<span class="card__unit">${esc(unit)}</span>` : ''}</div>
      ${note ? `<div class="card__note">${esc(note)}</div>` : ''}
    </div>`;
}

function render(data) {
  const s = data.stats;
  const langTotal = data.languages.reduce((a, x) => a + x.count, 0);

  document.getElementById('weekLabel').textContent = data.week_label || '';
  document.getElementById('roiLine').textContent =
    `AI handled ${s.calls_this_week} calls this week — including ${s.after_hours_caught} after hours, when the front desk was closed.`;

  // Language split card body (mini bar rows)
  const langCard = `
    <div class="card card--lang">
      <div class="card__top">
        <span class="card__icon">${IC.globe}</span>
        <span class="card__label">Languages served</span>
      </div>
      <div class="lang-split">
        ${data.languages.map((l) => {
          const cls = LANG_CLS[l.label] || 'en';
          const pct = langTotal ? Math.round((l.count / langTotal) * 100) : 0;
          return `
            <div class="lang-row">
              <span class="lang-row__name">${esc(l.label)}</span>
              <span class="lang-row__track"><span class="lang-row__fill lang-row__fill--${cls}" style="width:${pct}%"></span></span>
              <span class="lang-row__val">${l.count}</span>
            </div>`;
        }).join('')}
      </div>
    </div>`;

  document.getElementById('stats').innerHTML = [
    card({ icon: IC.phone, label: 'Calls handled this week', value: s.calls_this_week, note: 'Voice + WhatsApp, across three languages' }),
    card({ icon: IC.calendar, label: 'Appointments booked by AI', value: s.booked_by_ai, note: 'Confirmed without staff lifting a finger' }),
    card({ icon: IC.moon, label: 'After-hours calls caught', value: s.after_hours_caught, note: 'Evenings & weekends a front desk would miss', hero: true }),
    langCard,
    card({ icon: IC.users, label: 'Handled without staff', value: s.handled_without_staff_pct, unit: '%', note: 'Rest escalated to reception' }),
    card({ icon: IC.bolt, label: 'Avg response time', value: s.avg_response_seconds, unit: 'sec', note: 'Answered on the first ring, every time' }),
  ].join('');

  // Calls-per-day bar row (CSS bars; heights in px so the value/day labels
  // above and below the column never overflow the fixed-height chart box)
  const days = data.calls_per_day;
  const peak = Math.max(1, ...days.map((d) => d.calls));
  const MAX_BAR = 110; // px; chart is 168px tall, leaving room for both labels
  document.getElementById('chartSub').textContent =
    `${days.reduce((a, d) => a + d.calls, 0)} calls · peak ${peak}/day`;
  document.getElementById('chart').innerHTML = days.map((d) => {
    const h = Math.max(6, Math.round((d.calls / peak) * MAX_BAR));
    return `
      <div class="bar">
        <span class="bar__val">${d.calls}</span>
        <span class="bar__col" style="height:${h}px" title="${esc(d.day)}: ${d.calls} calls"></span>
        <span class="bar__day">${esc(d.day)}</span>
      </div>`;
  }).join('');

  document.getElementById('foot').innerHTML =
    `${IC.shield}<span>Illustrative weekly figures for this demo. The <b>after-hours</b> number is the calls
     a receptionist would have missed — booked while the clinic was closed.</span>`;
}

fetch('./dashboard.json')
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(render)
  .catch((err) => {
    document.querySelector('.wrap').innerHTML =
      `<div class="err"><b>Couldn't load dashboard.json</b> (${esc(String(err.message || err))}).<br>
       Serve this folder over http — the page reads <code>./dashboard.json</code>.</div>`;
  });
