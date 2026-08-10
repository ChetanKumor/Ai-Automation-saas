#!/usr/bin/env node
'use strict';

// provision-tenant — take a git-versioned clinic definition file to a fully
// provisioned DRAFT tenant (Issue 15). Zero manual SQL.
//
// Usage:
//   node scripts/provision-tenant.js provision/sunrise-dental.json
//       [--dry-run] [--force-config] [--kb-dir <path>] [--wa-token-env <NAME>]
//       [--yes]
//
// Exit codes: 0 success · 1 validation (bad definition/config, pending
//   migrations, an unconfirmed write, or a --kb-dir run whose slug names no
//   tenant) · 2 partial (tenant created, KB ingest failed / had no docs).
//
// Secrets never live in the definition file. A wa_token, if attached at all, is
// read from an ENV VAR named by --wa-token-env — never a CLI literal, never JSON.
//
// ── WHAT THIS CLI SHOWS YOU, AND WHY (RAG audit, 05-isolation.md §A.6) ───────
// The two arguments name different things, and only one of them names the
// tenant:
//
//   node scripts/provision-tenant.js  provision/clinic-A.json  --kb-dir ./kb/clinic-B
//                                     └─ names the TENANT ─┘   └─ names the DOCS ─┘
//
// Nothing relates them — not a naming convention, not a manifest, not a check.
// A mis-aim is not recoverable through any product surface either: document
// chunks carry a `source` that is not `faq`/`faq:<lang>` and faqService.listFaqs
// filters on exactly that (faqService.js:109-112), there is no admin chunk
// route, and getRelevantChunks selects and filters no `source` at all
// (knowledgeService.js:190-197) — so from the first turn one clinic's documents
// are in another clinic's prompt.
//
// So before anything is written this CLI prints the tenant AS THE DATABASE
// HOLDS IT — read back through provisioningService.describeTarget, never echoed
// from argv or from the definition file — and asks for confirmation. After the
// run it reads the same tenant again and reports what is actually there beside
// what was attempted.
//
// It does NOT change what gets written. The dedup rule, the skip semantics and
// the write order are exactly as they were; a discrepancy between attempted and
// observed is SHOWN, never acted on.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const db = require('../src/db/db');
const { status } = require('../src/db/migrate');
const { encrypt } = require('../src/utils/encryption');
const {
  provisionTenant,
  describeTarget,
  observeSources,
  DefinitionValidationError,
} = require('../src/modules/provisioning/provisioningService');
const { ConfigValidationError } = require('../src/modules/config/configService');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    file: null, dryRun: false, forceConfig: false, kbDir: null, waTokenEnv: null, yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force-config') out.forceConfig = true;
    else if (a === '--kb-dir') out.kbDir = args[++i];
    else if (a === '--wa-token-env') out.waTokenEnv = args[++i];
    else if (a === '--yes' || a === '-y') out.yes = true;
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

const RULE = '───────────────────────────────────────────────────────────';

// ── §6.1 — the display that makes the tenant boundary visible ────────────────
// Every value below comes from a READ of the tenants / tenant_configs /
// knowledge_chunks rows. Nothing is echoed from the definition file or from
// argv, and that distinction IS the finding: the definition's business_name can
// differ from the row's, and when it does, the row is the one about to be
// written to. The dry run used to print the definition's own fields back at the
// operator, which is why it could never catch a mis-aim.
function printTarget(target, opts) {
  console.log('\n── Target — read from the database, not from your arguments ──');
  if (!target.found) {
    console.log(`  slug '${target.slug}': NO TENANT with this slug exists.`);
    console.log('  Nothing to read: no tenant row, no config, no knowledge chunks.');
  } else {
    const t = target.tenant;
    console.log(`  business_name:    ${t.business_name}`);
    console.log(`  slug:             ${t.slug}`);
    console.log(`  tenant id:        ${t.id}`);
    console.log(`  status:           ${t.status}  ·  active=${t.active}  ·  ` +
      `config ${target.config_version ? `v${target.config_version}` : '(none)'}`);
    console.log(`  knowledge_chunks: ${target.chunk_total} row(s)` +
      (target.chunks.length ? ' — by source prefix:' : ''));
    for (const c of target.chunks) {
      console.log(`      ${c.prefix.padEnd(30)} ${String(c.n).padStart(5)} row(s)`);
    }
  }
  if (opts.kbDir) {
    console.log(`  --kb-dir:         ${opts.kbDir}`);
    console.log(target.found
      ? '                    → every .md/.txt in there lands in the tenant ABOVE.'
      : '                    → there is no tenant above for them to land in.');
  }
  console.log(RULE);
}

