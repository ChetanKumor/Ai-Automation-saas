/* ============================================================================
 * Command palette (portal v2 spec §2.9, §3.0) — ⌘K / Ctrl+K.
 *
 * Fuzzy search over the portal's own page titles and nothing else. No network,
 * no dependency, no build step: it reads `Portal.nav`, the SAME array the
 * sidebar renders from, so the palette and the sidebar can never disagree about
 * which pages exist.
 *
 * Deliberately NOT a search over content. The portal has twelve destinations;
 * an owner who opens this wants to get somewhere, not to run a query. Anything
 * that needs a backend is out of scope here by design, not by omission.
 *
 * Loaded after shell.js on every page that has the shell.
 * ========================================================================== */
'use strict';

(function () {
  const P = window.Portal;
  if (!P || !P.nav || P.embedded) return; // no palette inside the wizard iframe

  // Only real destinations. An inert `Soon` row has no href, so routing to it
  // is impossible — listing it would be a result that does nothing.
  const ITEMS = P.nav.filter((i) => i.href && !i.soon);

  const GROUP_OF = {};
  (P.groups || []).forEach((g) => { GROUP_OF[g.id] = g.label; });

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Subsequence match, scored. `hp` finds "Hours & holidays"; a match that
  // starts the string or a word beats one buried mid-word, and tight runs beat
  // scattered letters. Returns null when a letter is missing entirely, so a
  // typo yields the empty state rather than a wrong page.
  function score(label, q) {
    if (!q) return { s: 0, hits: [] };
    const L = label.toLowerCase();
    const hits = [];
    let i = 0;
    let s = 0;
    let prev = -2;
    for (const ch of q.toLowerCase()) {
      if (ch === ' ') continue;
      const at = L.indexOf(ch, i);
      if (at === -1) return null;
      if (at === 0) s += 12;
      else if (/[\s&]/.test(L[at - 1])) s += 8;   // start of a word
      if (at === prev + 1) s += 6;                // contiguous run
      s -= Math.min(at - i, 6);                   // penalise long skips
      hits.push(at);
      prev = at;
      i = at + 1;
    }
    return { s, hits };
  }

  function mark(label, hits) {
    const set = new Set(hits);
    return label.split('').map((c, i) =>
      (set.has(i) ? `<b>${esc(c)}</b>` : esc(c))).join('');
  }

  function results(q) {
    const out = [];
    for (const item of ITEMS) {
      const r = score(item.label, q);
      if (r) out.push({ item, s: r.s, hits: r.hits });
    }
    // Stable within equal scores: fall back to the sidebar's own order, so an
    // empty query lists the pages exactly as the nav does.
    out.sort((a, b) => (b.s - a.s) || (ITEMS.indexOf(a.item) - ITEMS.indexOf(b.item)));
    return out;
  }

  let host = null;
  let input = null;
  let list = null;
  let rows = [];
  let cur = 0;
  let opener = null;

  function render(q) {
    rows = results(q);
    if (!rows.length) {
      list.innerHTML = `<li class="cmdk__none">No page matches “${esc(q)}”</li>`;
      return;
    }
    cur = 0;
    list.innerHTML = rows.map((r, i) => {
      const g = GROUP_OF[r.item.group];
      return `<li class="cmdk__row${i === 0 ? ' is-cur' : ''}" role="option" id="cmdk-o${i}"
        aria-selected="${i === 0}" data-i="${i}">
        <span class="cmdk__ic" aria-hidden="true">${r.item.icon}</span>
        <span class="cmdk__label">${mark(r.item.label, r.hits)}</span>
        ${g ? `<span class="cmdk__grp">${esc(g)}</span>` : ''}
      </li>`;
    }).join('');
    input.setAttribute('aria-activedescendant', 'cmdk-o0');
  }

  function move(d) {
    if (!rows.length) return;
    const els = list.querySelectorAll('.cmdk__row');
    els[cur].classList.remove('is-cur');
    els[cur].setAttribute('aria-selected', 'false');
    cur = (cur + d + rows.length) % rows.length;
    els[cur].classList.add('is-cur');
    els[cur].setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', 'cmdk-o' + cur);
    els[cur].scrollIntoView({ block: 'nearest' });
  }

  function go() {
    if (!rows.length) return;
    const href = rows[cur].item.href;
    close();
    window.location.href = href;
  }

  function close() {
    if (!host) return;
    document.removeEventListener('keydown', onTrap, true);
    host.remove();
    host = null;
    // Focus returns to whatever opened it — the ⌘K button, or the element that
    // had focus when the shortcut fired. Losing focus to <body> after closing a
    // dialog is the classic keyboard-only dead end.
    if (opener && document.contains(opener)) { try { opener.focus(); } catch (_) {} }
    opener = null;
  }

  // Focus trap. The palette has exactly two tabbables (the field and the close
  // button), so the trap is a wrap rather than a full inert-the-document dance.
  function onTrap(e) {
    if (!host) return;
    if (e.key !== 'Tab') return;
    const f = host.querySelectorAll('input, button');
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function open() {
    if (host) return;
    opener = document.activeElement;
    host = document.createElement('div');
    host.className = 'cmdk-host';
    host.innerHTML =
      `<div class="cmdk__backdrop" data-close></div>
       <div class="cmdk" role="dialog" aria-modal="true" aria-label="Search pages">
         <div class="cmdk__head">
           <svg class="cmdk__search" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
           <input class="cmdk__input" id="cmdkInput" type="text" autocomplete="off" spellcheck="false"
             placeholder="Go to a page…" role="combobox" aria-expanded="true"
             aria-controls="cmdkList" aria-autocomplete="list">
           <button class="cmdk__esc" type="button" data-close>Esc</button>
         </div>
         <ul class="cmdk__list" id="cmdkList" role="listbox" aria-label="Pages"></ul>
       </div>`;
    document.body.appendChild(host);

    input = host.querySelector('#cmdkInput');
    list = host.querySelector('#cmdkList');
    render('');

    input.addEventListener('input', () => render(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); go(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    host.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return close();
      const row = e.target.closest('.cmdk__row');
      if (row) { cur = Number(row.getAttribute('data-i')); go(); }
    });
    host.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.cmdk__row');
      if (!row || row.classList.contains('is-cur')) return;
      const i = Number(row.getAttribute('data-i'));
      move(i - cur);
    });
    document.addEventListener('keydown', onTrap, true);
    input.focus();
  }

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      host ? close() : open();
    }
  });

  const hint = document.getElementById('cmdkHint');
  if (hint) hint.addEventListener('click', open);

  window.PortalCmdk = { open, close };
})();
