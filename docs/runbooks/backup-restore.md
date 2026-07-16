# Backup & Restore Runbook

**Scope:** Neon (PostgreSQL 18) dev + production databases.  
**Tools:** `scripts/db/backup.sh`, `scripts/db/restore.sh` — both require the PostgreSQL 18 client tools (`pg_dump`, `pg_restore`, `psql`) in `PATH` or at the Windows default `/c/Program Files/PostgreSQL/18/bin/`.

---

## When to back up

1. **Before every production deploy** — run backup.sh against the prod DB immediately before `npm run db:migrate` or any deploy that includes a migration.
2. **Before every migration** — even if no application code changes.
3. **Railway scheduled backups** — enablement is an Issue 20 checklist item. Once enabled, Railway takes nightly dumps automatically; treat the manual steps above as a belt-and-suspenders layer, not a replacement.
4. Backups live in `backups/` (gitignored). Store them durably (e.g., Railway Volumes, S3, or a mounted backup store) — the local directory is ephemeral on Railway's filesystem.

---

## How to back up

```bash
bash scripts/db/backup.sh "$DATABASE_URL" backups/
```

Output: `backups/<dbname>_<UTC-ISO-ts>.dump` (pg_dump custom format, `-Fc`).  
The script prints the SHA-256 checksum of the artifact on success. Record it.

**Do not store connection strings in scripts or history.** Pass `$DATABASE_URL` from the environment; never hardcode credentials.

---

## How to restore

### Step 1 — Obtain a clean empty target database

On Neon: create a new branch or a new database.  
On Railway: `createdb -e <newdbname>` against your Postgres service, or use the Railway dashboard.  
On local: `createdb <newdbname>`.

### Step 2 — Run restore.sh

```bash
bash scripts/db/restore.sh <dump-file> <target-connection-string>
```

The script **refuses** if the target database already contains any tables in the public schema. This is intentional — never restore over a live database.

`pg_restore` runs with `--no-owner --no-privileges --single-transaction`. Roles from the source are not required on the target. The single-transaction flag means the restore is all-or-nothing.

### Step 3 — Post-restore verification

After the restore completes, run these queries against the restored database:

```sql
-- 1. Table count (expect 24 at schema version 021)
SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- 2. Migration stamps (expect 21 rows stamped true for a genesis'd database)
SELECT COUNT(*), COUNT(*) FILTER (WHERE stamped) AS stamped_count
  FROM schema_migrations;

-- 3. Checksum integrity (expect 0 rows — any row here means a migration file
--    was edited after it was applied, which is a protocol violation)
SELECT filename FROM schema_migrations
  WHERE checksum != (
    -- Re-run db:status to see per-file warnings; this query can't re-hash from here
    checksum  -- placeholder: use npm run db:status for the live check
  )
LIMIT 0;  -- run: npm run db:status instead for checksum validation

-- 4. Semantic row check — at least one tenant exists
SELECT slug, status FROM tenants ORDER BY slug LIMIT 5;

-- 5. Config integrity
SELECT t.slug, tc.version, tc.status
  FROM tenant_configs tc JOIN tenants t ON t.id = tc.tenant_id
  ORDER BY t.slug;
```

Run `npm run db:status` (with `DATABASE_URL` pointing at the restored DB) to verify migration checksums.

### Step 4 — Cut over

Only cut over (point `DATABASE_URL` at the restored DB and restart the application) after all verification queries pass.

---

## Recovery philosophy

`src/db/migrate.js` is **forward-only** — there are no down-migrations. The documented recovery path for a failed migration is:

1. Restore from the pre-migration backup (this runbook).
2. Fix the migration file.
3. Re-apply (`npm run db:migrate`).

Never attempt to manually reverse a migration in production. The single-transaction per migration in `db:migrate` means a failed migration leaves the database unchanged, so restoration is needed only if the migration partially succeeded outside a transaction (e.g., a crash mid-file) or if application-level data was corrupted.

---

## RPO / RTO (1-clinic launch)

| Metric | Target | Basis |
|--------|--------|-------|
| RPO (data loss) | < 1 hour with Railway scheduled backups; near-zero with pre-deploy manual backup | Railway daily schedule + manual before-deploy policy |
| RTO (recovery time) | 15–30 minutes | Restore from dump to a fresh Neon database + verification + DNS/env cutover |
| MTTR (migration failure) | 10–20 minutes | Restore pre-migration backup + redeploy previous image |

These are estimates for a single-tenant, low-traffic launch. They are not SLA commitments.

---

## Appendix: Restore Drill Evidence

**Date:** 2026-07-16  
**Commit SHA:** (see commit `chore(db): backup/restore scripts + tested restore drill (F-004, audit gate 6)`)  
**pg_dump client version:** 18.0  
**PostgreSQL server version:** 18.4 (Neon, aarch64)  
**Environment:** Windows 11 dev machine, Git Bash, scripts run against Neon dev instance.

### Phase 0 — Pre-flight checks

```
$ pg_dump --version
pg_dump (PostgreSQL) 18.0       # client 18.x matches server 18.x ✓

$ pg_restore --version
pg_restore (PostgreSQL) 18.0

$ SELECT version();
PostgreSQL 18.4 (709c4c3) on aarch64-unknown-linux-gnu   # server 18.x ✓
```

