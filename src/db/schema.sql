-- ============================================================
--  WhatsApp AI CRM — Foundation Database Schema
--  PostgreSQL
--
--  Design goals:
--   • Multi-tenant (one platform, many businesses)
--   • AI + Human coexistence (mode lives on each conversation)
--   • Memory (short-term = messages, long-term = facts + summary)
--   • Idempotent message handling (wamid is UNIQUE)
--   • Clean to extend later (workflows, billing, etc.)
-- ============================================================


-- ── OPTIONAL RESET ──────────────────────────────────────────
--  DANGER: this deletes ALL data. Only use when rebuilding.
--  Uncomment the block below to wipe and start clean.
-- DROP TABLE IF EXISTS customer_memory CASCADE;
-- DROP TABLE IF EXISTS customer_tags    CASCADE;
-- DROP TABLE IF EXISTS tags             CASCADE;
-- DROP TABLE IF EXISTS messages         CASCADE;
-- DROP TABLE IF EXISTS conversations    CASCADE;
-- DROP TABLE IF EXISTS customers        CASCADE;
-- DROP TABLE IF EXISTS users            CASCADE;
-- DROP TABLE IF EXISTS tenants          CASCADE;


-- ── SETUP ───────────────────────────────────────────────────
-- gen_random_uuid() for UUID primary keys
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Reusable trigger: auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
--  1. TENANTS  — the businesses using your platform
-- ============================================================
CREATE TABLE tenants (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name    TEXT NOT NULL,

  -- WhatsApp / Meta credentials
  phone_number_id  TEXT UNIQUE,        -- Meta WhatsApp phone number id
  wa_token         TEXT,               -- Meta access token (encrypt in production)
  waba_id          TEXT,               -- WhatsApp Business Account id (optional)

  -- AI config
  ai_prompt        TEXT,               -- base system prompt for this business
  ai_enabled       BOOLEAN NOT NULL DEFAULT TRUE,

  -- Booking notifications
  owner_notify_phone TEXT,              -- clinic's WhatsApp number for alerts

  -- Human handoff
  active_handoff_customer TEXT,            -- phone of customer owner is currently handling (null = none)

  -- Appointment reminders
  reminder_hours_before INTEGER NOT NULL DEFAULT 24,
  reminders_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_template_id  TEXT,           -- Meta-approved template ID (null = free-text only)

  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
--  2. USERS  — people who log into the dashboard (agents/owners)
--     Needed for auth + assigning conversations to a human.
-- ============================================================
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,        -- store a hash, never the raw password
  full_name      TEXT,
  role           TEXT NOT NULL DEFAULT 'agent'
                   CHECK (role IN ('owner', 'admin', 'agent')),

  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, email)
);

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
--  3. CUSTOMERS  — the end users who message a business on WhatsApp
--     This is your CRM contact record.
-- ============================================================
CREATE TABLE customers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  phone              TEXT NOT NULL,     -- WhatsApp number (E.164, e.g. 919876543210)
  name               TEXT,              -- WhatsApp profile name or CRM-edited name
  email              TEXT,
  notes              TEXT,              -- free-form notes written by a human agent

  preferred_language TEXT,              -- 'en' / 'hi' / 'te' ...
  last_seen_at       TIMESTAMPTZ,       -- updated on each inbound message

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, phone)             -- one record per number per business
);

CREATE INDEX idx_customers_tenant ON customers(tenant_id);

CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
--  4. CONVERSATIONS  — THE CORE OF COEXISTENCE MODE
--     Each conversation carries its own AI/Human state so the
--     AI can be switched off instantly when a human takes over.
-- ============================================================
CREATE TABLE conversations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- AI + Human coexistence
  mode              TEXT NOT NULL DEFAULT 'ai'
                      CHECK (mode IN ('ai', 'human')),
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'closed', 'pending')),
  assigned_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Long-term memory: a rolling summary of older messages.
  -- Lets you send the AI a short summary instead of 100 messages (saves tokens).
  summary           TEXT,

  last_message_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversations_customer      ON conversations(customer_id);
CREATE INDEX idx_conversations_tenant_status ON conversations(tenant_id, status);

-- Guarantee only ONE open conversation per customer at a time.
-- This single line prevents duplicate-thread bugs.
CREATE UNIQUE INDEX uniq_open_conversation_per_customer
  ON conversations(customer_id)
  WHERE status = 'open';

CREATE TRIGGER trg_conversations_updated BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
--  5. MESSAGES  — every message in/out (short-term memory)
-- ============================================================
CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id)       ON DELETE CASCADE,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id)     ON DELETE CASCADE,

  wamid            TEXT UNIQUE,         -- WhatsApp message id → idempotency key
  direction        TEXT NOT NULL
                     CHECK (direction IN ('inbound', 'outbound')),
  sender           TEXT NOT NULL
                     CHECK (sender IN ('customer', 'ai', 'agent')),
  content          TEXT NOT NULL,
  msg_type         TEXT NOT NULL DEFAULT 'text',  -- text/image/audio/document...

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_customer     ON messages(customer_id, created_at);


