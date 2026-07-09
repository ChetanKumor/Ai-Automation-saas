// Conversations page (Issue 26). Static + vanilla JS, panel idiom. Read-only:
// list with tenant/channel/status filters + cursor pagination, and an in-page
// thread detail interleaving WhatsApp + voice messages with call-session cards.
// Every call goes through adminFetch (CSRF header + 401 redirect).
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
  function fmt(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  }

  const STATUS_BADGE = { open: 'badge-green', pending: 'badge-yellow', closed: 'badge-red' };

  // Pagination state.
  let nextBefore = null;   // cursor for the next page (null = no more)
  let loading = false;

  function channelChip(ch) {
    const cls = ch === 'whatsapp' ? 'chip-whatsapp' : ch === 'voice' ? 'chip-voice' : 'chip-other';
    return `<span class="chip ${cls}">${esc(ch)}</span>`;
  }

  // ── List ───────────────────────────────────────────────────────────────────
  function currentFilters() {
    const params = new URLSearchParams();
    const tenant  = $('tenantFilter').value;
    const channel = $('channelFilter').value;
    const status  = $('statusFilter').value;
    if (tenant)  params.set('tenant_id', tenant);
    if (channel) params.set('channel', channel);
    if (status)  params.set('status', status);
    return params;
  }

  async function loadTenants() {
    const res = await adminFetch('/admin/api/tenants');
    const tenants = await res.json();
    const sel = $('tenantFilter');
    tenants.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.business_name;
      sel.appendChild(opt);
    });
    // Honor a ?tenant_id= deep link from the tenant-detail page.
    const pre = new URLSearchParams(window.location.search).get('tenant_id');
    if (pre) sel.value = pre;
  }

  function rowHtml(r) {
    const chips = (r.channels || []).map(channelChip).join('') || '<span class="text-muted">—</span>';
    return `
      <tr class="conv-row" data-id="${esc(r.id)}">
        <td><strong>${esc(r.customer_display)}</strong></td>
        <td>${chips}</td>
        <td>${esc(r.preview) || '<span class="text-muted">—</span>'}</td>
        <td class="hide-mobile">${r.message_count}</td>
        <td><span class="badge ${STATUS_BADGE[r.status] || ''}">${esc(r.status)}</span></td>
        <td class="hide-mobile">${esc(r.tenant_name)}</td>
        <td class="hide-mobile">${fmt(r.updated_at)}</td>
      </tr>`;
  }

  async function loadList(reset) {
    if (loading) return;
    loading = true;
    const tbody = $('convRows');
    const params = currentFilters();
    if (reset) { nextBefore = null; }
    if (nextBefore) params.set('before', nextBefore);
    params.set('limit', '25');

    if (reset) tbody.innerHTML = '<tr><td colspan="7" class="text-muted" style="text-align:center; padding:24px;">Loading…</td></tr>';

    try {
      const res = await adminFetch('/admin/api/conversations?' + params);
      const data = await res.json();
      const rows = data.rows || [];
      if (reset) tbody.innerHTML = '';
      if (reset && !rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-muted" style="text-align:center; padding:24px;">No conversations found.</td></tr>';
      } else {
        tbody.insertAdjacentHTML('beforeend', rows.map(rowHtml).join(''));
      }
      nextBefore = data.next_before;
      $('loadMoreBtn').style.display = nextBefore ? '' : 'none';
    } finally {
      loading = false;
    }
  }

  // ── Detail ─────────────────────────────────────────────────────────────────
  function typeBadge(t) {
    return t && t !== 'text' ? `<span class="type-badge">${esc(t)}</span>` : '';
  }
  function bubbleHtml(m) {
    const side = m.direction === 'outbound' ? 'outbound' : 'inbound';
    // Non-text (media) renders as its type only — never the raw payload/URL that
    // may sit in `content` (matches the list preview; §9 "never raw payload").
    const body = m.msg_type && m.msg_type !== 'text'
      ? `${typeBadge(m.msg_type)}<span class="text-muted">[${esc(m.msg_type)}]</span>`
      : esc(m.content);
    return `
      <div class="bubble-row ${side}">
        <div class="bubble ${side}">
          ${body}
          <span class="meta">${channelChip(m.channel)} ${esc(m.sender)} · ${fmt(m.created_at)}</span>
        </div>
      </div>`;
  }
  function callCardHtml(cs) {
    return `
      <div class="call-card">
        <h4>📞 Voice call · ${esc(cs.direction || '')}</h4>
        <div class="kv"><span>Status:</span> ${esc(cs.status)} &nbsp; <span>Duration:</span> ${cs.duration_seconds != null ? esc(cs.duration_seconds) + 's' : '—'} &nbsp; <span>Language:</span> ${esc(cs.language_detected) || '—'}</div>
        <div class="kv"><span>Started:</span> ${fmt(cs.started_at)} &nbsp; <span>Ended:</span> ${fmt(cs.ended_at)}</div>
      </div>`;
  }

  // Interleave call-session cards into the message stream by start time, so a
  // call renders inline at the moment it happened (linkage is precise via
  // conversation_id — see the topology note in adminRoutes.js).
  function renderThread(data) {
    const items = [];
    (data.messages || []).forEach((m) => items.push({ t: new Date(m.created_at).getTime(), kind: 'msg', v: m }));
    (data.call_sessions || []).forEach((cs) => {
      const t = cs.started_at ? new Date(cs.started_at).getTime() : 0;
      items.push({ t, kind: 'call', v: cs });
    });
    items.sort((a, b) => a.t - b.t);

    const thread = $('dThread');
    if (!items.length) {
      thread.innerHTML = '<div class="empty-thread">No messages yet — this conversation was created but never spoke.</div>';
      return;
    }
    thread.innerHTML = items.map((it) => it.kind === 'call' ? callCardHtml(it.v) : bubbleHtml(it.v)).join('');
  }

  async function openDetail(id) {
    const res = await adminFetch('/admin/api/conversations/' + encodeURIComponent(id));
    if (res.status === 404) { alert('Conversation not found.'); return; }
    const data = await res.json();

    $('dTitle').textContent = data.customer_display;
    const chips = (Array.from(new Set((data.messages || []).map((m) => m.channel)))).map(channelChip).join('');
    $('dMeta').innerHTML = `
      <strong>${esc(data.tenant_name)}</strong> · ${esc(data.customer_phone) || '—'}<br>
      Status: <span class="badge ${STATUS_BADGE[data.status] || ''}">${esc(data.status)}</span>
      &nbsp; Mode: ${esc(data.mode)} &nbsp; Messages: ${data.message_count}
      &nbsp; ${chips}<br>
      Created: ${fmt(data.created_at)} · Updated: ${fmt(data.updated_at)}`;
    renderThread(data);

    $('convList').style.display = 'none';
    $('convDetail').style.display = 'block';
    window.scrollTo(0, 0);
  }

  function showList() {
    $('convDetail').style.display = 'none';
    $('convList').style.display = 'block';
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  $('convRows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.conv-row');
    if (tr) openDetail(tr.dataset.id);
  });
  $('backBtn').addEventListener('click', showList);
  $('refreshBtn').addEventListener('click', () => loadList(true));
  $('loadMoreBtn').addEventListener('click', () => loadList(false));
  ['tenantFilter', 'channelFilter', 'statusFilter'].forEach((id) =>
    $(id).addEventListener('change', () => loadList(true)));

  (async () => {
    await loadTenants();
    await loadList(true);
  })();
})();
