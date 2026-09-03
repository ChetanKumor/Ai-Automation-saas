-- Migration 031: platform actor identity (ADMIN-S3b, D-022)
--
-- Admin actions are attributable to a ROW rather than to a shared password.
-- Before this, identity after requireAuth was a boolean: every admin-originated
-- config revision recorded actor_user_id NULL, indistinguishable in the data
-- from a provisioning write, and validation_runs had no actor column at all.
--
-- WHY A NEW TABLE, NOT A WIDER `users` (D-022). users.tenant_id is NOT NULL and
-- users.role is CHECK (role IN ('owner','admin','agent')), so a platform
-- operator has no representable row there. Widening users would mean a nullable
-- tenant_id and a new role member, which hands every tenant-scoped query over
-- users a null-tenant case it does not have today — including the portal login
-- lookup, which admits a row only on `rows.length === 1` so a cross-tenant email
-- collision fails closed (INV-1). A platform row sharing an operator's email
-- would become a second match there and lock a real owner out of the portal.
--
-- platform_users has NO tenant_id and must never acquire one. That absence is
-- the property, not an omission: it makes "platform actor" unrepresentable
-- inside tenant scope by construction rather than by discipline (INV-1 / I2).
--
-- SCOPE. Attribution only. `role` carries the single value 'operator' and a
-- CHECK reserving 'support'; NOTHING READS IT. There is no per-user login —
-- ADMIN_PASSWORD remains the credential and the session resolves to a bootstrap
-- operator row. Both limits are D-022's, and both are deliberate: a role split
-- or a credential change before a second human exists is the generalisation
-- G-PAY prohibits.
--
-- Additive, forward-only. schema.sql is updated in lockstep.

-- password_hash holds a scrypt-encoded string in the portal's self-describing
-- format (`scrypt$N$r$p$salt$hash`, src/portal/auth.js) — the one hashing path
-- in the repo, never duplicated, and no new dependency. It is nullable because
-- the bootstrap row is resolved by ADMIN_PASSWORD and has no password of its
-- own; the column exists so the later per-user-login session adds behaviour,
-- not storage.
-- disabled_at is the revocation seam: NULL means active. Rows are never deleted,
-- because deleting one would orphan the audit trail it was created to carry.
CREATE TABLE platform_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'operator'
                  CHECK (role IN ('operator', 'support')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  disabled_at   TIMESTAMPTZ
);

-- A revision's actor is EITHER a tenant user (portal owner) or a platform user
-- (operator), never both, and may be neither. Neither is the provisioning case:
-- provisioningService.js writes source='provision' with no human actor at all,
-- and the CHECK accepts that state deliberately.
--
-- A SECOND COLUMN rather than a bare UUID plus a discriminator (which would
-- trade referential integrity for convenience and make a wrong id unverifiable
-- at write time), and rather than a polymorphic view (machinery for a problem
-- two columns solve). actor_user_id keeps its EXACT meaning, so every existing
-- query over it keeps behaving — including the portal history page's
-- `LEFT JOIN users u ON u.id = r.actor_user_id`, which returns NULL for a
-- platform-actor revision and renders the owner's existing "Veprio" fallback.
-- The owner still cannot see an operator's identity; the difference is that the
-- row is now distinguishable in the data from a provisioning write.
ALTER TABLE tenant_config_revisions
  ADD COLUMN actor_platform_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE tenant_config_revisions
  ADD CONSTRAINT tenant_config_revisions_one_actor
  CHECK (actor_user_id IS NULL OR actor_platform_user_id IS NULL);

-- validation_runs had NO actor column, so it takes the whole pair. Same rule,
-- same shape, same CHECK: a run is attributable to at most one actor.
ALTER TABLE validation_runs
  ADD COLUMN actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE validation_runs
  ADD COLUMN actor_platform_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE validation_runs
  ADD CONSTRAINT validation_runs_one_actor
  CHECK (actor_user_id IS NULL OR actor_platform_user_id IS NULL);
