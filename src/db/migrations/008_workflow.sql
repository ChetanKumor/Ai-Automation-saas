-- Workflow engine: rules + execution log

CREATE TABLE IF NOT EXISTS workflow_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  trigger_event  TEXT NOT NULL,
  conditions     JSONB NOT NULL DEFAULT '{}',
  action         TEXT NOT NULL,
  action_params  JSONB NOT NULL DEFAULT '{}',
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_rules_tenant_event
  ON workflow_rules(tenant_id, trigger_event)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS workflow_executions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  rule_id     UUID NOT NULL REFERENCES workflow_rules(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(rule_id, event_id)
);
