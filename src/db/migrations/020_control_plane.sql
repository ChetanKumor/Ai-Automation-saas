-- Migration 020: control-plane schema (Issue 7)
--
-- The FIRST real migration applied by the Issue 6 runner. Storage only — no
-- runtime code reads these objects yet (configService is Issue 8, provisioning
-- is Issue 15, activation is Issue 17). schema.sql is updated in lockstep.
--
-- What lands:
--   • tenant_configs          — one versioned JSONB config row per tenant.
--   • tenant_config_revisions — append-only history of every config version.
--   • validation_runs         — log of activation-gate validation outcomes.
--   • tenants.status          — CHECK'd lifecycle (draft/validated/live/paused),
--                               backfilled from the existing `active` boolean.
--
-- The database enforces NO JSON shape here — JSONB stays shape-agnostic; the Zod
-- schema is application-level (Issue 8). `tenants.active` stays authoritative for
-- runtime until Issue 17 reconciles it against `status`; this migration only adds
-- the column and backfills it. Forward-only, no down-migration.

-- 1. One config row per tenant. tenant_id IS the primary key (one row / tenant).
CREATE TABLE IF NOT EXISTS tenant_configs (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  version     int NOT NULL DEFAULT 1,
  config      jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 2. Append-only revision history. One row per (tenant, version).
CREATE TABLE IF NOT EXISTS tenant_config_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version     int NOT NULL,
  config      jsonb NOT NULL,
  source      text NOT NULL,             -- 'provision' | 'admin' | 'cli' (free text, no enum)
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

CREATE INDEX IF NOT EXISTS idx_tenant_config_revisions_tenant_version
  ON tenant_config_revisions (tenant_id, version DESC);

-- 3. Validation run log (per-check outcomes live in `result`).
CREATE TABLE IF NOT EXISTS validation_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  passed      boolean NOT NULL,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_validation_runs_tenant_created
  ON validation_runs (tenant_id, created_at DESC);

-- 4. Tenant lifecycle column. New tenants default to 'draft' (provisioning owns
--    them from Issue 15 on); existing tenants are backfilled from `active`.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'validated', 'live', 'paused'));

-- Backfill: active tenants are 'live', the rest 'paused'. Deterministic from
-- `active`, so a no-op on an empty tenants table and safe under the runner's
-- one-transaction wrapping. Does NOT touch `active`.
UPDATE tenants
   SET status = CASE WHEN active THEN 'live' ELSE 'paused' END;
