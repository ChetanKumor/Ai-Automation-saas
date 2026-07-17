/* DEMO-01 — renders the two-pane unified patient thread from public/demo/fixture.json.
 * No framework, no bundler. All patient/call/appointment content comes from the
 * fixture (the Telugu is real captured data — never edited here). */
'use strict';

/* ── Inline icons (no external asset requests) ── */
const IC = {
  check:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  user:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 1 0-16 0"/><circle cx="12" cy="8" r="4"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  clock:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  tool:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.3 5.3L4 17l3 3 5.4-5.4a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.3-.6-.6-2.3z"/></svg>',
  arrow:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  shield:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
};

/* ── Helpers ── */
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Parse the wall-clock time straight from the ISO string (all fixture ts are IST),
// so display doesn't shift with the viewer's timezone. "…T11:04:52+05:30" -> "11:04 AM"
function clock(ts) {
  const m = String(ts).match(/T(\d{2}):(\d{2})/);
  if (!m) return '';
  let h = +m[1];
  const min = m[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min} ${ap}`;
}

// "2026-07-17T…" -> "Fri, 17 Jul" (weekday computed at UTC-noon → timezone-safe)
function dayLabel(ts) {
  const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return `${wd[d.getUTCDay()]}, ${+m[3]} ${months[+m[2] - 1]}`;
}

// +919701234567 -> +91 97012 34567
function fmtPhone(p) {
  const m = String(p).match(/^\+(\d{2})(\d{5})(\d{5})$/);
  return m ? `+${m[1]} ${m[2]} ${m[3]}` : String(p);
}

const initials = (name) =>
  String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();

/* ── Render ── */
function render(data) {
  const p = data.patient;
  const a = data.appointment;

  // Patient identity
  document.getElementById('patient').innerHTML = `
    <div class="avatar">${esc(initials(p.name))}</div>
    <div class="patient__id">
      <div class="patient__name">${esc(p.name)}</div>
      <div class="patient__phone">${esc(fmtPhone(p.phone))} · <span class="patient__lang">Telugu speaker</span></div>
    </div>
    <div class="patient__claim">
      <div class="chips">
        <span class="chip chip--call">Telugu call</span>
        <span class="chip chip--wa">WhatsApp</span>
      </div>
      <div class="claim">One patient · one thread · booked across two channels</div>
    </div>`;

  // Outcome card — appointment_time_ist looks like "Saturday, 18 July 2026 at 9:00 am"
  const parts = String(a.appointment_time_ist || '').split(' at ');
  const istDate = parts[0] || a.date;
  const istTime = (parts[1] || a.time).replace(/\bam\b/i, 'AM').replace(/\bpm\b/i, 'PM');
  document.getElementById('outcome').innerHTML = `
    <div class="outcome__icon">${IC.check}</div>
    <div>
      <div class="outcome__label">Outcome</div>
      <div class="outcome__title">Appointment booked</div>
    </div>
    <div class="outcome__meta">
      <div class="fact">${IC.user}<div><div class="fact__k">Doctor</div><div class="fact__v">${esc(a.doctor_name)}</div></div></div>
      <div class="fact">${IC.calendar}<div><div class="fact__k">Date</div><div class="fact__v">${esc(istDate)}</div></div></div>
      <div class="fact">${IC.clock}<div><div class="fact__k">Time</div><div class="fact__v">${esc(istTime)}</div></div></div>
      <span class="status-pill">${IC.check}<span>Booked</span></span>
    </div>`;

  // Call transcript
  const firstName = String(p.name).split(/\s+/)[0];
  const callBody = document.getElementById('callBody');
  data.call.forEach((t) => {
    const isAI = t.speaker === 'ai';
    const who = isAI ? 'AI receptionist' : firstName;
    const tag = isAI ? '<span class="turn__tag">AI</span>' : '';
    const tool = (t.tools && t.tools.length)
      ? `<div class="turn__tool">${IC.tool}<span>Checked live availability</span></div>`
      : '';
    callBody.insertAdjacentHTML('beforeend', `
      <div class="turn turn--${isAI ? 'ai' : 'caller'}">
        <div class="turn__head">
          <span class="turn__who">${esc(who)}</span>${tag}
          <span class="turn__time">${clock(t.ts)}</span>
        </div>
        <div class="turn__te" lang="te">${esc(t.text)}</div>
        <div class="turn__gloss">${esc(t.english_gloss)}</div>
        ${tool}
      </div>`);
  });
  callBody.insertAdjacentHTML('beforeend',
    `<div class="call-end">${IC.arrow}<span>Availability offered — patient continued on WhatsApp</span></div>`);

  // WhatsApp thread (with day dividers)
  const waBody = document.getElementById('waBody');
  let lastDay = null;
  data.whatsapp.forEach((m) => {
    const day = String(m.ts).slice(0, 10);
    if (day !== lastDay) {
      waBody.insertAdjacentHTML('beforeend', `<div class="wa-day"><span>${esc(dayLabel(m.ts))}</span></div>`);
      lastDay = day;
    }
    const out = m.direction === 'outbound';
    waBody.insertAdjacentHTML('beforeend', `
      <div class="wa-row wa-row--${out ? 'out' : 'in'}">
        <div class="bubble bubble--${out ? 'out' : 'in'}">
          <span>${esc(m.text)}</span>
          <span class="bubble__time">${clock(m.ts)}</span>
        </div>
      </div>`);
  });

  // Provenance footnote
  document.getElementById('foot').innerHTML = `${IC.shield}<div>
    <b>Real capture.</b> The Telugu call is live Sarvam <code>saaras:v3</code> speech-to-text plus the
    production AI brain — verbatim, never edited. The appointment is a real booked record.
    WhatsApp messages are shown for illustration.</div>`;
}

/* ── Load fixture (served locally; works offline, no CDN) ── */
fetch('./fixture.json')
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(render)
  .catch((err) => {
    document.querySelector('.wrap').innerHTML =
      `<div class="err"><b>Couldn't load fixture.json</b> (${esc(String(err.message || err))}).<br>
       Serve this folder over http — the page reads <code>./fixture.json</code>.</div>`;
  });
