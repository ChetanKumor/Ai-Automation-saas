'use strict';

// provisioningService (Issue 15) — turn a git-versioned clinic definition file
// into a fully-formed DRAFT tenant with zero manual SQL.
//
//   provisionTenant(definition, { dryRun, forceConfig, kbDir })
//
// Guarantees:
//   • Born on the renderer: new tenants get ai_prompt = NULL, status = 'draft',
//     active = false — the rendered-prompt path (Issue 10), never a legacy
//     override.
//   • Idempotency key is tenants.slug (migration 021). Re-runs are create-if-
//     missing per component; config is only rewritten behind forceConfig.
//   • Atomic core: tenant row + config v1 (+ seeds) land in ONE transaction.
//     KB ingest runs AFTER, non-transactionally, and is resumable.
//   • dryRun validates the merged config and returns the plan, writing nothing.
//
// Seed finding (documented, Issue 15 §3): existing tenant creation (the admin
// panel POST) inserts ONLY the tenants row — no workflow_rules, no CRM rows, no
// channel_identifiers. Customer / conversation / channel_identifier rows are all
// created at runtime on first contact (resolveCustomer, getOrCreateOpenConver-
// sation). workflow_rules seeding is a separate, manual, all-tenants maintenance
// script (src/modules/workflow/seedRules.js) whose rules target leads/payments,
// not the booking-confirmation flow, and is NOT part of tenant creation. So
// nothing is per-tenant required for a booking-confirmation flow beyond tenant +
// config — provisioning seeds NOTHING further by design (speculative seeds are
// how zombie config is born). The seams below are where a proven-required seed
// would go if §3 ever finds one.

const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const db = require('../../db/db');
const logger = require('../../infra/logging/logger');
const { insertTenant } = require('../tenant/tenantService');
const {
  writeTenantConfig,
  deepMerge,
  clinicDefaults,
  configSchema,
  ConfigValidationError,
} = require('../config/configService');
const { chunkText, storeChunks } = require('../knowledge/knowledgeService');

// Definition file shape. STRICT — an unknown top-level key is rejected with its
// path, so a typo (or a smuggled secret) fails loudly. Note there is deliberately
// NO wa_token / secret field anywhere: credentials attach later via the panel or
// an env-referencing CLI flag, never a provision file.
const definitionSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case'),
    business_name: z.string().min(1),
    whatsapp: z
      .object({
        phone_number_id: z.string().min(1).optional(),
        waba_id: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    // Partial tenant config; deep-merged over clinicDefaults then validated by
    // configSchema (also strict — a secret key here would be rejected there too).
    config: z.record(z.any()).optional(),
  })
  .strict();

// Thrown on a malformed definition file. Mirrors ConfigValidationError's flat
// path/message shape so the CLI renders both the same way.
class DefinitionValidationError extends Error {
  constructor(zodError) {
    super('provision definition failed validation');
    this.name = 'DefinitionValidationError';
    this.issues = zodError.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
      ...(i.keys ? { keys: i.keys } : {}),
    }));
  }
}

// Inlined config-v1 writer for the atomic create-path ONLY. It mirrors
// writeTenantConfig's revision+head write, but runs on the SAME transaction
// client as the tenant insert so the two are atomic (configService opens its own
// client and so can't join our transaction). The exists-tenant paths below use
// writeTenantConfig directly, since the tenant is already committed there. Kept
// intentionally minimal and adjacent to the merge/validate that produced `config`.
async function writeConfigV1(client, tenantId, config) {
  await client.query(
    `INSERT INTO tenant_config_revisions (tenant_id, version, config, source)
     VALUES ($1, 1, $2, 'provision')`,
    [tenantId, JSON.stringify(config)]
  );
  await client.query(
    `INSERT INTO tenant_configs (tenant_id, version, config, updated_at)
     VALUES ($1, 1, $2, now())`,
    [tenantId, JSON.stringify(config)]
  );
}

