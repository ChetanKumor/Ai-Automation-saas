/* ============================================================================
 * FAQs (PORTAL-P4-S11) — the first portal page that writes knowledge_chunks
 * rather than a tenant_configs section.
 *
 *   load    → GET    /portal/api/faqs      → { faqs, languages, readiness }
 *   add     → POST   /portal/api/faqs      → { faqs, languages, readiness }
 *   save    → PATCH  /portal/api/faqs/:id  → { faqs, languages, readiness }
 *   remove  → DELETE /portal/api/faqs/:id  → { faqs, languages, readiness }
 *
 * The unit of save is ONE FAQ (one knowledge_chunks row), so each card carries
 * its own Save — same shape as Doctors, no "v{N}" (there is no config document
 * here to version). Saving re-embeds on the server when the question/answer
 * text actually changed (~0.6–0.9s measured against the live embedding model),
 * so the Save button disables and reads "Saving…" for the round trip rather
 * than optimistically closing the card.
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  const LANG_LABEL = {
    te: { label: 'Telugu', native: 'తెలుగు' },
    hi: { label: 'Hindi', native: 'हिन्दी' },
    en: { label: 'English', native: '' },
  };
  const MAX_FAQS = 100;

  const host = $('faqs');
  let languages = ['te', 'hi', 'en']; // replaced by the tenant's enabled set on load
  let total = 0;                      // current FAQ count, for the cap counter
  let seq = 0;                        // client-side ids for unsaved cards

  // ── Toast ──────────────────────────────────────────────────────────────────
  function toast(message, ok) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (ok ? CHECK : '') + `<span>${esc(message)}</span>`;
    el.style.transition = 'opacity .3s ease, transform .3s ease';
    $('toastHost').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 2600);
    setTimeout(() => el.remove(), 2950);
  }

  function updateHeader(readiness) {
    if (readiness && window.Portal && window.Portal.renderLifecycle) {
      window.Portal.renderLifecycle(readiness.status, window.Portal.deriveGoLive(readiness.run));
    }
  }

  function updateCount() {
    const el = $('faqCount');
    if (total === 0) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = `${total} of ${MAX_FAQS} FAQs`;
    el.className = 'faq-count' + (total >= MAX_FAQS ? ' faq-count--full' : '');
  }

  // ── One FAQ card ───────────────────────────────────────────────────────────
  // `faq` is a server row, or null for a new unsaved FAQ.
  function card(faq) {
    const isNew = !faq;
    const f = faq || { id: null, question: '', answer: '', language: null };
    const uid = 'faq' + (++seq);

    const el = document.createElement('section');
    el.className = 'faq';
    el.dataset.id = f.id || '';
    el.innerHTML =
      `<div class="faq__head">
         <span class="faq__title${isNew ? ' faq__title--new' : ''}" data-role="title">${isNew ? 'New FAQ' : esc(f.question)}</span>
       </div>

       <div class="field" data-field="question">
         <label class="field__label" for="${uid}-q">Question</label>
         <input class="input" id="${uid}-q" type="text" maxlength="${'200'}" placeholder="Do you accept insurance?" value="${esc(f.question)}" autocomplete="off">
         <div class="field__error"></div>
       </div>

       <div class="field" data-field="answer">
         <label class="field__label" for="${uid}-a">Answer</label>
         <textarea class="input" id="${uid}-a" maxlength="${'800'}" rows="3" placeholder="Yes, we accept most major insurance plans — ask our front desk for the list.">${esc(f.answer)}</textarea>
         <div class="field__error"></div>
       </div>

       <div class="field" data-field="language">
         <label class="field__label" for="${uid}-lang">Language <span class="field__opt">optional</span></label>
         <p class="field__help">Tag this FAQ if it only applies in one language. Leave it as Any if it applies regardless.</p>
         <select class="input faq__lang" id="${uid}-lang" data-role="lang"></select>
         <div class="field__error"></div>
       </div>

       <div class="faq__error" data-role="formError"></div>

       <div class="faq__foot">
         <button class="faq__remove" type="button" data-role="remove">Remove</button>
         <span class="faq__foot-spacer"></span>
         <span class="save-note" data-role="note"></span>
         <button class="btn btn--primary" type="button" data-role="save">${isNew ? 'Add FAQ' : 'Save changes'}</button>
       </div>`;

    const q = (role) => el.querySelector(`[data-role="${role}"]`);

    // Language select: "Any language" plus the tenant's own enabled set.
    const langSelect = q('lang');
    langSelect.innerHTML = '<option value="">Any language</option>' + languages.map((code) => {
      const meta = LANG_LABEL[code] || { label: code, native: '' };
      return `<option value="${esc(code)}">${esc(meta.label)}${meta.native ? ' · ' + esc(meta.native) : ''}</option>`;
    }).join('');
    langSelect.value = f.language || '';

    // ── Read the card ──
    function collect() {
      return {
        question: el.querySelector(`#${uid}-q`).value.trim(),
        answer: el.querySelector(`#${uid}-a`).value.trim(),
        language: langSelect.value || null,
      };
    }

    let baseline = JSON.stringify(collect());
    const markDirty = () => {
      if (isNew && !el.dataset.id) return; // a new card is dirty by definition
      const dirty = JSON.stringify(collect()) !== baseline;
      q('note').textContent = dirty ? 'Unsaved changes' : '';
      q('note').className = 'save-note' + (dirty ? ' save-note--dirty' : '');
    };

    // ── Errors ──
    function clearErrors() {
      el.classList.remove('is-invalid');
      q('formError').textContent = '';
      el.querySelectorAll('.field.is-invalid').forEach((wrap) => wrap.classList.remove('is-invalid'));
      el.querySelectorAll('.field__error').forEach((e) => { e.textContent = ''; });
      el.querySelectorAll('.input--invalid').forEach((i) => i.classList.remove('input--invalid'));
    }
    function applyErrors(fields) {
      clearErrors();
      let first = null;
      for (const f2 of fields) {
        const wrap = el.querySelector(`.field[data-field="${f2.field}"]`);
        if (!wrap) {
          el.classList.add('is-invalid');
          q('formError').textContent = f2.message;
          continue;
        }
        wrap.classList.add('is-invalid');
        const err = wrap.querySelector('.field__error');
        if (err) err.textContent = f2.message;
        wrap.querySelectorAll('.input').forEach((i) => i.classList.add('input--invalid'));
        if (!first) first = wrap.querySelector('.input') || wrap;
      }
      if (first && first.focus) first.focus();
      if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    // ── Wiring ──
    el.querySelectorAll('.input').forEach((i) => i.addEventListener('input', () => {
      const wrap = i.closest('.field');
      if (wrap) {
        wrap.classList.remove('is-invalid');
        const err = wrap.querySelector('.field__error');
        if (err) err.textContent = '';
        wrap.querySelectorAll('.input--invalid').forEach((x) => x.classList.remove('input--invalid'));
      }
      markDirty();
    }));

    // ── Save (POST for a new FAQ, PATCH for an existing one) ──
    q('save').addEventListener('click', async () => {
      clearErrors();
      const id = el.dataset.id;
      let label = id ? 'Save changes' : 'Add FAQ';
      const btn = q('save');
      btn.disabled = true;
      btn.textContent = 'Saving…'; // ~0.6–0.9s: the server re-embeds on real content changes
      try {
        const res = await fetch(id ? `/portal/api/faqs/${encodeURIComponent(id)}` : '/portal/api/faqs', {
          method: id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(collect()),
        });
        if (res.status === 401) { window.location.replace('login.html'); return; }
        const data = await res.json().catch(() => ({}));
        if (res.status === 400 && Array.isArray(data.fields)) { applyErrors(data.fields); return; }
        if (!res.ok) { toast(data.error || 'Something went wrong. Try again.', false); return; }

        toast(id ? 'Saved' : 'FAQ added', true);
        updateHeader(data.readiness);
        if (Array.isArray(data.languages) && data.languages.length) languages = data.languages;
        render(data.faqs || []);
      } catch (_) {
        toast('Couldn’t save — check your connection and try again.', false);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });

    // ── Remove: confirm in place ──
    let confirming = false;
    q('remove').addEventListener('click', async () => {
      const id = el.dataset.id;
      if (!id) { // an unsaved card — nothing to delete
        el.remove();
        refreshChrome();
        return;
      }
      const btn = q('remove');
      if (!confirming) {
        confirming = true;
        btn.textContent = 'Remove — tap to confirm';
        btn.classList.add('faq__remove--confirm');
        setTimeout(() => {
          if (!confirming) return;
          confirming = false;
          btn.textContent = 'Remove';
          btn.classList.remove('faq__remove--confirm');
        }, 4000);
        return;
      }
      confirming = false;
      btn.disabled = true;
      btn.textContent = 'Removing…';
      try {
        const res = await fetch(`/portal/api/faqs/${encodeURIComponent(id)}`, {
          method: 'DELETE', headers: { Accept: 'application/json' },
        });
        if (res.status === 401) { window.location.replace('login.html'); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { toast(data.error || 'Couldn’t remove this FAQ.', false); return; }
        toast('FAQ removed', true);
        updateHeader(data.readiness);
        if (Array.isArray(data.languages) && data.languages.length) languages = data.languages;
        render(data.faqs || []);
      } catch (_) {
        toast('Couldn’t remove — check your connection and try again.', false);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Remove';
        btn.classList.remove('faq__remove--confirm');
      }
    });

    if (isNew) { q('note').textContent = ''; }
    return el;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render(list) {
    total = (list || []).length;
    host.innerHTML = '';
    (list || []).forEach((f) => host.appendChild(card(f)));
    refreshChrome();
    updateCount();
  }

  // Empty state vs list footer. Driven by what is ON SCREEN (including an
  // unsaved new card), so adding an FAQ immediately replaces the empty state.
  function refreshChrome() {
    const cards = host.querySelectorAll('.faq').length;
    $('emptyCard').hidden = cards > 0;
    $('listFoot').hidden = cards === 0 || total >= MAX_FAQS;
  }

  function addBlank() {
    if (total >= MAX_FAQS) { toast(`You’ve reached the limit of ${MAX_FAQS} FAQs.`, false); return; }
    const el = card(null);
    host.appendChild(el);
    refreshChrome();
    const first = el.querySelector('.input');
    if (first && first.focus) first.focus();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function main() {
    try { await window.Portal.me; } catch (_) { return; } // shell redirected to login
    let data;
    try {
      const res = await fetch('/portal/api/faqs', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      if (!res.ok) throw new Error('load ' + res.status);
      data = await res.json();
    } catch (_) {
      const msg = $('loadMsg');
      msg.textContent = 'We couldn’t load your FAQs. Refresh the page to try again.';
      msg.className = 'state-msg state-msg--error';
      return;
    }

    if (Array.isArray(data.languages) && data.languages.length) languages = data.languages;
    $('loadCard').hidden = true;
    render(data.faqs || []);

    $('addFaq').addEventListener('click', addBlank);
    $('emptyAdd').addEventListener('click', addBlank);
  }

  main();
})();
