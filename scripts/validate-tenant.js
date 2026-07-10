#!/usr/bin/env node
'use strict';

// validate-tenant — run the static go/no-go validation catalog (Issue 16)
// against one tenant and print the result table + verdict.
//
// Usage:
//   node scripts/validate-tenant.js <slug|id> [--skip a,b] [--kb-min N] [--json]
//
// Examples:
//   node scripts/validate-tenant.js sunrise-dental
//   node scripts/validate-tenant.js sunrise-dental --skip kb,whatsapp.live
//   node scripts/validate-tenant.js sunrise-dental --json
//
// The --skip aliases: `kb` expands to both kb.populated + kb.retrieval (the
// common "no dev embedding key" case); `turn` expands to turn.scripted (the one
// dynamic check — it spends live model calls and books/deletes a synthetic
// appointment). Any other name must be an exact check name; an unknown one
// errors and lists the valid names.
//
// Exit codes: 0 = run passed · 1 = run failed (≥1 fail) · 2 = internal error
//   (bad args / DB down / tenant not found — the run never produced a verdict).

require('dotenv').config();

const db = require('../src/db/db');
const {
  validateTenant,
  CHECK_NAMES,
} = require('../src/modules/validation/validationService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Convenience aliases: `kb` for the two KB checks, `turn` for the dynamic one.
const SKIP_ALIASES = {
  kb: ['kb.populated', 'kb.retrieval'],
  turn: ['turn.scripted'],
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { target: null, skip: [], kbMin: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--skip') out.skip = expandSkips((args[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--kb-min') out.kbMin = Number(args[++i]);
    else if (a.startsWith('--')) fatal(`Unknown flag: ${a}`);
    else if (!out.target) out.target = a;
    else fatal(`Unexpected argument: ${a}`);
  }
  if (!out.target) fatal('Usage: node scripts/validate-tenant.js <slug|id> [--skip a,b] [--kb-min N] [--json]');
  if (out.kbMin != null && (!Number.isInteger(out.kbMin) || out.kbMin < 0)) {
    fatal('--kb-min must be a non-negative integer');
  }
  return out;
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

function fatal(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

// Resolve a slug OR uuid to a tenant id. Ambiguity is impossible (slug and uuid
// formats are disjoint); a miss exits 2 (never produced a verdict).
async function resolveTenantId(target) {
  const col = UUID_RE.test(target) ? 'id' : 'slug';
  const { rows } = await db.query(`SELECT id, slug, business_name FROM tenants WHERE ${col} = $1`, [target]);
  if (!rows[0]) fatal(`No tenant found for ${col}='${target}'`);
  return rows[0];
}

const SEV_LABEL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };

function printTable(tenant, run) {
  console.log(`\nValidation — ${tenant.business_name} (${tenant.slug || tenant.id})`);
  console.log('─'.repeat(72));
  const rows = run.checks.map((c) => [SEV_LABEL[c.severity] || c.severity, c.name, c.detail]);
  const nameW = Math.max(5, ...run.checks.map((c) => c.name.length));
  for (const [sev, name, detail] of rows) {
    console.log(`  ${sev.padEnd(4)}  ${name.padEnd(nameW)}  ${detail}`);
  }
  if (run.skipped.length) {
    console.log('\n  Skipped:');
    for (const s of run.skipped) console.log(`  SKIP  ${s.name.padEnd(nameW)}  ${s.reason}`);
  }
  console.log('─'.repeat(72));
  const fails = run.checks.filter((c) => c.severity === 'fail').length;
  const warns = run.checks.filter((c) => c.severity === 'warn').length;
  console.log(
    `  ${run.passed ? '✓ PASS' : '✗ FAIL'} — ${fails} fail, ${warns} warn, ` +
    `${run.checks.length - fails - warns} pass, ${run.skipped.length} skipped ` +
    `(${run.duration_ms}ms)`);
}

async function main() {
  const opts = parseArgs(process.argv);
  const tenant = await resolveTenantId(opts.target);

  const run = await validateTenant(tenant.id, {
    skip: opts.skip,
    ...(opts.kbMin != null ? { kbMin: opts.kbMin } : {}),
  });

  if (opts.json) {
    console.log(JSON.stringify({ tenant_id: tenant.id, ...run }, null, 2));
  } else {
    printTable(tenant, run);
  }
  return run.passed ? 0 : 1;
}

main()
  .then(async (code) => { await db.close(); process.exit(code); })
  .catch(async (err) => {
    console.error(`✗ ${err.message}`);
    try { await db.close(); } catch { /* ignore */ }
    process.exit(2);
  });