// Merge the definition's partial config over clinicDefaults and validate the
// WHOLE document strict. Throws ConfigValidationError (path-level issues, nothing
// written) on failure. Returns the parsed, defaulted config.
function materializeConfig(definition) {
  const parsed = configSchema.safeParse(deepMerge(clinicDefaults, definition.config || {}));
  if (!parsed.success) throw new ConfigValidationError(parsed.error);
  return parsed.data;
}

// Ingest every readable *.md / *.txt under kbDir for this tenant, resumably.
// A source (filename) already present in knowledge_chunks is skipped, so a
// re-run only ingests what a prior run didn't finish. Returns
// { ingested: [...], skipped: [...], failed: {source, error} | null, docs }.
// On the first failure it stops and reports — the caller maps that to exit 2.
async function ingestKnowledge(tenantId, kbDir) {
  const result = { ingested: [], skipped: [], failed: null, docs: 0 };

  let entries;
  try {
    entries = fs.readdirSync(kbDir, { withFileTypes: true });
  } catch (err) {
    result.failed = { source: kbDir, error: `cannot read --kb-dir: ${err.message}` };
    return result;
  }

  const docs = entries
    .filter((e) => e.isFile() && /\.(md|txt)$/i.test(e.name))
    .map((e) => path.join(kbDir, e.name)); // path.join normalizes separators (Windows-safe)
  result.docs = docs.length;

  for (const file of docs) {
    const source = path.basename(file);
    const { rows } = await db.query(
      'SELECT 1 FROM knowledge_chunks WHERE tenant_id = $1 AND source = $2 LIMIT 1',
      [tenantId, source]
    );
    if (rows[0]) {
      result.skipped.push(source); // already ingested — resume skips it
      continue;
    }
    try {
      const text = fs.readFileSync(file, 'utf8');
      const chunks = chunkText(text);
      await storeChunks(tenantId, chunks, source);
      result.ingested.push(source);
    } catch (err) {
      result.failed = { source, error: err.message };
      return result; // stop at first failure; re-run resumes from here
    }
  }
  return result;
}

// ── OBSERVATION — read-only, and deliberately nothing more ───────────────────
//
// 05-isolation.md §A.6 established that on the `--kb-dir` path the tenant
// boundary is an operator typing a filename: the definition file names the
// TENANT, `--kb-dir` names the DOCUMENTS, and nothing relates them. The one
// affordance an operator would reach for — `--dry-run` — returns at :189-207,
// BEFORE the slug lookup at :210, so it echoes the operator's own input and is
// structurally incapable of saying "you are about to write into Smile Dental".
//
// The three functions below are what let the CLI answer that from the DATABASE
// rather than from argv, before the write and again after it. They READ. The
// dedup rule, the skip semantics and the write order in ingestKnowledge and
// provisionTenant are untouched by this section — deciding what a discrepancy
// between what was attempted and what is present should CAUSE (resume, per-chunk
// dedup, distinguishing "fully ingested" from "partially ingested and skipped")
// is a change to write semantics and is not made here.

// Chunk counts for one tenant, grouped by SOURCE PREFIX. `faq` and `faq:te`
// collapse to one entry — that colon is faqService's language tag
// (faqService.js:51-53), not a separate corpus — while a document keeps its
// whole basename, which is the unit an operator aimed at.
// knowledgeService.countChunksBySourcePrefix answers one prefix per call, and a
// "what does this tenant already hold" display cannot enumerate the prefixes in
// advance; this is that question in one round trip.
async function chunkCountsBySource(tenantId) {
  const { rows } = await db.query(
    `SELECT split_part(coalesce(source, ''), ':', 1) AS prefix, count(*)::int AS n
       FROM knowledge_chunks
      WHERE tenant_id = $1
      GROUP BY 1
      ORDER BY 1`,
    [tenantId]
  );
  return rows.map((r) => ({ prefix: r.prefix || '(no source)', n: r.n }));
}

