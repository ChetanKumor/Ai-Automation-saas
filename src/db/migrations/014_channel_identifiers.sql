-- Migration 014: channel_identifiers table
-- Cross-channel customer identity resolution

CREATE TABLE channel_identifiers (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  identifier  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, channel_type, identifier)
);

CREATE INDEX idx_channel_identifiers_lookup
  ON channel_identifiers(tenant_id, channel_type, identifier);

CREATE INDEX idx_channel_identifiers_customer
  ON channel_identifiers(customer_id);
