-- ============================================================
--  WhatsApp AI CRM — Foundation Database Schema
--  PostgreSQL
--
--  Design goals:
--   • Multi-tenant (one platform, many businesses)
--   • AI + Human coexistence (mode lives on each conversation)
--   • Memory (short-term = messages, long-term = facts + summary)
--   • Idempotent message handling (external_id is UNIQUE per tenant+channel)
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

  -- Provisioning idempotency key (migration 021). Nullable so credential-less
  -- and legacy inserts keep working; UNIQUE so a slug names exactly one tenant.
  -- Chosen over phone_number_id because voice-first tenants may have no PNID at
  -- provision time.
  slug             TEXT UNIQUE,

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

  -- Control-plane lifecycle (migration 020). `active` stays authoritative for
  -- runtime until Issue 17 reconciles it against `status`.
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'validated', 'live', 'paused')),

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

  -- Portal owner auth (migration 023). Stamped by portal login on success.
  -- password_hash (above) holds a scrypt-encoded string for portal accounts.
  last_login_at  TIMESTAMPTZ,

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

  channel           TEXT NOT NULL DEFAULT 'whatsapp',

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
-- Serves the admin conversations list (Issue 26): filter by tenant, keyset
-- paginate + ORDER BY (updated_at DESC, id DESC). The composite order lets the
-- planner satisfy both the WHERE and the ORDER BY from the index — no Sort node.
CREATE INDEX idx_conversations_tenant_updated ON conversations(tenant_id, updated_at DESC, id DESC);

-- Guarantee only ONE open conversation per customer per tenant at a time.
CREATE UNIQUE INDEX uniq_open_conversation
  ON conversations(tenant_id, customer_id)
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

  external_id      TEXT,                -- channel-scoped message id (dedup key)
  channel          TEXT NOT NULL DEFAULT 'whatsapp',
  direction        TEXT NOT NULL
                     CHECK (direction IN ('inbound', 'outbound')),
  sender           TEXT NOT NULL
                     CHECK (sender IN ('customer', 'ai', 'agent')),
  content          TEXT NOT NULL,
  msg_type         TEXT NOT NULL DEFAULT 'text',
  media_ref        TEXT,                -- provider media reference for non-text messages

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_customer     ON messages(customer_id, created_at);

-- Channel-scoped dedup: one row per (tenant, channel, external_id)
CREATE UNIQUE INDEX uniq_msg_external
  ON messages(tenant_id, channel, external_id) WHERE external_id IS NOT NULL;


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

-- Approximate-nearest-neighbour index for semantic retrieval (cosine distance).
CREATE INDEX idx_knowledge_chunks_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);


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
  reminder_status  TEXT NOT NULL DEFAULT 'pending'
                     CHECK (reminder_status IN ('pending', 'sending', 'sent', 'failed',
                                                'needs_template', 'needs_review')),
  reminder_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_appointments_tenant_time ON appointments(tenant_id, appointment_time);

-- Prevent double-booking: same doctor + same time slot
CREATE UNIQUE INDEX uniq_doctor_slot
  ON appointments(tenant_id, doctor_name, appointment_time)
  WHERE status = 'booked';

CREATE INDEX idx_appointments_reminder_due
  ON appointments(reminder_status, appointment_time)
  WHERE reminder_status = 'pending';


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

  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency         TEXT NOT NULL DEFAULT 'INR',
  due_date         DATE NOT NULL,
  reminder_send_at TIMESTAMPTZ NOT NULL,

  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'sending', 'sent', 'paid',
                                       'overdue', 'failed', 'needs_template', 'needs_review')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_schedules_tenant ON payment_schedules(tenant_id);
CREATE INDEX idx_payment_schedules_due ON payment_schedules(tenant_id, status, reminder_send_at);

CREATE UNIQUE INDEX uniq_payment_schedule_per_customer_due
  ON payment_schedules(tenant_id, customer_id, due_date, amount)
  WHERE status NOT IN ('paid', 'failed');

CREATE TRIGGER trg_payment_schedules_updated BEFORE UPDATE ON payment_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
--  15. WORKFLOW_RULES  — event-driven automation rules per tenant
-- ============================================================
CREATE TABLE workflow_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  trigger_event  TEXT NOT NULL,
  conditions     JSONB NOT NULL DEFAULT '{}',
  action         TEXT NOT NULL,
  action_params  JSONB NOT NULL DEFAULT '{}',
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

