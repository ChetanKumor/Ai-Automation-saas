-- Migration 015: backfill channel_identifiers from customers.phone
-- Idempotent — safe to re-run via ON CONFLICT DO NOTHING

INSERT INTO channel_identifiers
  (tenant_id, customer_id, channel_type, identifier)
SELECT tenant_id, id, 'whatsapp', phone
FROM customers
WHERE phone IS NOT NULL
  AND btrim(phone) <> ''
ON CONFLICT (tenant_id, channel_type, identifier)
DO NOTHING;
