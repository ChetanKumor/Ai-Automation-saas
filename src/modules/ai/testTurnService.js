'use strict';

// PORTAL-P5-S14 "Test your receptionist" — runs ONE real turn through the real
// renderer + real brain, for the session tenant's CURRENT config, with NO
// persistence: no customer/conversation/message row is ever created (the
// isolation the page's suite asserts by counting those tables before/after).
//
// Deliberately stateless (v1 scope, spec §5.11): one question in, one reply
// out — no carried history. A single-shot turn can never reach a booking
// confirmation on its own (the brain's own rule requires an explicit "yes"
// after an offered slot), but book_appointment is ALSO hard-gated off for
// channel 'test' in aiService (belt and suspenders) — the isolation guarantee
// must hold even if a future change lets a test turn carry history.
//
// A turn_traces row (channel 'test') IS written for every real attempt — it is
// both the honest trace record (readable the same way any other turn's trace
// is) and the ledger the daily rate limit counts against, so no new schema is
// needed for the 20/day cap.

const db = require('../../db/db');
const logger = require('../../infra/logging/logger');
const aiService = require('./aiService');
const knowledgeService = require('../knowledge/knowledgeService');
const traces = require('../traces/collector');

const DAILY_LIMIT = 20;
const RAG_TOP_K = 3;
const IST = 'Asia/Kolkata';

// Start of "today" in IST, as a UTC instant — the same calendar-day boundary
// the rest of the app uses for booking dates.
function istTodayStart() {
  const ymd = new Date().toLocaleDateString('en-CA', { timeZone: IST });
  return new Date(`${ymd}T00:00:00+05:30`);
}

async function countTestTurnsToday(tenantId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM turn_traces
     WHERE tenant_id = $1 AND channel = 'test' AND created_at >= $2`,
    [tenantId, istTodayStart()]
  );
  return rows[0].n;
}

// The installed SDK (@google/generative-ai@0.24.1) throws
// GoogleGenerativeAIFetchError with `.status` set directly (verified against
// node_modules/@google/generative-ai/dist/index.js) — a numeric HTTP status,
// 429 on a quota/rate-limit rejection. `.response.status` is also honored
// (the shape this codebase's own trace tests mock upstream failures with), and
// a message match is the fallback for anything wrapped differently.
function isQuotaError(err) {
  const status = err.status ?? err.response?.status ?? null;
  if (status === 429) return true;
  return /RESOURCE_EXHAUSTED|quota/i.test(err.message || '');
}

// Un-gated by tenant lifecycle on purpose: an owner must be able to test their
// receptionist BEFORE go-live (draft/validated/paused are all active=false,
// and tenantService's cached lookups filter on active=true — see
// scriptedTurnCheck's header comment for the same gotcha on the voice route).
// owner_notify_phone is forced null defensively, mirroring scriptedTurnCheck
// and capture_turn.js — belt and suspenders alongside the book_appointment
// gate in aiService, since a test turn must never page a real owner.
async function fetchTenantForBrain(tenantId) {
  const { rows } = await db.query(
    'SELECT id, ai_prompt, owner_notify_phone FROM tenants WHERE id = $1',
    [tenantId]
  );
  const tenant = rows[0];
  if (!tenant) return null;
  return { ...tenant, owner_notify_phone: null };
}

/**
 * Run ONE test turn for `tenantId`. Returns one of:
 *   { status: 'limited' }
 *   { status: 'quota_exceeded', remaining }
 *   { status: 'ok', reply, provenance: { config_version, tool_calls, knowledge_used, latency_ms }, remaining }
 *
 * Never throws for an upstream LLM failure (quota or otherwise classified
 * as such) — only for a genuine internal error (bad tenant id, DB down),
 * which the route surfaces as a 500. No mock replies, ever: a caught error
 * either maps to `quota_exceeded` or is rethrown, never fabricated as text.
 */
async function runTestTurn(tenantId, question) {
  const usedToday = await countTestTurnsToday(tenantId);
  if (usedToday >= DAILY_LIMIT) {
    return { status: 'limited' };
  }

  const tenant = await fetchTenantForBrain(tenantId);
  if (!tenant) throw new Error('tenant not found');

  const trace = traces.open({ channel: 'test', tenantId });

  // RAG only — the history/facts legs of the shared assembleConversationContext
  // don't apply here: V-009's currentMessageId precondition assumes a
  // persisted inbound row, which a test turn never creates. Best-effort,
  // mirroring the shared assembler exactly: a RAG failure (including its OWN
  // separate embedding-model quota) degrades to no knowledge, never aborts
  // the turn.
  let knowledgeChunks = [];
  try {
    knowledgeChunks = await knowledgeService.getRelevantChunks(tenantId, question, RAG_TOP_K);
  } catch (err) {
    logger.error({ tenantId, err: err.message }, 'test turn RAG failed (continuing without)');
  }
  trace.setRetrieval(knowledgeChunks.length
    ? knowledgeChunks.map((c) => ({ chunk_id: c.id ?? null, score: c.similarity ?? null }))
    : null);

  // Synthetic, never-persisted customer/conversation — no row exists anywhere
  // for either, which is the whole isolation guarantee. `name: null` correctly
  // rides the same "identity unknown" line a real first-time customer gets
  // (GUARD-01's unknownIdentityLine).
  const customer = { id: null, phone: '(test conversation — no real customer)', name: null };
  const conversation = { id: null, summary: null };

  const t0 = Date.now();
  let reply;
  try {
    reply = await aiService.generateReply(
      tenant, customer, conversation, question, [], knowledgeChunks, [],
      { channel: 'test', metrics: trace.timer }
    );
  } catch (err) {
    trace.setErrorFromException(err, 'generate_reply');
    await trace.flush();
    const remaining = Math.max(0, DAILY_LIMIT - (usedToday + 1));
    if (isQuotaError(err)) return { status: 'quota_exceeded', remaining };
    throw err;
  }
  const latency_ms = Date.now() - t0;
  await trace.flush();

  const remaining = Math.max(0, DAILY_LIMIT - (usedToday + 1));
  const tools = trace.timer.snapshot().tools || [];

  return {
    status: 'ok',
    reply,
    provenance: {
      config_version: trace.prompt ? trace.prompt.config_version : null,
      tool_calls: tools.map((t) => t.name),
      knowledge_used: knowledgeChunks.length > 0,
      latency_ms: Math.round(latency_ms),
    },
    remaining,
  };
}

module.exports = { runTestTurn, isQuotaError, DAILY_LIMIT };
