const express             = require('express');
const crypto              = require('crypto');
const logger              = require('../../../infra/logging/logger');
const db                  = require('../../../db/db');
const tenantService       = require('../../tenant/tenantService');
const aiService           = require('../../ai/aiService');
const { assembleConversationContext } = require('../../conversation/contextAssembler');
const sender              = require('./sender');
const ownerCommands       = require('./ownerCommands');
const adapter             = require('./adapter');
const { handleInbound, dispatchOutbound } = require('../index');
const requestContext        = require('../../../core/requestContext');

const router = express.Router();

// Correlation context (Issue 21). The webhook is a PUBLIC edge: always
// generate a fresh wa_ id — never adopt a supplied X-Correlation-Id.
const correlation = requestContext.middleware({ prefix: 'wa', channel: 'whatsapp' });

const recentOwnerWamids = new Set();

function verifySignature(req, res, next) {
  try {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      logger.warn('webhook rejected: missing signature header');
      return res.sendStatus(401);
    }

    const expected = 'sha256=' +
      crypto.createHmac('sha256', process.env.META_APP_SECRET)
        .update(req.body)
        .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      logger.warn('webhook rejected: invalid signature');
      return res.sendStatus(401);
    }

    // Parse raw buffer to JSON so the controller sees a normal object
    req.body = JSON.parse(req.body);
    next();
  } catch (err) {
    logger.error({ err: err.message }, 'signature verification failed');
    res.sendStatus(500);
  }
}

const verify = (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    logger.info('webhook verified');
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
};

const handle = async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.[0]) {
      if (value?.statuses) logger.info({ status: value.statuses[0]?.status, recipientId: value.statuses[0]?.recipient_id }, 'webhook status update');
      return;
    }

    const phoneNumberId = value.metadata?.phone_number_id;
    const msg           = value.messages[0];
    const { id: wamid, from, type } = msg;

    // ── 1. RESOLVE TENANT (cached after first hit) ───────────────────
    const timerLabel = `[Pipeline ${wamid.slice(-6)}]`;
    console.time(`${timerLabel} total`);

    console.time(`${timerLabel} tenant`);
    const tenant = await tenantService.getByPhoneNumberId(phoneNumberId);
    console.timeEnd(`${timerLabel} tenant`);
    if (!tenant) {
      logger.warn({ phoneNumberId }, 'no tenant for phone_number_id');
      return;
    }

    // ── OWNER DETECTION (text commands only) ─────────────────────────
    const ownerPhone = tenant.owner_notify_phone?.replace(/\D/g, '');
    const senderNorm = from.replace(/\D/g, '');
    if (ownerPhone && senderNorm === ownerPhone) {
      if (type === 'text' && msg.text?.body) {
        if (recentOwnerWamids.has(wamid)) {
          logger.info({ wamid }, 'owner duplicate wamid — skipping');
          return;
        }
        recentOwnerWamids.add(wamid);
        setTimeout(() => recentOwnerWamids.delete(wamid), 10 * 60 * 1000);
        logger.info({ tenantId: tenant.id, from }, 'owner message detected');
        await ownerCommands.handle(tenant, from, msg.text.body);
      } else {
        logger.info({ type, from }, 'non-text from owner — ignoring');
      }
      return;
    }

    // ── PARSE TO ENVELOPE + CHANNEL-AGNOSTIC INGEST ─────────────────
    const envelopes = adapter.parseInbound(value, tenant.id);
    if (!envelopes.length) {
      logger.info({ type, from }, 'empty message — skipping');
      return;
    }

    const results = await handleInbound(envelopes);

    // ── WA-SPECIFIC REPLY PATH (identical to previous inline logic) ──
    for (const { envelope, customer, conversation, timerLabel: tl } of results) {
      // ── NON-TEXT: stored, but no AI reply ──────────────────────────
      if (envelope.messageType !== 'text') {
        await db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation.id, envelope.tenantId]);
        console.timeEnd(`${tl} total`);
        logger.info({ tenantId: envelope.tenantId, from: envelope.identifier, externalId: envelope.externalId, msgType: envelope.messageType }, 'non-text message stored');
        continue;
      }

      const userText = envelope.text;

      // ── 5. PARALLEL: mode check + last_message_at update ───────────
      const [{ rows: [freshConv] }] = await Promise.all([
        db.query(`SELECT mode FROM conversations WHERE id = $1 AND tenant_id = $2`, [conversation.id, envelope.tenantId]),
        db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation.id, envelope.tenantId])
      ]);

      if (!freshConv || freshConv.mode === 'human' || !tenant.ai_enabled) {
        logger.info({ tenantId: envelope.tenantId, mode: freshConv?.mode, aiEnabled: tenant.ai_enabled }, 'skipping AI');

        if (freshConv?.mode === 'human' && tenant.owner_notify_phone) {
          const preview = userText.length > 100 ? userText.slice(0, 97) + '...' : userText;
          try {
            await sender.sendMessage(
              tenant,
              tenant.owner_notify_phone,
              `💬 Message from +${envelope.identifier}:\n${preview}`
            );
            logger.info({ tenantId: envelope.tenantId, chars: preview.length }, 'human mode — forwarded to owner');
          } catch (fwdErr) {
            logger.error({ tenantId: envelope.tenantId, err: fwdErr.message }, 'failed to forward to owner');
          }
        }

        continue;
      }

      // ── 6. PARALLEL: RAG + history + customer memory (shared helper) ─
      console.time(`${tl} parallel-fetch`);

      const { knowledgeChunks, history, facts } = await assembleConversationContext({
        tenantId: envelope.tenantId,
        conversationId: conversation.id,
        customerId: customer.id,
        text: userText,
      });

      console.timeEnd(`${tl} parallel-fetch`);

      // ── 7. GENERATE AI REPLY ───────────────────────────────────────
      let reply;
      try {
        console.time(`${tl} gemini`);
        reply = await aiService.generateReply(
          tenant, customer, conversation, userText, history, knowledgeChunks, facts
        );
        console.timeEnd(`${tl} gemini`);
      } catch (aiErr) {
        logger.error({ tenantId: envelope.tenantId, err: aiErr.message }, 'AI generation failed');
        continue;
      }

      // ── 8. SEND VIA WHATSAPP (through dispatchOutbound) ────────────
      let sentWamid;
      try {
        console.time(`${tl} whatsapp-send`);
        const { externalId } = await dispatchOutbound({
          tenantId: envelope.tenantId,
          customerId: customer.id,
          channel: 'whatsapp',
          payload: { text: reply }
        });
        sentWamid = externalId;
        console.timeEnd(`${tl} whatsapp-send`);
      } catch (sendErr) {
        logger.error({ tenantId: envelope.tenantId, err: sendErr.message }, 'WhatsApp send failed');
        continue;
      }

      // ── 9. STORE OUTBOUND AI MESSAGE (only after successful send) ──
      await db.query(
        `INSERT INTO messages
           (tenant_id, conversation_id, customer_id, external_id,
            direction, sender, content, channel, msg_type)
         VALUES ($1, $2, $3, $4, 'outbound', 'ai', $5, 'whatsapp', 'text')`,
        [envelope.tenantId, conversation.id, customer.id, sentWamid, reply]
      );

      console.timeEnd(`${tl} total`);
      logger.info({ tenantId: envelope.tenantId, from: envelope.identifier, externalId: envelope.externalId }, 'message processed');
    }

  } catch (err) {
    logger.error({ err: err.message }, 'webhook error');
  }
};

router.get('/',  verify);
router.post('/', correlation, verifySignature, handle);

module.exports = router;
module.exports._verifySignature = verifySignature;
