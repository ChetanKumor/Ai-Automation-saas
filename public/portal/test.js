/* ============================================================================
 * Test your receptionist (PORTAL-P5-S14).
 *
 * One question in, one reply out — through POST /portal/api/test/turn, which
 * runs the REAL renderer + REAL brain against the tenant's CURRENT config, with
 * no persistence (server-side isolation; nothing here is a mock). Each send is
 * independent: the page keeps a visual transcript for the owner's convenience,
 * but the server never carries history between turns (v1 scope, spec §5.11) —
 * a later question is a fresh turn, not a continuation.
 *
 * Server response shapes:
 *   200 { reply, provenance: { config_version, tool_calls, knowledge_used,
 *         latency_ms }, remaining }
 *   429 { error, remaining: 0 }               — daily cap reached
 *   503 { quotaExceeded: true, error, remaining } — upstream LLM quota hit
 *   400 { error }                             — bad input (empty / too long)
 * ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const log = $('chatLog');
  const emptyState = $('chatEmpty');
  const form = $('chatForm');
  const input = $('chatInput');
  const sendBtn = $('sendBtn');
  const remainingBadge = $('remainingBadge');

  const TOOL_LABEL = {
    check_availability: 'checked availability',
    book_appointment: 'checked booking',
  };

  let sending = false;

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  function addOwnerBubble(text) {
    emptyState.hidden = true;
    const el = document.createElement('div');
    el.className = 'msg msg--owner';
    el.innerHTML = `<div class="msg__bubble">${esc(text)}</div>`;
    log.appendChild(el);
    scrollToEnd();
  }

  function addPendingBubble() {
    const el = document.createElement('div');
    el.className = 'msg msg--receptionist msg--pending';
    el.innerHTML = `<div class="msg__bubble"><span class="think-dot"></span><span class="think-dot"></span><span class="think-dot"></span></div>`;
    log.appendChild(el);
    scrollToEnd();
    return el;
  }

  function provenanceLine(p) {
    const parts = [];
    parts.push(p.config_version != null ? `Config v${p.config_version}` : 'No saved config yet');
    parts.push(p.knowledge_used ? 'used your FAQs' : 'no FAQ match used');
    (p.tool_calls || []).forEach((name) => parts.push(TOOL_LABEL[name] || name));
    parts.push(`${(p.latency_ms / 1000).toFixed(1)}s`);
    return parts.map((t) => `<span>${esc(t)}</span>`).join('');
  }

  function resolveReceptionistBubble(pendingEl, text, provenance) {
    pendingEl.classList.remove('msg--pending');
    pendingEl.innerHTML = `<div class="msg__bubble">${esc(text)}</div>` +
      (provenance ? `<div class="msg__prov">${provenanceLine(provenance)}</div>` : '');
    scrollToEnd();
  }

  function resolveAsSystemNotice(pendingEl, message) {
    pendingEl.className = 'msg msg--system';
    pendingEl.innerHTML = `<div class="msg__bubble">${esc(message)}</div>`;
    scrollToEnd();
  }

  function updateRemaining(n) {
    if (typeof n !== 'number') return;
    remainingBadge.textContent = n === 1 ? '1 test message left today' : `${n} test messages left today`;
    remainingBadge.classList.toggle('badge--warn', n <= 3);
    remainingBadge.classList.toggle('badge--teal', n > 3);
    if (n <= 0) {
      input.disabled = true;
      sendBtn.disabled = true;
      Array.from(document.querySelectorAll('.starter')).forEach((b) => { b.disabled = true; });
    }
  }

  function toast(message) {
    const host = $('toastHost');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span>${esc(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 2600);
    setTimeout(() => el.remove(), 2950);
  }

  async function sendQuestion(question) {
    if (sending) return;
    sending = true;
    input.disabled = true;
    sendBtn.disabled = true;
    Array.from(document.querySelectorAll('.starter')).forEach((b) => { b.disabled = true; });

    addOwnerBubble(question);
    const pending = addPendingBubble();

    try {
      const res = await fetch('/portal/api/test/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (res.status === 401) { window.location.replace('login.html'); return; }
      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        resolveAsSystemNotice(pending, data.error || 'You’ve used all 20 test messages for today. Try again tomorrow.');
        updateRemaining(0);
        return;
      }
      if (res.status === 503 && data.quotaExceeded) {
        resolveAsSystemNotice(pending, data.error || 'Testing is temporarily unavailable (API limit reached). Your receptionist is unaffected.');
        if (typeof data.remaining === 'number') updateRemaining(data.remaining);
        return;
      }
      if (!res.ok) {
        pending.remove();
        toast(data.error || 'Something went wrong. Try again.');
        return;
      }

      resolveReceptionistBubble(pending, data.reply, data.provenance);
      updateRemaining(data.remaining);
    } catch (_) {
      resolveAsSystemNotice(pending, 'Couldn’t reach the server — check your connection and try again.');
    } finally {
      sending = false;
      if (!input.disabled) { input.disabled = false; sendBtn.disabled = false; }
      // Starters stay hidden after the first message (emptyState is gone) —
      // re-enabling them is moot once the empty state itself is hidden.
      input.focus();
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    autosize();
    sendQuestion(q);
  }

  async function main() {
    try { await window.Portal.me; } catch (_) { return; } // shell redirected to login

    form.addEventListener('submit', onSubmit);
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    document.querySelectorAll('.starter').forEach((btn) => {
      btn.addEventListener('click', () => sendQuestion(btn.dataset.q));
    });

    input.focus();
    // Every other portal page signals "ready" implicitly by revealing a hidden
    // form once its data has loaded; this page has no such load step (the chat
    // starts empty by design), so there is nothing for a driver script to poll
    // for that proves the click handlers are actually wired. This marker is
    // that signal.
    document.body.dataset.testReady = '1';
  }

  main();
})();