// What the DATABASE holds for the tenant this definition names — before a run,
// or after one. Never creates, and never falls back to the definition's own
// fields: when the slug names no row the answer is `found: false`, which is a
// fact about the database rather than a guess about intent.
//
// The definition goes through `definitionSchema`, the same validator
// provisionTenant uses, so the slug this resolves is provably the slug the write
// will use. Re-deriving it in the CLI would let the display and the write drift
// apart, which is the failure this whole function exists to make visible.
async function describeTarget(definition) {
  const parsed = definitionSchema.safeParse(definition);
  if (!parsed.success) throw new DefinitionValidationError(parsed.error);
  const slug = parsed.data.slug;

  const { rows } = await db.query(
    'SELECT id, business_name, slug, status, active FROM tenants WHERE slug = $1',
    [slug]
  );
  if (!rows[0]) {
    return { slug, found: false, tenant: null, config_version: null, chunks: [], chunk_total: 0 };
  }

  const tenant = rows[0];
  const chunks = await chunkCountsBySource(tenant.id);
  const { rows: cfg } = await db.query(
    'SELECT version FROM tenant_configs WHERE tenant_id = $1',
    [tenant.id]
  );

  return {
    slug,
    found: true,
    tenant,
    config_version: cfg[0] ? cfg[0].version : null,
    chunks,
    chunk_total: chunks.reduce((sum, c) => sum + c.n, 0),
  };
}

// Rows ACTUALLY PRESENT for each named source. `ingestKnowledge`'s
// ingested/skipped/failed labels are assembled from what the run asked for; this
// is the other half of the sentence. Exact `source` match, because that is the
// key the ingest writes and dedups on (:135-139) — a prefix match here would
// answer a different question from the one the run acted on.
async function observeSources(tenantId, sources) {
  if (!sources.length) return new Map();
  const { rows } = await db.query(
    `SELECT source, count(*)::int AS n FROM knowledge_chunks
      WHERE tenant_id = $1 AND source = ANY($2::text[])
      GROUP BY source`,
    [tenantId, sources]
  );
  return new Map(rows.map((r) => [r.source, r.n]));
}

// Does the label the run assigned disagree with what the table holds? Returns
// the sentence to show, or null when the two are consistent. Pure, and reporting
// only — every caller prints this and does nothing else with it.
//
// The `failed` + rows-present case is 02-ingestion.md's D2-01 made visible:
// storeChunks commits row by row with no transaction, so a failure at chunk N
// leaves rows 1..N-1 permanently committed, and the `source` dedup then skips
// that file forever while the CLI reports the re-run as clean.
function kbDiscrepancy(state, observed) {
  if (state === 'ingested' && observed === 0) return 'reported ingested, but 0 rows are present';
  if (state === 'skipped' && observed === 0) return 'reported already-ingested, but 0 rows are present';
  if (state === 'failed' && observed > 0) {
    return `reported FAILED, but ${observed} row(s) are present — the document is partial`;
  }
  return null;
}