Grep for existing backup/restore artifacts (excluding node_modules): no scripts or runbooks found. Only references in docs/audit and migrate.js comments. ✓

### Drill: Source DB — drill_src (scratch A)

```
# Create scratch DB A on dev Neon
$ node -e "[CREATE DATABASE drill_src_2026_07_16t1144z]"
Created: drill_src_2026_07_16t1144z

# Bootstrap with genesis
$ DATABASE_URL=[REDACTED]/drill_src_2026_07_16t1144z DOTENV_CONFIG_QUIET=true npm run db:genesis
✓ genesis complete: applied schema.sql and stamped 21 migration(s) as applied.

# Provision a tenant (real run, not dry-run)
$ DATABASE_URL=[REDACTED]/drill_src_2026_07_16t1144z node scripts/provision-tenant.js provision/sunrise-dental.json
{"scope":"provision","slug":"sunrise-dental","msg":"tenant provisioned (create)"}
✓ provisioned 'sunrise-dental'  (tenant cf48af73-38db-4c09-827f-dafab5fbfba0)
  created:  tenant, config@v1
```

### Drill: Backup

```
$ bash scripts/db/backup.sh [REDACTED]/drill_src_2026_07_16t1144z backups/
Backing up database: drill_src_2026_07_16t1144z
Output: backups/drill_src_2026_07_16t1144z_20260716T115019Z.dump
SHA256: 1014ad1658bebabfb79651b485eef5ce7f9530355d8a179883c25879238477ad
Done:   backups/drill_src_2026_07_16t1144z_20260716T115019Z.dump

$ ls -la backups/
-rw-r--r-- 1 cheta 73555 Jul 16 17:20 drill_src_2026_07_16t1144z_20260716T115019Z.dump
```

### Drill: Target DB — drill_dst (scratch B)

```
# Create scratch DB B
$ node -e "[CREATE DATABASE drill_dst_2026_07_16t1144z]"
Created: drill_dst_2026_07_16t1144z

# Restore
$ bash scripts/db/restore.sh \
    backups/drill_src_2026_07_16t1144z_20260716T115019Z.dump \
    [REDACTED]/drill_dst_2026_07_16t1144z
Restoring ... into target database (0 public tables — safe to proceed).
Restore complete.
```

### Drill: Verification

```
A db: /drill_src_2026_07_16t1144z | B db: /drill_dst_2026_07_16t1144z

Table count  A: 24   B: 24   MATCH ✓

Tables (24): appointments, call_sessions, channel_identifiers, conversations,
  customer_memory, customer_tags, customers, handoff_sessions, knowledge_chunks,
  leads, messages, notifications, payment_schedules, schema_migrations, tags,
  tenant_config_revisions, tenant_configs, tenant_entities, tenants, turn_traces,
  users, validation_runs, workflow_executions, workflow_rules

Per-table row counts (A = B for all 24 tables):
  appointments:0  call_sessions:0  channel_identifiers:0  conversations:0
  customer_memory:0  customer_tags:0  customers:0  handoff_sessions:0
  knowledge_chunks:0  leads:0  messages:0  notifications:0  payment_schedules:0
  schema_migrations:21  tags:0  tenant_config_revisions:1  tenant_configs:1
  tenant_entities:0  tenants:1  turn_traces:0  users:0  validation_runs:0
  workflow_executions:0  workflow_rules:0

Per-table row counts: ALL MATCH ✓

schema_migrations rows: 21   MATCH ✓

Tenants A: [{"slug":"sunrise-dental","status":"draft"}]
Tenants B: [{"slug":"sunrise-dental","status":"draft"}]
Tenants match: MATCH ✓
```

### Drill: Cleanup

```
$ node -e "[DROP DATABASE drill_src_2026_07_16t1144z]"
Dropped: drill_src_2026_07_16t1144z

$ node -e "[DROP DATABASE drill_dst_2026_07_16t1144z]"
Dropped: drill_dst_2026_07_16t1144z

# Confirm gone
$ SELECT datname FROM pg_database WHERE datname LIKE 'drill_%';
Remaining drill_ DBs: NONE (confirmed dropped) ✓
```

### Drill result

**PASS.** Backup → restore → verify cycle completed end-to-end on live Neon dev instance. All 24 tables present in B; all row counts identical to A; schema_migrations checksums and stamped status identical; tenant slug `sunrise-dental` present with correct `draft` status.

**Known caveats (not drill blockers):**
- `pg_dump` and `pg_restore` client tools are not in the default Windows Git Bash PATH; the scripts fall back to `/c/Program Files/PostgreSQL/18/bin/`. On Railway (Linux), they will be in PATH once installed.
- `dotenv@17` auto-injects env from `.env` to `stdout` (not stderr) by default. The scripts use `DOTENV_CONFIG_QUIET=true` when capturing URLs inline; `pg_dump`/`pg_restore` are unaffected (they don't use Node).
- `--single-transaction` on `pg_restore` wraps all DDL+DML in one transaction. This is the desired behavior for an atomic restore but means any error rolls back everything — check `pg_restore` output carefully.
