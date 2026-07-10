#!/usr/bin/env node
'use strict';

// tenant-lifecycle — drive a tenant through the guarded lifecycle (Issue 17).
//
// Usage:
//   node scripts/tenant-lifecycle.js <slug|id> validate [--skip a,b] [--json]
//   node scripts/tenant-lifecycle.js <slug|id> activate [--json]
//   node scripts/tenant-lifecycle.js <slug|id> pause    [--json]
//
// Examples:
//   node scripts/tenant-lifecycle.js sunrise-dental validate --skip kb,whatsapp.live
//   node scripts/tenant-lifecycle.js sunrise-dental activate
//   node scripts/tenant-lifecycle.js sunrise-dental pause
//
// Calls lifecycleService directly (NOT the HTTP routes) — the panel and this CLI
// are two faces of the same service, so a runbook verb can never drift from the
// button. The `--skip` aliases match validate-tenant.js: `kb` expands to both KB
// checks, `turn` to the dynamic scripted-turn check.
//
// Exit codes: 0 = transition applied · 1 = refused by a guard (validation failed,
//   not validated, stale, invalid transition — a real answer, not a crash)
//   · 2 = internal error (bad args / DB down / tenant not found).

require('dotenv').config();

const db = require('../src/db/db');
const lifecycleService = require('../src/modules/tenant/lifecycleService');
const { CHECK_NAMES } = require('../src/modules/validation/validationService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = ['validate', 'activate', 'pause'];

const SKIP_ALIASES = {
  kb: ['kb.populated', 'kb.retrieval'],
  turn: ['turn.scripted'],
};

function fatal(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

function expandSkips(names) {
  const out = [];
  for (const n of names) {
    if (SKIP_ALIASES[n]) out.push(...SKIP_ALIASES[n]);
    else if (CHECK_NAMES.includes(n)) out.push(n);
    else fatal(`Unknown --skip name '${n}'. Valid: ${CHECK_NAMES.join(', ')} (aliases: kb, turn)`);
  }
  return [...new Set(out)];
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { target: null, action: null, skip: [], json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--skip') out.skip = expandSkips((args[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a.startsWith('--')) fatal(`Unknown flag: ${a}`);
    else if (!out.target) out.target = a;
    else if (!out.action) out.action = a;
    else fatal(`Unexpected argument: ${a}`);
  }
  if (!out.target || !out.action) {
    fatal('Usage: node scripts/tenant-lifecycle.js <slug|id> validate|activate|pause [--skip a,b] [--json]');
  }
  if (!ACTIONS.includes(out.action)) fatal(`Unknown action '${out.action}'. Valid: ${ACTIONS.join(', ')}`);
  if (out.skip.length && out.action !== 'validate') fatal('--skip only applies to the validate action');
  return out;
}

async function resolveTenant(target) {
  const col = UUID_RE.test(target) ? 'id' : 'slug';
  const { rows } = await db.query(
    `SELECT id, slug, business_name, status, active FROM tenants WHERE ${col} = $1`, [target]);
  if (!rows[0]) fatal(`No tenant found for ${col}='${target}'`);
  return rows[0];
}

const SEV_LABEL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };

function printRun(run) {
  if (!run || !run.checks) return;
  const nameW = Math.max(5, ...run.checks.map((c) => c.name.length));
  for (const c of run.checks) {
    console.log(`  ${(SEV_LABEL[c.severity] || c.severity).padEnd(4)}  ${c.name.padEnd(nameW)}  ${c.detail}`);
  }
  for (const s of run.skipped || []) {
    console.log(`  SKIP  ${s.name.padEnd(nameW)}  ${s.reason}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const tenant = await resolveTenant(opts.target);
  const label = `${tenant.business_name} (${tenant.slug || tenant.id})`;

  try {
    const out = await lifecycleService.transition(tenant.id, opts.action, { validate: { skip: opts.skip } });

    if (opts.json) {
      console.log(JSON.stringify({ tenant_id: tenant.id, action: opts.action, ...out }, null, 2));
    } else {
      console.log(`\n${opts.action} — ${label}`);
      console.log('─'.repeat(72));
      printRun(out.run);
      if (out.run) console.log('─'.repeat(72));
      console.log(`  ✓ ${out.from} → ${out.to}  (active=${out.active})`);
    }
    return 0;
  } catch (err) {
    if (err.name !== 'LifecycleError') throw err;      // → exit 2 via main's catch
    if (err.code === 'NOT_FOUND') fatal(err.message);   // → exit 2

    if (opts.json) {
      console.log(JSON.stringify({ tenant_id: tenant.id, action: opts.action, code: err.code, error: err.message, ...(err.run ? { run: err.run } : {}) }, null, 2));
    } else {
      console.error(`\n${opts.action} — ${label}`);
      console.error('─'.repeat(72));
      printRun(err.run);
      if (err.run) console.error('─'.repeat(72));
      console.error(`  ✗ REFUSED [${err.code}] ${err.message}`);
    }
    return 1; // a guard said no — that is an answer, not a crash
  }
}

main()
  .then(async (code) => { await db.close(); process.exit(code); })
  .catch(async (err) => {
    console.error(`✗ ${err.message}`);
    try { await db.close(); } catch { /* ignore */ }
    process.exit(2);
  });
