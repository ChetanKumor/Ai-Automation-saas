-- Migration 018: voice channel — call_sessions + language prior
-- Part of PR6: Voice channel into the existing conversation brain.
--
-- ADDITIVE ONLY. Reversible:
--   DROP TABLE call_sessions;
--   ALTER TABLE customers DROP COLUMN preferred_language;
--
-- NOTE: NOT applied in prod until the dedicated deploy phase, and MUST NOT be
-- batched with the PR8 wamid-column drop.

-- 1. Per-call session record (one row per phone call; turns live in `messages`)
CREATE TABLE IF NOT EXISTS call_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  provider          text NOT NULL,
  external_call_id  text,
  direction         text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_number       text,
  to_number         text,
  language_detected text,
  status            text NOT NULL CHECK (status IN ('initiated','in_progress','completed','failed')),
  started_at        timestamptz,
  ended_at          timestamptz,
  duration_seconds  int,
  recording_url     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 2. Language prior on the customer (detection from STT only fills this when null)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferred_language text NULL;

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant_customer
  ON call_sessions (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_external
  ON call_sessions (external_call_id);