CREATE INDEX idx_workflow_rules_tenant_event
  ON workflow_rules(tenant_id, trigger_event)
  WHERE enabled = true;


-- ============================================================
--  16. WORKFLOW_EXECUTIONS  — audit log of rule firings
-- ============================================================
CREATE TABLE workflow_executions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  rule_id     UUID NOT NULL REFERENCES workflow_rules(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(rule_id, event_id)
);


-- ============================================================
--  17. CHANNEL_IDENTIFIERS  — cross-channel customer identity
-- ============================================================
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


-- ============================================================
--  18. CALL_SESSIONS  — voice channel: one row per phone call.
--      Turns live in `messages`; this records per-call metadata.
-- ============================================================
CREATE TABLE call_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id)       ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id)     ON DELETE CASCADE,
  conversation_id   UUID          REFERENCES conversations(id) ON DELETE SET NULL,
  provider          TEXT NOT NULL,
  external_call_id  TEXT,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number       TEXT,
  to_number         TEXT,
  language_detected TEXT,
  status            TEXT NOT NULL
                      CHECK (status IN ('initiated', 'in_progress', 'completed', 'failed')),
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  duration_seconds  INT,
  recording_url     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_call_sessions_tenant_customer
  ON call_sessions(tenant_id, customer_id);

CREATE INDEX idx_call_sessions_external
  ON call_sessions(external_call_id);


-- ============================================================
--  19. CONTROL PLANE  — versioned per-tenant behavior config
--      (migration 020). All per-tenant behavior lives in one
--      versioned JSONB config; history is append-only. The DB
--      enforces NO JSON shape (validation is application-level,
--      Issue 8). No runtime code reads these yet.
-- ============================================================

-- One config row per tenant (tenant_id IS the primary key).
CREATE TABLE tenant_configs (
  tenant_id   UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  version     INT NOT NULL DEFAULT 1,
  config      JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only revision history; one row per (tenant, version).
CREATE TABLE tenant_config_revisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version     INT NOT NULL,
  config      JSONB NOT NULL,
  source      TEXT NOT NULL,             -- 'provision' | 'admin' | 'cli' | 'portal' (free text, no enum)
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- acting user (INV-4); NULL for operator/CLI writes (migration 024)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, version)
);

CREATE INDEX idx_tenant_config_revisions_tenant_version
  ON tenant_config_revisions (tenant_id, version DESC);

-- Validation run log (per-check outcomes live in `result`).
CREATE TABLE validation_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  passed      BOOLEAN NOT NULL,
  result      JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_validation_runs_tenant_created
  ON validation_runs (tenant_id, created_at DESC);


-- ============================================================
--  20. TURN_TRACES  — one structured trace row per AI turn
--      (migration 022). Mechanics only: stage timings, retrieval
--      chunk ids + scores, prompt provenance (hash + config
--      version + mode — never the full text), LLM meta, tool
--      calls, error, correlation id. Written fire-and-forget
--      after dispatch; aged out by the per-tenant retention cron
--      (config `retention_days`). conversation/call_session FKs
--      are SET NULL so probe traces survive synthetic cleanup.
-- ============================================================
CREATE TABLE turn_traces (
  turn_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- app supplies the PR9A turn_id; default keeps the UUID-PK convention
  tenant_id       UUID NOT NULL REFERENCES tenants(id)        ON DELETE CASCADE,
  conversation_id UUID          REFERENCES conversations(id)  ON DELETE SET NULL,
  call_session_id UUID          REFERENCES call_sessions(id)  ON DELETE SET NULL,

  channel         TEXT NOT NULL,        -- 'whatsapp' | 'voice' (open set)
  correlation_id  TEXT,                 -- Issue 21 chain id (wa_/call_/probe_/adm_…)

  stage_timings   JSONB,               -- named stage durations (ms) + total_ms
  retrieval       JSONB,               -- [{chunk_id, score}] — null when no retrieval ran
  prompt          JSONB,               -- {hash, config_version, mode} — never full text
  llm             JSONB,               -- {model, calls:[…], input_tokens, output_tokens, latency_ms, finish_reason}
  tool_calls      JSONB,               -- [{n, name, latency_ms, outcome}] in execution order — null when none
  error           JSONB,               -- {stage, message, status} — null on success

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_turn_traces_tenant_created ON turn_traces(tenant_id, created_at DESC);
CREATE INDEX idx_turn_traces_conversation   ON turn_traces(conversation_id);
CREATE INDEX idx_turn_traces_correlation    ON turn_traces(correlation_id);


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
