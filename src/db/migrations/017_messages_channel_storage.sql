-- Migration 017: channel-agnostic message storage; relocate wamid dedup
-- Part of PR4: channel-agnostic storage

-- 1. Add new columns
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_ref TEXT;

-- 2. Backfill external_id from wamid (idempotent)
UPDATE messages SET external_id = wamid
WHERE wamid IS NOT NULL AND external_id IS NULL;

-- 3. Drop the old wamid UNIQUE constraint (keep the column)
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_wamid_key;

-- 4. Create the relocated dedup index: tenant + channel scoped
CREATE UNIQUE INDEX IF NOT EXISTS uniq_msg_external
  ON messages (tenant_id, channel, external_id) WHERE external_id IS NOT NULL;
