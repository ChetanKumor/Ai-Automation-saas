-- Migration 021: tenant slug (provisioning idempotency key) + conversations
-- list index (Issue 15; closes the Issue 26 EXPLAIN follow-up).
--
-- What lands:
--   • tenants.slug TEXT UNIQUE — the natural key provisionTenant() re-runs
--     against. Nullable so credential-less/legacy inserts keep working. Chosen
--     over phone_number_id because voice-first tenants may have no PNID at
--     provision time. Existing tenants are backfilled with a derived slug.
--   • idx_conversations_tenant_updated — composite index matching the admin
--     conversations list's WHERE (tenant_id) + ORDER BY (updated_at DESC,
--     id DESC), eliminating the Sort node the Issue 26 EXPLAIN flagged.
--
-- Additive and forward-only. slug stays nullable, so no existing insert breaks.
-- schema.sql is updated in lockstep.

ALTER TABLE tenants ADD COLUMN slug TEXT;

-- Backfill legacy tenants with a derived, guaranteed-unique slug: business_name
-- slugified + a short id suffix. The id suffix guarantees uniqueness even for
-- duplicate business names, so the UNIQUE constraint below can never trip on
-- existing data. Real provisioned tenants supply their own slug and never hit
-- this path.
UPDATE tenants
SET slug = trim(BOTH '-' FROM regexp_replace(lower(coalesce(business_name, 'tenant')), '[^a-z0-9]+', '-', 'g'))
           || '-' || substr(id::text, 1, 8)
WHERE slug IS NULL;

ALTER TABLE tenants ADD CONSTRAINT tenants_slug_key UNIQUE (slug);

-- Serves the admin conversations list (Issue 26): filter by tenant, keyset
-- paginate + ORDER BY (updated_at DESC, id DESC) served straight from the index.
CREATE INDEX idx_conversations_tenant_updated ON conversations(tenant_id, updated_at DESC, id DESC);
