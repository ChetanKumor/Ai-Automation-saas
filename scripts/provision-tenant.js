#!/usr/bin/env node
'use strict';

// provision-tenant — take a git-versioned clinic definition file to a fully
// provisioned DRAFT tenant (Issue 15). Zero manual SQL.
//
// Usage:
//   node scripts/provision-tenant.js provision/sunrise-dental.json
//       [--dry-run] [--force-config] [--kb-dir <path>] [--wa-token-env <NAME>]
//
// Exit codes: 0 success · 1 validation (bad definition/config, or pending
//   migrations) · 2 partial (tenant created, KB ingest failed / had no docs).
//
// Secrets never live in the definition file. A wa_token, if attached at all, is
// read from an ENV VAR named by --wa-token-env — never a CLI literal, never JSON.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const db = require('../src/db/db');
const { status } = require('../src/db/migrate');
const { encrypt } = require('../src/utils/encryption');
const {
  provisionTenant,
  DefinitionValidationError,
} = require('../src/modules/provisioning/provisioningService');
const { ConfigValidationError } = require('../src/modules/config/configService');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { file: null, dryRun: false, forceConfig: false, kbDir: null, waTokenEnv: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force-config') out.forceConfig = true;
    else if (a === '--kb-dir') out.kbDir = args[++i];
    else if (a === '--wa-token-env') out.waTokenEnv = args[++i];
    else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(1); }
    else if (!out.file) out.file = a;
    else { console.error(`Unexpected argument: ${a}`); process.exit(1); }
  }
  return out;
}

function printIssues(title, issues) {
  console.error(`\n✗ ${title}`);
  for (const i of issues) {
    const where = i.path ? i.path : '(root)';
    console.error(`   • ${where}: ${i.message}${i.keys ? ` [${i.keys.join(', ')}]` : ''}`);
  }
}

function printNextSteps(report, opts) {
  // The seed of the onboarding runbook (Issue 23 builds on this text).
  console.log('\n── Next steps ─────────────────────────────────────────────');
  console.log(`Tenant '${report.slug}' is a DRAFT (inactive, rendered-prompt). To take it live:`);
  console.log('  1. Attach WhatsApp credentials (wa_token) — via the admin panel, or');
  console.log('     re-run with --wa-token-env NAME (env var, never a file literal).');
  console.log('  2. Attach a DID / phone number for the channel(s) it will serve.');
  if (!opts.kbDir || (report.kb && report.kb.failed)) {
    console.log('  3. Ingest its knowledge base:  --kb-dir <path>  (resumable).');
  } else {
    console.log('  3. Knowledge base ingested. Add more docs any time with --kb-dir.');
  }
  console.log('  4. Run validation (Issue 16) to clear the activation gate.');
  console.log('  5. Activate (Issue 17) — flips status to live / active.');
  console.log('───────────────────────────────────────────────────────────');
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.file) {
    console.error('Usage: node scripts/provision-tenant.js <definition.json> ' +
      '[--dry-run] [--force-config] [--kb-dir <path>] [--wa-token-env <NAME>]');
    process.exit(1);
  }

  // Refuse to run against a DB with pending migrations — a provision built on a
  // stale schema is how drift ships.
  const st = await status({ logger: { log() {}, error() {} } });
  if (st.hasPending) {
    console.error(`✗ ${st.pending.length} pending migration(s): ${st.pending.join(', ')}`);
    console.error('  Run `npm run db:migrate` first.');
    process.exit(1);
  }

  // Load + JSON-parse the definition file (parse errors are validation errors).
  let definition;
  try {
    definition = JSON.parse(fs.readFileSync(path.resolve(opts.file), 'utf8'));
  } catch (err) {
    console.error(`✗ cannot read/parse ${opts.file}: ${err.message}`);
    process.exit(1);
  }

  let report;
  try {
    report = await provisionTenant(definition, {
      dryRun: opts.dryRun,
      forceConfig: opts.forceConfig,
      kbDir: opts.kbDir,
    });
  } catch (err) {
    if (err instanceof DefinitionValidationError) { printIssues('Invalid definition file:', err.issues); process.exit(1); }
    if (err instanceof ConfigValidationError) { printIssues('Merged config failed validation:', err.issues); process.exit(1); }
    if (err.code === 'PROVISION_CONFLICT') { console.error(`✗ ${err.message}`); process.exit(1); }
    console.error(`✗ provision failed: ${err.message}`);
    process.exit(1);
  }

  // ── Dry-run: print the plan + verdict, write nothing ──
  if (report.dry_run) {
    console.log('DRY RUN — no rows written.\n');
    console.log(JSON.stringify(report.plan, null, 2));
    console.log(`\nConfig validation: ${report.config_valid ? 'VALID ✓' : 'INVALID ✗'}`);
    console.log('Plan is complete. Re-run without --dry-run to apply.');
    process.exit(0);
  }

  // ── Applied: report each component ──
  console.log(`✓ provisioned '${report.slug}'  (tenant ${report.tenant_id})`);
  if (report.created.length) console.log(`  created:  ${report.created.join(', ')}`);
  if (report.skipped.length) console.log(`  skipping: ${report.skipped.join(', ')} (exists)`);
  console.log(`  config:   v${report.config_version}`);

  // Optional wa_token attach from an ENV VAR (never a literal / never the file).
  if (opts.waTokenEnv) {
    const secret = process.env[opts.waTokenEnv];
    if (!secret) {
      console.warn(`  ⚠ --wa-token-env ${opts.waTokenEnv}: env var is empty/unset — no token attached.`);
      report.warnings.push(`wa-token-env ${opts.waTokenEnv} empty`);
    } else {
      await db.query('UPDATE tenants SET wa_token = $2, updated_at = now() WHERE id = $1',
        [report.tenant_id, encrypt(secret)]);
      console.log(`  wa_token: attached from $${opts.waTokenEnv} (encrypted)`);
    }
  }

  // KB ingest outcome → exit-code 2 semantics on any failure / empty dir.
  let exitCode = 0;
  if (report.kb) {
    const { ingested, skipped, failed, docs } = report.kb;
    if (ingested.length) console.log(`  kb:       ingested ${ingested.length} doc(s): ${ingested.join(', ')}`);
    if (skipped.length) console.log(`  kb:       skipped ${skipped.length} already-ingested: ${skipped.join(', ')}`);
    if (docs === 0) { console.warn('  ⚠ kb: no readable .md/.txt docs in --kb-dir'); exitCode = 2; }
    if (failed) { console.error(`  ✗ kb: ingest failed on '${failed.source}': ${failed.error} — re-run resumes`); exitCode = 2; }
  }
  for (const w of report.warnings) console.warn(`  ⚠ ${w}`);

  printNextSteps(report, opts);
  process.exit(exitCode);
}

main().catch((err) => { console.error(err); process.exit(1); });
