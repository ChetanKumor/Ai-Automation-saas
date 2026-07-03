-- ============================================================================
-- seed_voice_test_customer.sql — static psql mirror of
-- scripts/seed_voice_test_customer.js (the PR7 local voice e2e fixture).
--
-- Seeds a RETURNING customer (prior WhatsApp history + memory) so call/start
-- resolves the dev caller to an EXISTING open conversation and the voice reply
-- reflects prior history/memory (the "one customer / conversation / memory" proof).
--
-- ⚠  wa_token must be an APP-ENCRYPTED value (AES-256-GCM, format iv:tag:data,
--    using ENCRYPTION_KEY). psql cannot produce it. For a WORKING voice turn,
--    prefer the JS seed:  node scripts/seed_voice_test_customer.js
--    (or paste an app-encrypted token into :wa_token below). This SQL otherwise
--    seeds identity/history/memory faithfully.
--
-- Run:  psql "$DATABASE_URL" -f scripts/seed_voice_test_customer.sql
-- ============================================================================

\set tenant_id        '11111111-1111-1111-1111-111111111111'
\set caller           '+919000000001'
\set phone_number_id  'pnid_voice_dev'
\set wa_token         'REPLACE_WITH_APP_ENCRYPTED_WA_TOKEN'

-- 1. Tenant
INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
VALUES (:'tenant_id', 'Smile Dental (Voice Dev)', :'phone_number_id', :'wa_token',
        'You are the friendly receptionist for Smile Dental. Help callers with dental queries and appointments.',
        true, true)
ON CONFLICT (id) DO UPDATE SET
  business_name   = EXCLUDED.business_name,
  phone_number_id = EXCLUDED.phone_number_id,
  ai_prompt       = EXCLUDED.ai_prompt,
  ai_enabled      = true,
  active          = true;

-- 2. Doctor schedule (so a "book an appointment" turn can fire book_appointment)
DELETE FROM tenant_entities WHERE tenant_id = :'tenant_id' AND type = 'schedule';
INSERT INTO tenant_entities (tenant_id, type, data)
VALUES (:'tenant_id', 'schedule',
        '{"doctor":"Dr. Rao","days":["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],"start":"09:00","end":"18:00","slot_minutes":30}');

-- 3. Returning customer (preferred_language left NULL → first STT detection persists it)
INSERT INTO customers (tenant_id, phone, name, last_seen_at)
VALUES (:'tenant_id', :'caller', 'Ravi Kumar', NOW())
ON CONFLICT (tenant_id, phone) DO UPDATE SET name = EXCLUDED.name, last_seen_at = NOW();

-- 4. WhatsApp identifier (the prior channel; voice gets linked at call/start)
INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
SELECT :'tenant_id', c.id, 'whatsapp', :'caller'
FROM customers c WHERE c.tenant_id = :'tenant_id' AND c.phone = :'caller'
ON CONFLICT (tenant_id, channel_type, identifier) DO NOTHING;

-- 5. The customer's single OPEN conversation (call/start REUSES this row)
INSERT INTO conversations (tenant_id, customer_id, channel)
SELECT :'tenant_id', c.id, 'whatsapp'
FROM customers c WHERE c.tenant_id = :'tenant_id' AND c.phone = :'caller'
ON CONFLICT (tenant_id, customer_id) WHERE status = 'open'
DO UPDATE SET updated_at = NOW();

-- 6. Prior WhatsApp history (reset + reseed; created_at offsets preserve order)
DELETE FROM messages m USING conversations conv, customers c
 WHERE m.conversation_id = conv.id AND conv.customer_id = c.id
   AND c.tenant_id = :'tenant_id' AND c.phone = :'caller';

INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type, created_at)
SELECT :'tenant_id', conv.id, c.id, v.direction, v.sender, v.content, 'whatsapp', 'text',
       NOW() - ((10 - v.ord) * INTERVAL '1 second')
FROM customers c
JOIN conversations conv ON conv.customer_id = c.id AND conv.status = 'open'
CROSS JOIN (VALUES
  ('inbound',  'customer', 'Namaste, naa peru Ravi. Meeru dental checkup chestara?',                      1),
  ('outbound', 'ai',       'Namaste Ravi! Avunu, Dr. Rao tho dental checkup available. Meeku appointment kavala?', 2),
  ('inbound',  'customer', 'Tarvata cheptanu, thanks.',                                                    3)
) AS v(direction, sender, content, ord)
WHERE c.tenant_id = :'tenant_id' AND c.phone = :'caller';

-- 7. Long-term memory the brain should reflect on the voice call
INSERT INTO customer_memory (tenant_id, customer_id, key, value, source)
SELECT :'tenant_id', c.id, 'interest', 'dental checkup', 'ai'
FROM customers c WHERE c.tenant_id = :'tenant_id' AND c.phone = :'caller'
ON CONFLICT (customer_id, key) DO UPDATE SET value = EXCLUDED.value;
