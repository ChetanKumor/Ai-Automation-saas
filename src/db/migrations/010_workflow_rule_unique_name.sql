-- Add UNIQUE constraint on (tenant_id, name) for idempotent rule seeding.

ALTER TABLE workflow_rules
  ADD CONSTRAINT uniq_rule_name_per_tenant UNIQUE (tenant_id, name);