// ── §6.1(b) — a --kb-dir run whose slug names no tenant is refused ───────────
// This is §A.6's mis-aim with the CREATE path still open underneath it: a
// mistyped slug would silently mint a SECOND draft tenant and pour the clinic's
// whole knowledge base into it, and the operator's only signal would be the
// filenames they just typed. Refuse, name the slug, write nothing — and note
// that this is the one guard --yes cannot skip, which is exactly where a
// confirmation prompt is worth nothing.
//
// Creating a tenant is still one command: the same one WITHOUT --kb-dir. That
// is step 1 of the runbook printNextSteps prints, and --kb-dir is its step 3.
function refuseUnresolvedTarget(target, opts) {
  console.error(`\n✗ --kb-dir given, but slug '${target.slug}' names no tenant in this database.`);
  console.error('  Refusing to create a tenant and ingest documents into it in one step:');
  console.error('  a mistyped slug here is indistinguishable from a new clinic, and the');
  console.error('  documents would be unreachable from every product surface afterwards.');
  console.error('  Nothing was written.');
  console.error('');
  console.error('  If this clinic is genuinely new, create it first, then ingest:');
  console.error(`    node scripts/provision-tenant.js ${opts.file}`);
  console.error(`    node scripts/provision-tenant.js ${opts.file} --kb-dir ${opts.kbDir}`);
  console.error('  Otherwise: check the slug in the definition file against the clinic you meant.');
}

// ── §6.1(c) — confirmation, skippable non-interactively ─────────────────────
// --yes exists so the runbook (and anything else without a terminal) keeps
// working. A missing terminal is a REFUSAL rather than a default-yes: this
// process would otherwise read EOF from a pipe and there is no safe way to read
// that as consent.
async function confirmWrite(target, opts) {
  const who = target.found
    ? `'${target.tenant.business_name}' (${target.tenant.id})`
    : `a NEW tenant '${target.slug}'`;

  if (opts.yes) {
    console.log(`--yes: proceeding to write to ${who} without confirmation.`);
    return;
  }
  if (!process.stdin.isTTY) {
    console.error(`\n✗ refusing to write to ${who}: stdin is not a terminal, so there is`);
    console.error('  nobody to confirm the target above. Re-run with --yes once it is the');
    console.error('  tenant you meant. Nothing was written.');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await rl.question(`Write to ${who}? [y/N] `);
  } finally {
    rl.close();
  }
  if (!/^y(es)?$/i.test(String(answer).trim())) {
    console.error('✗ aborted — nothing was written.');
    process.exit(1);
  }
}

// ── §6.3 — what the database now holds, beside what was attempted ───────────
// The created/skipped/ingested labels above are assembled from what the run
// ASKED FOR. This block answers the other question, and it is the one an
// operator actually has: what is in there now. Both halves are printed so a
// disagreement between them is legible.
//
// A discrepancy is MARKED and nothing else. No retry, no rollback, no cleanup —
// deciding what "attempted ingested, 0 rows present" or "attempted failed, 7
// rows present" MEANS is a change to write semantics and is deliberately not
// made here.
function kbDiscrepancy(state, observed) {
  if (state === 'ingested' && observed === 0) return 'reported ingested, but 0 rows are present';
  if (state === 'skipped' && observed === 0) return 'reported already-ingested, but 0 rows are present';
  if (state === 'failed' && observed > 0) {
    return `reported FAILED, but ${observed} row(s) are present — the document is partial`;
  }
  return null;
}

