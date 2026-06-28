-- Migration 016: add channel to conversations, fix open-conversation partial unique
-- Part of PR4: channel-agnostic storage

-- 1. Add channel column (all existing rows are whatsapp)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

-- 2. Safety: close duplicate open conversations if any exist
--    Keep the most recently updated one open; close the rest.
UPDATE conversations c
SET status = 'closed'
WHERE c.status = 'open'
  AND c.id != (
    SELECT id FROM conversations c2
    WHERE c2.tenant_id = c.tenant_id
      AND c2.customer_id = c.customer_id
      AND c2.status = 'open'
    ORDER BY c2.updated_at DESC NULLS LAST
    LIMIT 1
  );

-- 3. Drop the old partial unique (only on customer_id, missing tenant_id)
DROP INDEX IF EXISTS uniq_open_conversation_per_customer;

-- 4. Create the correct partial unique: one open conversation per (tenant, customer)
CREATE UNIQUE INDEX uniq_open_conversation
  ON conversations (tenant_id, customer_id) WHERE status = 'open';
