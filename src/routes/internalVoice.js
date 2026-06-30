'use strict';

const express             = require('express');
const logger              = require('../infra/logging/logger');
const db                  = require('../db/db');
const tenantService       = require('../modules/tenant/tenantService');
const customerService     = require('../modules/customer/customerService');
const knowledgeService    = require('../modules/knowledge/knowledgeService');
const aiService           = require('../modules/ai/aiService');
const identityService     = require('../modules/identity/identityService');
const conversationService = require('../modules/conversation/conversationService');
const voiceChannelAdapter = require('../modules/channels/voice/voiceChannelAdapter');
const hmac                = require('../utils/hmac');

const router = express.Router();

/**
 * HMAC auth for the internal voice endpoint. Reuses the WhatsApp signature
 * scheme over the raw body (header `x-internal-signature: sha256=<hex>`).
 * The body arrives as a raw Buffer (express.raw) and is parsed here.
 */
function authenticate(req, res, next) {
  const secret = process.env.VOICE_INTERNAL_SECRET;
  if (!secret) {
    logger.error('internal voice: VOICE_INTERNAL_SECRET not set — rejecting');
    return res.sendStatus(401);
  }
  if (!hmac.verify(req.body, req.headers['x-internal-signature'], secret)) {
    logger.warn('internal voice: invalid signature');
    return res.sendStatus(401);
  }
  try {
    req.body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body);
  } catch (err) {
    return res.status(400).json({ error: 'invalid json' });
  }
  next();
}

/**
 * POST /internal/voice/turn — route ONE voice turn into the existing brain.
 *
 * Transport glue + persistence only. All business logic (tool selection,
 * booking guards, memory) lives in aiService.generateReply / the booking tools,
 * reached here with channel="voice" (spoken style). Outbound is RETURNED to the
 * worker (it does TTS), not pushed.
 *
 * req:  { tenant_id, customer_id, conversation_id, call_session_id, channel:"voice", language, transcript }
 * res:  { reply_text, end_call:boolean, language }
 */
async function handleTurn(req, res) {
  const { tenant_id, customer_id, conversation_id, language, transcript } = req.body || {};

  if (!tenant_id || !customer_id || !conversation_id || !transcript) {
    return res.status(400).json({ error: 'missing required fields' });
  }

  try {
    // Hydrate tenant (decrypted creds + cache) — same pattern as the WhatsApp adapter.
    const { rows: [t] } = await db.query(
      'SELECT phone_number_id FROM tenants WHERE id = $1 AND active = true', [tenant_id]
    );
    if (!t) return res.status(404).json({ error: 'tenant not found' });
    const tenant = await tenantService.getByPhoneNumberId(t.phone_number_id);
    if (!tenant) return res.status(404).json({ error: 'tenant credentials not found' });

    // Validate the customer + conversation belong to this tenant.
    const { rows: [customer] } = await db.query(
      'SELECT * FROM customers WHERE id = $1 AND tenant_id = $2', [customer_id, tenant_id]
    );
    if (!customer) return res.status(404).json({ error: 'customer not found' });

    const { rows: [conversation] } = await db.query(
      'SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2 AND customer_id = $3',
      [conversation_id, tenant_id, customer_id]
    );
    if (!conversation) return res.status(404).json({ error: 'conversation not found' });

    // Honor the stored preferred_language prior; the request's STT-detected
    // language is used (and persisted) only when the prior is null.
    const effectiveLanguage = await customerService.resolveLanguage(tenant_id, customer_id, language);

    // Persist the inbound voice turn (channel='voice') BEFORE fetching history —
    // getRecentMessages OFFSET-1's past this just-inserted row, exactly as WhatsApp does.
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, 'inbound', 'customer', $4, 'voice', 'text')`,
      [tenant_id, conversation_id, customer_id, transcript]
    );

    // Same mode/ai_enabled gate as the WhatsApp path.
    if (conversation.mode === 'human' || !tenant.ai_enabled) {
      logger.info({ tenant_id, mode: conversation.mode, aiEnabled: tenant.ai_enabled }, 'voice turn: AI skipped');
      await db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation_id, tenant_id]);
      return res.json({ reply_text: '', end_call: false, language: effectiveLanguage });
    }

    // Same parallel context fetch as whatsapp/routes.js.
    const [knowledgeChunks, history, { rows: facts }] = await Promise.all([
      knowledgeService.getRelevantChunks(tenant_id, transcript, 3).catch((err) => {
        logger.error({ tenant_id, err: err.message }, 'RAG failed (continuing without)');
        return [];
      }),
      customerService.getRecentMessages(tenant_id, conversation_id),
      db.query(
        `SELECT key, value FROM customer_memory WHERE tenant_id = $1 AND customer_id = $2 ORDER BY key`,
        [tenant_id, customer_id]
      ),
    ]);

    // THE ONE BRAIN — same tools, same booking guards; channel only changes style.
    const reply_text = await aiService.generateReply(
      tenant, customer, conversation, transcript, history, knowledgeChunks, facts, { channel: 'voice' }
    );

    // Persist the outbound voice turn (channel='voice').
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, 'outbound', 'ai', $4, 'voice', 'text')`,
      [tenant_id, conversation_id, customer_id, reply_text]
    );
    await db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation_id, tenant_id]);

    return res.json({ reply_text, end_call: false, language: effectiveLanguage });
  } catch (err) {
    logger.error({ err: err.message }, 'internal voice turn failed');
    return res.status(500).json({ error: 'turn failed' });
  }
}

