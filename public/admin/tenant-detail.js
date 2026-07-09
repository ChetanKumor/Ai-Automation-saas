// Tenant detail page (Issue 25). Static + vanilla JS matching the panel idiom.
// Every mutating call goes through adminFetch (CSRF header + 401 redirect);
// read-only GETs use it too (the header is harmless on reads).
'use strict';

(function () {
  const params = new URLSearchParams(window.location.search);
  const TID = params.get('id');

  const $ = (id) => document.getElementById(id);
  function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // Page state.
  let currentVersion = null; // head version (null = configless)
  let hasConfig = false;
  let dirty = false;         // editor edited since last load/save

  // ── Unsaved-changes guard ──────────────────────────────────────────────────
  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  function setDirty(v) { dirty = v; }

  // ── Load header + config ───────────────────────────────────────────────────
  async function loadConfig() {
    const res = await adminFetch(`/admin/api/tenants/${encodeURIComponent(TID)}/config`);
    if (res.status === 404) {
      $('notFound').style.display = 'block';
      return false;
    }
    const data = await res.json();
    $('detail').style.display = 'block';

    $('tName').textContent = data.name || 'Tenant';
    document.title = `${data.name || 'Tenant'} — Admin`;
    // Deep link into this tenant's filtered conversations list (Issue 26).
    $('convLink').href = `/admin/conversations.html?tenant_id=${encodeURIComponent(TID)}`;
    const badge = $('tStatus');
    badge.textContent = data.status || '—';
    badge.className = 'badge ' + (data.status === 'live' ? 'badge-green'
      : data.status === 'paused' ? 'badge-red' : '');
    $('tVersion').textContent = data.version != null ? data.version : '—';
    $('tUpdated').textContent = data.updated_at
      ? 'Updated ' + new Date(data.updated_at).toLocaleString() : '';
    $('aiPromptNote').style.display = data.has_ai_prompt ? 'block' : 'none';

    hasConfig = data.has_config;
    currentVersion = data.version != null ? data.version : null;

    if (hasConfig) {
      $('editor').style.display = 'block';
      $('editor').value = JSON.stringify(data.config, null, 2);
      $('configEmpty').style.display = 'none';
      $('seedBtn').style.display = 'none';
      $('saveBtn').style.display = '';
      $('formatBtn').style.display = '';
    } else {
      $('editor').style.display = 'none';
      $('configEmpty').style.display = 'block';
      $('seedBtn').style.display = '';
      $('saveBtn').style.display = 'none';
      $('formatBtn').style.display = 'none';
    }
    setDirty(false);
    return true;
  }

  // ── Issue list rendering (422) ─────────────────────────────────────────────
  function renderIssues(issues) {
    const el = $('issues');
    if (!issues || !issues.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="muted-sm" style="margin-bottom:4px;">Validation failed:</div>' +
      issues.map((i) =>
        `<div class="issue-item"><span class="issue-path">${esc(i.path || '(root)')}</span> — ${esc(i.message)}</div>`
      ).join('');
  }
  function clearIssues() { $('issues').innerHTML = ''; }

  function msg(text, isErr) {
    const el = $('saveMsg');
    el.textContent = text || '';
    el.style.color = isErr ? '#b00020' : '#2e7d32';
  }

  // ── Format button: pretty-print, with a client-side parse guard ────────────
  $('formatBtn').addEventListener('click', () => {
    let parsed;
    try { parsed = JSON.parse($('editor').value); }
    catch (e) { msg('Invalid JSON: ' + e.message, true); return; }
    $('editor').value = JSON.stringify(parsed, null, 2);
    msg('Formatted.', false);
  });

  $('editor').addEventListener('input', () => setDirty(true));

  // ── Save (PUT with optimistic concurrency) ─────────────────────────────────
  $('saveBtn').addEventListener('click', async () => {
    clearIssues();
    let config;
    try { config = JSON.parse($('editor').value); }
    catch (e) { msg('Invalid JSON: ' + e.message, true); return; }

    const res = await adminFetch(`/admin/api/tenants/${encodeURIComponent(TID)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, expected_version: currentVersion }),
    });

    if (res.status === 200) {
      const { version } = await res.json();
      currentVersion = version;
      $('tVersion').textContent = version;
      setDirty(false);
      msg('Saved as version ' + version + '.', false);
      loadRevisions();
      return;
    }
    if (res.status === 422) {
      const { issues } = await res.json();
      renderIssues(issues);
      msg('Config rejected — see issues below.', true);
      return;
    }
    if (res.status === 409) {
      const { current_version } = await res.json();
      msg(`Version conflict: someone saved version ${current_version} while you edited (you had ${currentVersion}).`, true);
      if (window.confirm(`This tenant now has version ${current_version}. Reload the latest config? Your unsaved edits will be lost.`)) {
        await loadConfig();
      }
      return;
    }
    const err = await res.json().catch(() => ({}));
    msg(err.error || ('Save failed (' + res.status + ')'), true);
  });

  // ── Seed defaults ──────────────────────────────────────────────────────────
  $('seedBtn').addEventListener('click', async () => {
    if (!window.confirm('Seed this tenant with the clinic default config?')) return;
    const res = await adminFetch(`/admin/api/tenants/${encodeURIComponent(TID)}/config/defaults`, {
      method: 'POST',
    });
    if (res.status === 201) { await loadConfig(); loadRevisions(); return; }
    const err = await res.json().catch(() => ({}));
    msg(err.error || ('Seeding failed (' + res.status + ')'), true);
  });

  // ── Revisions ──────────────────────────────────────────────────────────────
  async function loadRevisions() {
    const res = await adminFetch(`/admin/api/tenants/${encodeURIComponent(TID)}/revisions?limit=20`);
    const rows = await res.json();
    const tbody = $('revList');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center; padding:20px;">No revisions yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td><strong>${esc(r.version)}</strong></td>
        <td><code>${esc(r.source)}</code></td>
        <td class="hide-mobile">${new Date(r.created_at).toLocaleString()}</td>
        <td class="toolbar">
          <button class="btn" style="background:#eee; color:#333;" data-view="${esc(r.version)}">View</button>
          <button class="btn" data-restore="${esc(r.version)}">Restore</button>
        </td>
      </tr>`).join('');

    tbody.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => viewRevision(b.getAttribute('data-view'))));
    tbody.querySelectorAll('[data-restore]').forEach((b) =>
      b.addEventListener('click', () => restoreRevision(b.getAttribute('data-restore'))));
  }

  async function viewRevision(version) {
    const res = await adminFetch(`/admin/api/tenants/${encodeURIComponent(TID)}/revisions/${encodeURIComponent(version)}`);
    if (!res.ok) return;
    const config = await res.json();
    $('modalTitle').textContent = 'Revision ' + version;
    $('modalBody').textContent = JSON.stringify(config, null, 2);
    $('modal').classList.add('show');
  }

  async function restoreRevision(version) {
    if (!window.confirm(`Restore revision ${version}? This appends it as a NEW version (history is never rewound).`)) return;
    const res = await adminFetch(`/admin/api/tenants/${encodeURIComponent(TID)}/revisions/${encodeURIComponent(version)}/restore`, {
      method: 'POST',
    });
    if (res.status === 201) {
      const { version: v } = await res.json();
      msg(`Restored revision ${version} as new version ${v}.`, false);
      await loadConfig();
      loadRevisions();
      return;
    }
    const err = await res.json().catch(() => ({}));
    msg(err.error || ('Restore failed (' + res.status + ')'), true);
  }

  $('modalClose').addEventListener('click', () => $('modal').classList.remove('show'));
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').classList.remove('show'); });

  // ── Prompt preview ─────────────────────────────────────────────────────────
  $('pvBtn').addEventListener('click', async () => {
    const channel = $('pvChannel').value;
    const lang = $('pvLang').value;
    const qs = new URLSearchParams({ channel });
    if (lang) qs.set('lang', lang);
    const res = await adminFetch(`/admin/api/tenants/${encodeURIComponent(TID)}/prompt-preview?${qs.toString()}`);
    if (res.status === 404) {
      $('pvOut').textContent = 'No config to preview — seed defaults first.';
      $('pvTokens').textContent = '';
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      $('pvOut').textContent = 'Render error: ' + (data.error || res.status);
      $('pvTokens').textContent = '';
      return;
    }
    $('pvOut').textContent = data.prompt;
    $('pvTokens').textContent = '≈ ' + data.est_tokens + ' tokens';
  });

  // ── Validation history (Issue 16) ──────────────────────────────────────────
  // Renders each persisted run's stored `result` (checks + skipped) inline.
  const SEV_COLOR = { pass: '#2e7d32', warn: '#b7791f', fail: '#b00020' };
  async function loadValidationRuns() {
    const res = await adminFetch(`/admin/api/tenants/${encodeURIComponent(TID)}/validation-runs?limit=10`);
    if (!res.ok) return;
    const runs = await res.json();
    const el = $('valRuns');
    if (!runs.length) {
      el.innerHTML = '<p class="text-muted" style="margin:0;">No validation runs yet.</p>';
      return;
    }
    el.innerHTML = runs.map((run) => {
      const r = run.result || {};
      const checks = (r.checks || []).map((c) =>
        `<div class="issue-item"><span style="color:${SEV_COLOR[c.severity] || '#333'}; font-weight:600;">${esc((c.severity || '').toUpperCase())}</span> <span class="issue-path">${esc(c.name)}</span> — ${esc(c.detail)}</div>`
      ).join('');
      const skipped = (r.skipped || []).map((s) =>
        `<div class="issue-item"><span class="muted-sm">SKIP</span> <span class="issue-path">${esc(s.name)}</span> — ${esc(s.reason)}</div>`
      ).join('');
      const badge = run.passed ? 'badge badge-green' : 'badge badge-red';
      return `
        <div style="border:1px solid #eee; border-radius:8px; padding:12px; margin-bottom:12px;">
          <div class="flex-between" style="margin-bottom:8px;">
            <span class="${badge}">${run.passed ? 'PASSED' : 'FAILED'}</span>
            <span class="muted-sm">${new Date(run.created_at).toLocaleString()} · ${esc(r.duration_ms)}ms · v${esc(r.service_version)}</span>
          </div>
          ${checks}
          ${skipped}
        </div>`;
    }).join('');
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  (async function init() {
    if (!TID) { $('notFound').style.display = 'block'; return; }
    const ok = await loadConfig();
    if (ok) { loadRevisions(); loadValidationRuns(); }
  })();
})();
