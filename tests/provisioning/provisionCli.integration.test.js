'use strict';

// The provisioning CLI reports the TENANT, not the argument.
//
// 05-isolation.md §A.6: on the `--kb-dir` path the tenant boundary is an
// operator typing a filename. The definition file names the TENANT, `--kb-dir`
// names the DOCUMENTS, and nothing relates them — not a naming convention, not
// a manifest, not a check. The one affordance an operator would reach for,
// `--dry-run`, returned BEFORE the slug lookup (provisioningService.js:189-207
// vs :210), so it echoed the operator's own input and was structurally
// incapable of catching a mis-aim. Mis-aimed document chunks are then invisible
// to the portal FAQ editor (faqService.js:109-112), have no admin surface, and
// are in the other clinic's prompt from the first turn.
//
// These tests drive the REAL CLI as a child process against a real scratch
// database — not the service in-process — because what is under test is what an
// operator SEES on their terminal before and after a write. Every assertion is
// on stdout/stderr and on row counts.
//
// NO GEMINI QUOTA IS SPENT and no embedding call is made. Every case here is
// either read-only (`--dry-run`), a create with no `--kb-dir`, a refusal, or a
// `--kb-dir` whose only document is ALREADY ingested — which R7's `(tenant_id,
// source)` dedup skips (provisioningService.js:136-143) before reaching
// storeChunks. T-3's real ingest lives in kbTenantBinding.integration.test.js
// and stubs the SDK transport instead.
//
// Disjoint scratch-DB prefix (zyon_pcli_) so this suite cannot drop another
// suite's database mid-genesis — the failure class state.md records at
// "the suite had a database-destroying race between test files".

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { kbDiscrepancy } = require('../../src/modules/provisioning/provisioningService');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_pcli_';
const CLI = path.join(__dirname, '../../scripts/provision-tenant.js');

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pcli\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// The database row's business_name and the definition file's are DELIBERATELY
// different. That divergence is the instrument: an output line carrying the
// first proves the display came from a read of `tenants`, and one carrying the
// second proves only that the CLI can echo its own argument back.
const DB_NAME = 'Smile Dental — THE DATABASE ROW';
const FILE_NAME = 'DEFINITION FILE NAME — NOT THE DATABASE';
const ZERO_VECTOR = `[${new Array(768).fill(0).join(',')}]`;