-- ============================================================
--  6. TAGS  — CRM labels (e.g. "Lead", "VIP", "Follow-up")
-- ============================================================
CREATE TABLE tags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,                     -- optional hex color for the dashboard
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, name)
);

-- Many-to-many: a customer can have many tags, a tag many customers
CREATE TABLE customer_tags (
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES tags(id)      ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (customer_id, tag_id)
);


-- ============================================================
--  7. CUSTOMER_MEMORY  — long-term AI memory (structured facts)
--     Durable facts the AI remembers across ALL conversations,
--     e.g. ('interest', 'wedding catering'), ('budget', '50000').
--     Stored as key/value and upserted by key.
-- ============================================================
CREATE TABLE customer_memory (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  key          TEXT NOT NULL,           -- 'interest', 'location', 'budget'...
  value        TEXT NOT NULL,           -- the remembered fact
  source       TEXT NOT NULL DEFAULT 'ai'
                 CHECK (source IN ('ai', 'agent', 'system')),

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (customer_id, key)             -- one value per key → easy upsert
);

CREATE INDEX idx_customer_memory_customer ON customer_memory(customer_id);

CREATE TRIGGER trg_customer_memory_updated BEFORE UPDATE ON customer_memory
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
--  8. KNOWLEDGE_CHUNKS  — RAG: tenant-scoped business knowledge
--     Chunked text + vector embedding for semantic retrieval.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   vector(768),         -- Google text-embedding-004 output dimension
  source      TEXT,                -- filename or label for traceability
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_knowledge_chunks_tenant ON knowledge_chunks(tenant_id);


-- ============================================================
--  9. TENANT_ENTITIES  — flexible config store (schedules, etc.)
-- ============================================================
CREATE TABLE tenant_entities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,            -- 'schedule', 'service', etc.
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenant_entities_tenant_type ON tenant_entities(tenant_id, type);


-- ============================================================
--  10. APPOINTMENTS  — customer bookings
-- ============================================================
CREATE TABLE appointments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  doctor_name      TEXT NOT NULL,
  appointment_time TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'booked'
                     CHECK (status IN ('booked', 'cancelled')),
  reminder_sent    BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_sent_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_appointments_tenant_time ON appointments(tenant_id, appointment_time);

-- Prevent double-booking: same doctor + same time slot
CREATE UNIQUE INDEX uniq_doctor_slot
  ON appointments(tenant_id, doctor_name, appointment_time)
  WHERE status = 'booked';


-- ============================================================
--  11. NOTIFICATIONS  — reliable log of owner alerts
-- ============================================================
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  content     TEXT NOT NULL,
  sent_status TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_tenant ON notifications(tenant_id);


-- ============================================================
--  12. HANDOFF_SESSIONS  — log of owner interventions
-- ============================================================
CREATE TABLE handoff_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  started_by     TEXT NOT NULL,            -- owner phone who initiated
  message_count  INTEGER NOT NULL DEFAULT 0,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMPTZ
);

CREATE INDEX idx_handoff_sessions_tenant ON handoff_sessions(tenant_id);
CREATE UNIQUE INDEX idx_handoff_sessions_active ON handoff_sessions(tenant_id, customer_id)
  WHERE ended_at IS NULL;


-- ============================================================
--  13. LEADS  — CRM lead pipeline (auto-extracted from messages)
-- ============================================================
CREATE TABLE leads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,

  name             TEXT,
  phone            TEXT,
  requirement      TEXT,
  budget           TEXT,
  intent_level     TEXT NOT NULL DEFAULT 'low'
                     CHECK (intent_level IN ('low', 'medium', 'high')),
  stage            TEXT NOT NULL DEFAULT 'new'
                     CHECK (stage IN ('new', 'contacted', 'converted', 'lost')),
  source           TEXT,
  notes            TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leads_tenant ON leads(tenant_id);
CREATE INDEX idx_leads_tenant_stage ON leads(tenant_id, stage);

-- One active lead per customer per tenant.
CREATE UNIQUE INDEX uniq_active_lead_per_customer
  ON leads(tenant_id, customer_id)
  WHERE stage NOT IN ('converted', 'lost');

CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
--  14. PAYMENT_SCHEDULES  — collections / payment reminders
-- ============================================================
CREATE TABLE payment_schedules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  amount           NUMERIC(12,2) NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'INR',
  due_date         DATE NOT NULL,
  reminder_send_at TIMESTAMPTZ NOT NULL,

  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'sending', 'sent', 'paid',
                                       'overdue', 'failed', 'needs_template')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_schedules_tenant ON payment_schedules(tenant_id);
CREATE INDEX idx_payment_schedules_due ON payment_schedules(tenant_id, status, reminder_send_at);

CREATE TRIGGER trg_payment_schedules_updated BEFORE UPDATE ON payment_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
--  SAMPLE DATA (optional) — create your first business to test.
--  Fill in your real Meta values, then uncomment and run.
-- ============================================================
-- INSERT INTO tenants (business_name, phone_number_id, wa_token, ai_prompt)
-- VALUES (
--   'My Test Business',
--   'YOUR_META_PHONE_NUMBER_ID',
--   'YOUR_META_ACCESS_TOKEN',
--   'You are the assistant for My Test Business. Help customers with bookings.'
-- );
