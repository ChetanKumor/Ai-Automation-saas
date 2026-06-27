-- Handoff: owner takeover tracking column + audit table

-- Column on tenants to track which customer the owner is actively handling
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS active_handoff_customer TEXT;

-- Audit log of owner interventions
CREATE TABLE IF NOT EXISTS handoff_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  started_by     TEXT NOT NULL,
  message_count  INTEGER NOT NULL DEFAULT 0,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_handoff_sessions_tenant ON handoff_sessions(tenant_id);

-- One open session per customer per tenant at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_sessions_active
  ON handoff_sessions(tenant_id, customer_id)
  WHERE ended_at IS NULL;