describe('provision-tenant CLI — target resolution, dry-run read, read-back',
  { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {

  let scratchName, scratchCs, pg, tmp, smileId;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // A plain client rather than src/db/db.js: this suite never needs the app
    // pool, and the CLI under test binds its own from the DATABASE_URL we hand
    // the child process.
    pg = new Client({ connectionString: scratchCs, ssl: SSL });
    await pg.connect();

    // The existing clinic every mis-aim in §A.6 lands in.
    const t = await pg.query(
      `INSERT INTO tenants (business_name, slug, phone_number_id, status, active)
       VALUES ($1, 'smile-dental', '900000000000001', 'live', true) RETURNING id`, [DB_NAME]);
    smileId = t.rows[0].id;
    await pg.query(
      `INSERT INTO tenant_configs (tenant_id, version, config) VALUES ($1, 1, '{}'::jsonb)`,
      [smileId]);

    // Its knowledge base: two source PREFIXES (faq / faq:te collapse to one,
    // per faqService.js:51-53's language-tag convention) plus one document.
    const seed = async (source, n) => {
      for (let i = 0; i < n; i++) {
        await pg.query(
          `INSERT INTO knowledge_chunks (tenant_id, content, embedding, source)
           VALUES ($1, $2, $3::vector, $4)`,
          [smileId, `${source} chunk ${i}`, ZERO_VECTOR, source]);
      }
    };
    await seed('faq', 3);
    await seed('faq:te', 2);
    await seed('hours.md', 4);   // 9 rows total; by prefix: faq 5, hours.md 4

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcli-'));
  });

  after(async () => {
    if (pg) await pg.end();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  let defSeq = 0;
  function defFile(slug, businessName = FILE_NAME) {
    const p = path.join(tmp, `def-${defSeq++}-${slug}.json`);
    fs.writeFileSync(p, JSON.stringify({
      slug,
      business_name: businessName,
      whatsapp: { phone_number_id: '91' + crypto.randomBytes(6).toString('hex').replace(/\D/g, '0').padEnd(12, '7') },
      config: { business: { display_name: businessName } },
    }, null, 2));
    return p;
  }

  function run(args) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: scratchCs },
      cwd: path.join(__dirname, '../..'),
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  // The text between two markers, so an assertion about the TARGET block cannot
  // be satisfied by a line that belongs to the dry-run plan or the read-back.
  function between(out, from, to) {
    const a = out.indexOf(from);
    assert.notEqual(a, -1, `expected output to contain ${JSON.stringify(from)}\n--- output ---\n${out}`);
    const b = to ? out.indexOf(to, a) : -1;
    return out.slice(a, b === -1 ? undefined : b);
  }

  const counts = async () => ({
    tenants: (await pg.query('SELECT count(*)::int n FROM tenants')).rows[0].n,
    configs: (await pg.query('SELECT count(*)::int n FROM tenant_configs')).rows[0].n,
    revisions: (await pg.query('SELECT count(*)::int n FROM tenant_config_revisions')).rows[0].n,
    chunks: (await pg.query('SELECT count(*)::int n FROM knowledge_chunks')).rows[0].n,
  });

  // ── 6.2 — --dry-run READS the target ───────────────────────────────────────

  it('--dry-run names the tenant the DATABASE holds, not the one the definition file names', async () => {
    const r = run([defFile('smile-dental'), '--dry-run']);
    assert.equal(r.status, 0, `expected exit 0\n${r.out}`);

    const target = between(r.stdout, '── Target', 'DRY RUN');

    // The whole finding in two assertions: the target block carries the row's
    // business_name and NOT the definition's. At HEAD the dry run returned
    // before the slug lookup, so it could carry only the definition's.
    assert.match(target, new RegExp(DB_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      "the target block must carry the tenant row's business_name");
    assert.doesNotMatch(target, /DEFINITION FILE NAME/,
      'the target block must not identify the tenant from the definition file');

    assert.match(target, new RegExp(`tenant id:\\s+${smileId}`), 'the resolved tenant id is shown');
    assert.match(target, /knowledge_chunks:\s+9 row\(s\)/, 'the current chunk total is read, not assumed');
    assert.match(target, /\bfaq\s+5 row\(s\)/, 'faq and faq:te collapse to one source prefix');
    assert.match(target, /hours\.md\s+4 row\(s\)/, 'the document source is broken out');
  });

  // ── 6.2 / 7.3 — and it stays strictly read-only ────────────────────────────

  it('--dry-run writes nothing: every row count is identical across the invocation', async () => {
    const before = await counts();

    const existing = run([defFile('smile-dental'), '--dry-run']);
    assert.equal(existing.status, 0, existing.out);
    const fresh = run([defFile('dry-only-clinic'), '--dry-run']);
    assert.equal(fresh.status, 0, fresh.out);

    assert.deepEqual(await counts(), before, '--dry-run must not change any row count');
    assert.equal(
      (await pg.query("SELECT count(*)::int n FROM tenants WHERE slug='dry-only-clinic'")).rows[0].n, 0,
      'a dry run against an unknown slug must not create the tenant it describes');
  });

  // ── 6.1 + 6.3 — display before the write, read-back after it ───────────────

  it('a real run shows the target BEFORE writing and reads the tenant back AFTER', async () => {
    const r = run([defFile('brand-new-clinic', 'Brand New Clinic'), '--yes']);
    assert.equal(r.status, 0, r.out);

    const iTarget = r.stdout.indexOf('── Target');
    const iWrote = r.stdout.indexOf("✓ provisioned");
    const iBack = r.stdout.indexOf('── Written');
    assert.ok(iTarget !== -1 && iWrote !== -1 && iBack !== -1,
      `expected a target block, a write line and a read-back\n${r.out}`);
    assert.ok(iTarget < iWrote, 'the target must be displayed before the first row is written');
    assert.ok(iWrote < iBack, 'the read-back must come after the write');

    // Before: the database held nothing under this slug, and says so rather
    // than reflecting the definition's fields back.
    const target = between(r.stdout, '── Target', "✓ provisioned");
    assert.match(target, /slug 'brand-new-clinic': NO TENANT with this slug exists/);

    // After: the row that now exists, read back.
    const id = (await pg.query("SELECT id FROM tenants WHERE slug='brand-new-clinic'")).rows[0].id;
    const back = between(r.stdout, '── Written', '── Next steps');
    assert.match(back, new RegExp(`tenant id:\\s+${id}`), 'the read-back names the row that was created');
    assert.match(back, /business_name:\s+Brand New Clinic/);
    assert.match(back, /status:\s+draft\s+·\s+active=false\s+·\s+config v1/);
    assert.match(back, /knowledge_chunks:\s+0 row\(s\)/, 'observed chunk state, not an assumption');
  });

  // ── 6.1(c) — the confirmation, and its non-interactive refusal ─────────────

  it('without --yes and with no terminal, the write is refused and nothing is written', async () => {
    const before = await counts();
    const r = run([defFile('unconfirmed-clinic', 'Unconfirmed Clinic')]);

    assert.notEqual(r.status, 0, `expected a nonzero exit\n${r.out}`);
    assert.match(r.out, /refusing to write/i);
    assert.match(r.out, /--yes/, 'the refusal must name the non-interactive escape hatch');
    assert.equal(
      (await pg.query("SELECT count(*)::int n FROM tenants WHERE slug='unconfirmed-clinic'")).rows[0].n, 0);
    assert.deepEqual(await counts(), before, 'an unconfirmed run must leave every count untouched');
  });

  // ── 6.3 — attempted vs observed, per source file ───────────────────────────

  it('--kb-dir reports rows ACTUALLY present per source beside what was attempted', async () => {
    const kb = path.join(tmp, 'kb-already-ingested');
    fs.mkdirSync(kb, { recursive: true });
    // `hours.md` is already ingested for this tenant (4 rows seeded above), so
    // R7's dedup skips it and storeChunks — and therefore embed — is never
    // reached. The report still has to say what is in the table.
    fs.writeFileSync(path.join(kb, 'hours.md'), 'Q: hours? A: 9-6.');

    const before = await counts();
    const r = run([defFile('smile-dental'), '--kb-dir', kb, '--yes']);
    assert.equal(r.status, 0, r.out);
    assert.equal((await counts()).chunks, before.chunks, 'an already-ingested source must not re-ingest');

    const back = between(r.stdout, '── Written', '── Next steps');
    assert.match(back, /per source file\s+\(attempted → observed\)/);
    assert.match(back, /hours\.md\s+attempted skipped\s+observed\s+4 row\(s\)/,
      'the label came from the run, the count came from the database');
    // The tenant-level read-back is the same read, unchanged by the skip.
    assert.match(back, /knowledge_chunks:\s+9 row\(s\)/);
  });

  // ── 6.1(b) — an unresolved slug on the --kb-dir path is refused outright ───

  it('--kb-dir against a slug that names no tenant refuses and writes nothing', async () => {
    const kb = path.join(tmp, 'kb-empty');
    fs.mkdirSync(kb, { recursive: true });   // no .md/.txt: no embedding is reachable even at HEAD

    const before = await counts();
    const r = run([defFile('smiledental', 'Typo Clinic'), '--kb-dir', kb, '--yes']);

    assert.notEqual(r.status, 0, `expected a nonzero exit\n${r.out}`);
    assert.match(r.out, /names no tenant/i);
    assert.match(r.out, /smiledental/, 'the refusal must name the slug that did not resolve');
    assert.match(r.out, /Nothing was written/i);
    assert.equal(
      (await pg.query("SELECT count(*)::int n FROM tenants WHERE slug='smiledental'")).rows[0].n, 0,
      'a mistyped slug must not mint a second tenant to ingest into');
    assert.deepEqual(await counts(), before);
  });
});

// The classifier behind the ⚠ marker, isolated from the terminal so its rules
// are pinned rather than inferred from a transcript. It REPORTS; §6.4 owns what
// any of these states should cause to happen.
describe('kbDiscrepancy — attempted vs observed', () => {
  it('marks only the states where the label and the table disagree', () => {
    assert.equal(kbDiscrepancy('ingested', 12), null);
    assert.equal(kbDiscrepancy('skipped', 4), null);
    assert.equal(kbDiscrepancy('failed', 0), null, 'a failure that wrote nothing is consistent');

    assert.match(kbDiscrepancy('ingested', 0), /0 rows are present/);
    assert.match(kbDiscrepancy('skipped', 0), /0 rows are present/);
    // 02-ingestion.md §D.2 / D2-01: rows 1..N-1 commit, the file is then skipped
    // forever. This is the one state the operator was previously told was clean.
    assert.match(kbDiscrepancy('failed', 7), /7 row\(s\) are present — the document is partial/);
  });
});
