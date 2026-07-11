-- Migration 022: turn_traces (Issue 22) — one structured trace row per AI turn,
-- both channels, success or failure. The queryable twin of Issue 21's log
-- chains: stage timings, retrieval, prompt provenance (hash + config version +
-- mode — NEVER the full prompt text), LLM meta, tool calls, error, correlation
-- id. Written off the hot path (fire-and-forget after dispatch); aged out by
-- the per-tenant retention cron (config `retention_days`, default 365).
--
-- FK choices:
--   • tenant_id CASCADE — traces die with their tenant.
--   • conversation_id / call_session_id SET NULL — traces must SURVIVE probe
--     cleanup (the turn.scripted check deletes its synthetic customer, which
--     cascades to conversations/call_sessions; probe traces age out via
--     retention instead, by design).
--
-- Additive and forward-only. schema.sql is updated in lockstep.

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
