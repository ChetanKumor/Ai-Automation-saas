'use strict';

// Integration tests for F-001: voice turn hydration with voice-only tenants.
//
// RED (before fix):
//   - voice-only tenant (phone_number_id NULL) → 404 'tenant credentials not found'
//   - wa_token NULL tenant → 500 from decrypt(null) TypeError
// GREEN (after fix): both tenants complete a full turn and return 200.
//
// WA regression guard: a tenant with full WA credentials is unaffected.

require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db                  = require('../../src/db/db');
const hmac                = require('../../src/utils/hmac');
const { encrypt }         = require('../../src/utils/encryption');
const aiService           = require('../../src/modules/ai/aiService');
const knowledgeService    = require('../../src/modules/knowledge/knowledgeService');
const conversationService = require('../../src/modules/conversation/conversationService');
const voiceAdapter        = require('../../src/modules/channels/voice/voiceChannelAdapter');
const tenantService       = require('../../src/modules/tenant/tenantService');

const SECRET = 'f001-hydration-test-secret';

// Three tenant scenarios — UUIDs chosen to not clash with any other test file.
const T_VOICE   = '00000000-0000-f001-0000-000000000001'; // phone_number_id NULL, wa_token NULL
const T_WANULL  = '00000000-0000-f001-0000-000000000002'; // phone_number_id set, wa_token NULL
const T_WAFULL  = '00000000-0000-f001-0000-000000000003'; // full WA credentials (regression guard)

const PNID_WANULL = 'pnid_f001_wanull';
const PNID_WAFULL = 'pnid_f001_wafull';

let server;
let baseUrl;
let knowledgeMock;

async function cleanup() {
  for (const tid of [T_VOICE, T_WANULL, T_WAFULL]) {
    await db.query('DELETE FROM messages WHERE tenant_id = $1', [tid]);
    await db.query('DELETE FROM call_sessions WHERE tenant_id = $1', [tid]);
    await db.query('DELETE FROM conversations WHERE tenant_id = $1', [tid]);
    await db.query('DELETE FROM customers WHERE tenant_id = $1', [tid]);
    await db.query('DELETE FROM tenants WHERE id = $1', [tid]);
  }
  tenantService.invalidateTenantCache();
}

async function postTurn(body) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/internal/voice/turn`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-signature': hmac.sign(raw, SECRET),
    },
    body: raw,
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function setupScenario(tenantId, phone) {
  const { rows: [cust] } = await db.query(
    'INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING *',
    [tenantId, phone]
  );
  const conv = await conversationService.getOrCreateOpenConversation(tenantId, cust.id, 'voice');
  const session = await voiceAdapter.startSession({
    tenantId,
    customerId: cust.id,
    conversationId: conv.id,
    provider: 'noop',
    direction: 'inbound',
    fromNumber: phone,
  });
  return { cust, conv, session };
}

// Minimal scripted model — one text reply, no tool calls.
function simpleReplyModel(replyText) {
  return () => ({
    startChat: () => ({
      sendMessage: async () => ({
        response: {
          functionCalls: () => undefined,
          text: () => replyText,
        },
      }),
    }),
  });
}

describe('Voice turn — tenant hydration (F-001)', () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = SECRET;
    await cleanup();

    // T_VOICE: voice-only, no phone_number_id, no wa_token.
    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Voice-Only Clinic', NULL, NULL, 'You are a voice assistant.', true, true)`,
      [T_VOICE]
    );

    // T_WANULL: phone_number_id present but wa_token NULL.
    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'WA-No-Token Clinic', $2, NULL, 'You are a voice assistant.', true, true)`,
      [T_WANULL, PNID_WANULL]
    );

    // T_WAFULL: full WA credentials (regression guard).
    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Full WA Clinic', $2, $3, 'You are a voice assistant.', true, true)`,
      [T_WAFULL, PNID_WAFULL, encrypt('real-wa-token')]
    );

    knowledgeMock = require('node:test').mock.method(
      knowledgeService, 'getRelevantChunks', async () => []
    );

    const app = express();
    app.use('/internal/voice', require('../../src/routes/internalVoice'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (knowledgeMock) knowledgeMock.mock.restore();
    aiService._setModelProvider(null);
    if (server) await new Promise((r) => server.close(r));
    await cleanup();
  });

  it('voice-only tenant (phone_number_id NULL, wa_token NULL) → 200 (was 404)', async () => {
    const { session } = await setupScenario(T_VOICE, '+919000000091');
    aiService._setModelProvider(simpleReplyModel('Hello from voice-only tenant.'));

    const { status, json } = await postTurn({
      call_session_id: session.id,
      language: 'en-IN',
      transcript: 'Hello',
    });

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
    assert.equal(json.reply_text, 'Hello from voice-only tenant.');
    assert.equal(json.end_call, false);
  });

  it('wa_token NULL tenant (phone_number_id set) → 200 (was 500 from decrypt)', async () => {
    const { session } = await setupScenario(T_WANULL, '+919000000092');
    aiService._setModelProvider(simpleReplyModel('Hello from wa-null tenant.'));

    const { status, json } = await postTurn({
      call_session_id: session.id,
      language: 'en-IN',
      transcript: 'Hello',
    });

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
    assert.equal(json.reply_text, 'Hello from wa-null tenant.');
  });

  it('fully-credentialed WA tenant voice turn → 200 (regression guard)', async () => {
    const { session } = await setupScenario(T_WAFULL, '+919000000093');
    aiService._setModelProvider(simpleReplyModel('Hello from full WA tenant.'));

    const { status, json } = await postTurn({
      call_session_id: session.id,
      language: 'en-IN',
      transcript: 'Hello',
    });

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
    assert.equal(json.reply_text, 'Hello from full WA tenant.');
  });
});