/**
 * POST /internal/voice/call/start — bridge a call into the brain's identity model.
 *
 * Identity resolves ONCE here, at bridge time, via the SAME identityService the
 * WhatsApp path uses. For voice (a phone channel) a returning caller is matched
 * by phone and reuses their EXISTING open conversation — so voice and WhatsApp
 * share one customer, one conversation, one memory. A new caller creates the
 * customer + voice channel_identifier. Every subsequent turn reuses this
 * call_session's customer/conversation (the worker never resolves identity).
 *
 * req:  { tenant_id, caller_id, channel:"voice" }
 * res:  { call_session_id, customer_id, conversation_id }
 */
async function handleCallStart(req, res) {
  const { tenant_id, caller_id, channel = 'voice' } = req.body || {};

  if (!tenant_id || !caller_id) {
    return res.status(400).json({ error: 'missing required fields' });
  }

  try {
    const { rows: [t] } = await db.query(
      'SELECT id FROM tenants WHERE id = $1 AND active = true', [tenant_id]
    );
    if (!t) return res.status(404).json({ error: 'tenant not found' });

    // Same resolution WhatsApp uses (phone fallback + channel_identifier link).
    const customer = await identityService.resolveCustomer({
      tenantId: tenant_id,
      channelType: channel,
      identifier: caller_id,
    });

    // Returning customer → their existing open conversation; new → a fresh one.
    const conversation = await conversationService.getOrCreateOpenConversation(
      tenant_id, customer.id, 'voice'
    );

    // PR6 lifecycle: create call_session (in_progress) + emit call.started.
    const session = await voiceChannelAdapter.startSession({
      tenantId: tenant_id,
      customerId: customer.id,
      conversationId: conversation.id,
      provider: 'noop',
      direction: 'inbound',
      fromNumber: caller_id,
    });

    return res.json({
      call_session_id: session.id,
      customer_id: customer.id,
      conversation_id: conversation.id,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'internal voice call/start failed');
    return res.status(500).json({ error: 'call start failed' });
  }
}

/**
 * POST /internal/voice/call/end — close the call_session + emit call.ended.
 *
 * The worker supplies only the call_session_id (the canonical owner of the
 * tenant), so tenant scope is resolved server-side before the tenant-scoped
 * update. Drives PR6's call_sessions.updateStatus + call.ended.
 *
 * req:  { call_session_id, status:"completed"|"failed", duration_seconds }
 * res:  { ok:true }
 */
async function handleCallEnd(req, res) {
  const { call_session_id, status = 'completed', duration_seconds = null } = req.body || {};

  if (!call_session_id) {
    return res.status(400).json({ error: 'missing required fields' });
  }
  if (status !== 'completed' && status !== 'failed') {
    return res.status(400).json({ error: 'invalid status' });
  }

  try {
    const { rows: [row] } = await db.query(
      'SELECT tenant_id FROM call_sessions WHERE id = $1', [call_session_id]
    );
    if (!row) return res.status(404).json({ error: 'call session not found' });

    const session = await voiceChannelAdapter.endSession(call_session_id, row.tenant_id, {
      status,
      durationSeconds: duration_seconds,
    });
    if (!session) return res.status(404).json({ error: 'call session not found' });

    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message }, 'internal voice call/end failed');
    return res.status(500).json({ error: 'call end failed' });
  }
}

router.post('/call/start', express.raw({ type: '*/*' }), authenticate, handleCallStart);
router.post('/call/end',   express.raw({ type: '*/*' }), authenticate, handleCallEnd);
router.post('/turn',       express.raw({ type: '*/*' }), authenticate, handleTurn);

module.exports = router;
module.exports._authenticate = authenticate;
module.exports._handleTurn = handleTurn;
module.exports._handleCallStart = handleCallStart;
module.exports._handleCallEnd = handleCallEnd;