async function printReadBack(definition, report, opts) {
  const after = await describeTarget(definition);
  console.log('\n── Written — read back from the database ─────────────────');

  if (!after.found) {
    // Nothing resolves after a run that claimed to write: report it, do not act.
    console.log(`  ⚠ slug '${after.slug}' still names no tenant after this run.`);
    console.log(RULE);
    return;
  }

  const t = after.tenant;
  console.log(`  business_name:    ${t.business_name}`);
  console.log(`  tenant id:        ${t.id}`);
  console.log(`  status:           ${t.status}  ·  active=${t.active}  ·  ` +
    `config ${after.config_version ? `v${after.config_version}` : '(none)'}`);
  console.log(`  knowledge_chunks: ${after.chunk_total} row(s)` +
    (after.chunks.length ? ' — by source prefix:' : ''));
  for (const c of after.chunks) {
    console.log(`      ${c.prefix.padEnd(30)} ${String(c.n).padStart(5)} row(s)`);
  }

  if (!report.kb) { console.log(RULE); return; }

  // Per source FILE: the label this run assigned, and the rows now present.
  const attempted = new Map();
  for (const s of report.kb.ingested) attempted.set(s, 'ingested');
  for (const s of report.kb.skipped) attempted.set(s, 'skipped');
  if (report.kb.failed && report.kb.failed.source !== opts.kbDir) {
    attempted.set(report.kb.failed.source, 'failed');
  }

  if (attempted.size) {
    const observed = await observeSources(t.id, [...attempted.keys()]);
    const warnings = [];
    console.log('  per source file  (attempted → observed):');
    for (const [source, state] of attempted) {
      const n = observed.get(source) || 0;
      const note = kbDiscrepancy(state, n);
      console.log(`      ${source.padEnd(30)} attempted ${state.padEnd(9)} ` +
        `observed ${String(n).padStart(5)} row(s)${note ? '   ⚠ DISCREPANCY' : ''}`);
      if (note) warnings.push(`${source}: ${note}`);
    }
    for (const w of warnings) console.log(`  ⚠ ${w}`);
    if (warnings.length) {
      console.log('  (reported, not acted on — no retry, no rollback, no cleanup)');
    }
  } else if (report.kb.failed) {
    console.log(`  per source file: none attempted — ${report.kb.failed.error}`);
  }
  console.log(RULE);
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
      '[--dry-run] [--force-config] [--kb-dir <path>] [--wa-token-env <NAME>] [--yes]');
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

  // ── Resolve + display the target BEFORE anything is written (§6.1) ──
  // describeTarget validates the definition through the SAME schema
  // provisionTenant uses, so the slug displayed is provably the slug the write
  // will use; then it reads the tenant row. Both the dry run and the apply path
  // go through here, which is what gives --dry-run something real to show.
  let target;
  try {
    target = await describeTarget(definition);
  } catch (err) {
    if (err instanceof DefinitionValidationError) { printIssues('Invalid definition file:', err.issues); process.exit(1); }
    console.error(`✗ cannot resolve target tenant: ${err.message}`);
    process.exit(1);
  }
  printTarget(target, opts);

  // A --kb-dir run against an unresolved slug is refused on BOTH paths. The dry
  // run refuses too, deliberately: a dry run that prints "plan is complete" for
  // a run the apply path will reject is the same class of false report as
  // D2-01's "re-run resumes".
  if (opts.kbDir && !target.found) {
    refuseUnresolvedTarget(target, opts);
    process.exit(1);
  }

  // Everything past here can write, so the confirmation goes BEFORE the call
  // rather than before the first line of output about it. A dry run is exempt
  // because it writes nothing — that is what makes it the safe way to look.
  if (!opts.dryRun) await confirmWrite(target, opts);

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
  // The target block above already read the database; this half stays what it
  // always was — the plan assembled from the definition. The two are labelled
  // separately on purpose, because conflating them is what made the old dry run
  // useless against a mis-aim.
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

  // ── Read the tenant back and report OBSERVED state (§6.3) ──
  await printReadBack(definition, report, opts);

  printNextSteps(report, opts);
  process.exit(exitCode);
}

main().catch((err) => { console.error(err); process.exit(1); });