// Provision (or reconcile) a tenant from a definition object.
//
// Returns a structured report:
//   { slug, tenant_id, created: [...], skipped: [...], config_version,
//     warnings: [...], dry_run, plan?, kb? }
//
// created/skipped list component labels ('tenant', 'config@vN'). Throws
// DefinitionValidationError or ConfigValidationError (nothing written) on invalid
// input. KB failures do NOT throw — they surface in report.kb for the CLI to map
// to exit 2, leaving a valid tenant behind.
async function provisionTenant(definition, opts = {}) {
  const { dryRun = false, forceConfig = false, kbDir = null } = opts;

  // 1. Validate the definition shape, then materialize + validate the config.
  const defParsed = definitionSchema.safeParse(definition);
  if (!defParsed.success) throw new DefinitionValidationError(defParsed.error);
  const def = defParsed.data;
  const config = materializeConfig(def); // throws ConfigValidationError if invalid

  const wa = def.whatsapp || {};
  const report = {
    slug: def.slug,
    tenant_id: null,
    created: [],
    skipped: [],
    config_version: null,
    warnings: [],
    dry_run: dryRun,
  };

  // 2. Dry-run: prove the plan without writing. Row counts are unchanged (tests
  // assert this). We still validated above, so an invalid config already threw.
  if (dryRun) {
    report.plan = {
      tenant: {
        slug: def.slug,
        business_name: def.business_name,
        phone_number_id: wa.phone_number_id || null,
        waba_id: wa.waba_id || null,
        ai_prompt: null,
        status: 'draft',
        active: false,
      },
      config_version: 1,
      config_display_name: config.business.display_name,
      seeds: [], // see seed finding at top of file
      kb_dir: kbDir || null,
    };
    report.config_valid = true;
    return report;
  }

  // 3. Does this slug already exist? The idempotency pivot.
  const existing = await db.query(
    'SELECT id FROM tenants WHERE slug = $1',
    [def.slug]
  );

  if (!existing.rows[0]) {
    // ── CREATE PATH: tenant + config v1 (+ seeds) atomic in one transaction ──
    const client = await db.getClient();
    let tenantId;
    try {
      await client.query('BEGIN');
      const tenant = await insertTenant(client, {
        business_name: def.business_name,
        slug: def.slug,
        phone_number_id: wa.phone_number_id || null,
        waba_id: wa.waba_id || null,
        ai_prompt: null,   // born on the renderer
        active: false,     // born inactive
        status: 'draft',
      });
      tenantId = tenant.id;
      await writeConfigV1(client, tenantId, config);
      // Seeds would go here (same transaction). None required — see seed finding.
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Unique-violation races surface as a clean message, not a stack trace. The
      // constraint name says WHICH natural key collided so the operator gets an
      // accurate diagnosis: a slug re-run vs. a WhatsApp number already attached
      // to another tenant (both are real, and they need different remedies).
      if (err.code === '23505') {
        const reason = err.constraint === 'tenants_phone_number_id_key'
          ? `phone_number_id '${wa.phone_number_id}' is already attached to another tenant`
          : `slug '${def.slug}' already exists`;
        const e = new Error(`${reason} (unique violation)`);
        e.code = 'PROVISION_CONFLICT';
        throw e;
      }
      throw err;
    } finally {
      client.release();
    }

    report.tenant_id = tenantId;
    report.created.push('tenant', 'config@v1');
    report.config_version = 1;
    logger.info({ scope: 'provision', slug: def.slug, tenantId }, 'tenant provisioned (create)');
  } else {
    // ── RECONCILE PATH: create-if-missing per component ──
    const tenantId = existing.rows[0].id;
    report.tenant_id = tenantId;
    report.skipped.push('tenant'); // exists, skipping

    const { rows: cfgRows } = await db.query(
      'SELECT version FROM tenant_configs WHERE tenant_id = $1',
      [tenantId]
    );

    if (!cfgRows[0]) {
      // Tenant exists (e.g. panel-created) but has no config — fill v1.
      const { version } = await writeTenantConfig(tenantId, def.config || {}, 'provision');
      report.created.push(`config@v${version}`);
      report.config_version = version;
    } else if (forceConfig) {
      const { version } = await writeTenantConfig(tenantId, def.config || {}, 'provision');
      report.created.push(`config@v${version}`);
      report.config_version = version;
    } else {
      report.skipped.push(`config@v${cfgRows[0].version}`); // exists, skipping
      report.config_version = cfgRows[0].version;
    }
    logger.info({ scope: 'provision', slug: def.slug, tenantId }, 'tenant reconciled (re-run)');
  }

  // 4. KB ingest — AFTER the transaction, non-transactional, resumable.
  if (kbDir) {
    const kb = await ingestKnowledge(report.tenant_id, kbDir);
    report.kb = kb;
    if (kb.docs === 0) {
      report.warnings.push(`--kb-dir '${kbDir}' has no readable .md/.txt docs`);
    }
  }

  return report;
}

module.exports = {
  provisionTenant,
  definitionSchema,
  DefinitionValidationError,
  // read-only observation (see the OBSERVATION block above)
  describeTarget,
  chunkCountsBySource,
  observeSources,
  kbDiscrepancy,
  // exported for focused tests
  materializeConfig,
  ingestKnowledge,
};
