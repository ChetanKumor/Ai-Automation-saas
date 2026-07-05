-- Migration 019: retire the legacy `wamid` column (pre-launch drop)
--
-- No production exists, so the dual-write compatibility rationale from PR4 /
-- migration 017 is void. `external_id` — unique per (tenant, channel) via
-- uniq_msg_external — is now the sole message identifier. This supersedes the
-- deferred post-launch drop (old "PR8"); it must land before the genesis deploy
-- or it reverts to expand-contract with a verification window.
--
-- Dedup semantics are UNCHANGED: the message insert's ON CONFLICT target remains
-- uniq_msg_external (tenant_id, channel, external_id) WHERE external_id IS NOT NULL.
-- This migration only removes the retired storage column and its dual-write.

ALTER TABLE messages DROP COLUMN IF EXISTS wamid;
