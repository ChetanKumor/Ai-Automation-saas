-- Migration 024: record the acting user on every config revision (PORTAL-P2-S4)
--
-- INV-4 (spec §3): every config revision records the acting user id. The portal
-- write path (owner edits a config section) must attribute the change to the
-- owner who made it; the S17 History page then shows "who changed what, when".
--
-- Nullable by design: historical revisions predate this column, and operator/CLI
-- writes (source 'admin' | 'cli' | 'provision') have no portal user — those keep
-- actor_user_id NULL and rely on `source` for provenance. ON DELETE SET NULL so
-- deleting a user never cascades away the immutable revision history.
--
-- Additive, forward-only. schema.sql is updated in lockstep.

ALTER TABLE tenant_config_revisions
  ADD COLUMN actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
