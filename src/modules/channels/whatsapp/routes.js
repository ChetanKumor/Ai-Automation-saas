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
const traces                = require('../../traces/collector');

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
    const entries = req.body?.entry;
    if (!entries?.length) return;

    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const value = change.value;
        if (!value) continue;

        // ── STATUS CALLBACKS ─────────────────────────────────────────
        if (!value.messages?.length) {
          if (value.statuses) {
            logger.info({ status: value.statuses[0]?.status, recipientId: value.statuses[0]?.recipient_id }, 'webhook status update');
          }
          continue;
        }

        // ── 1. RESOLVE TENANT (cached after first hit) ───────────────
        const phoneNumberId = value.metadata?.phone_number_id;
        console.time(`[Tenant ${(phoneNumberId || '').slice(-6)}] resolve`);
        const tenant = await tenantService.getByPhoneNumberId(phoneNumberId);
        console.timeEnd(`[Tenant ${(phoneNumberId || '').slice(-6)}] resolve`);
        if (!tenant) {
          logger.warn({ phoneNumberId }, 'no tenant for phone_number_id');
          continue;
        }

        // ── OWNER DETECTION (text commands only, per message) ────────
        const ownerPhone = tenant.owner_notify_phone?.replace(/\D/g, '');
        const customerMessages = [];

        for (const msg of value.messages) {
          const senderNorm = (msg.from || '').replace(/\D/g, '');
          if (ownerPhone && senderNorm === ownerPhone) {
            if (msg.type === 'text' && msg.text?.body) {
              if (recentOwnerWamids.has(msg.id)) {
                logger.info({ wamid: msg.id }, 'owner duplicate wamid — skipping');
              } else {
                recentOwnerWamids.add(msg.id);
                setTimeout(() => recentOwnerWamids.delete(msg.id), 10 * 60 * 1000);
                logger.info({ tenantId: tenant.id, from: msg.from }, 'owner message detected');
                await ownerCommands.handle(tenant, msg.from, msg.text.body);
              }
            } else {
              logger.info({ type: msg.type, from: msg.from }, 'non-text from owner — ignoring');
            }
          } else {
            customerMessages.push(msg);
          }
        }

        if (!customerMessages.length) continue;

        // ── PARSE TO ENVELOPES + CHANNEL-AGNOSTIC INGEST ────────────
        const filteredValue = { ...value, messages: customerMessages };
        const envelopes = adapter.parseInbound(filteredValue, tenant.id);
        if (!envelopes.length) {
          logger.info({ phoneNumberId }, 'no parseable customer messages — skipping');
          continue;
        }

        const results = await handleInbound(envelopes);

        // ── WA-SPECIFIC REPLY PATH ───────────────────────────────────
        for (const { envelope, customer, conversation, timerLabel: tl, messageId } of results) {
          try {
            // ── NON-TEXT: stored, but no AI reply ────────────────────
            if (envelope.messageType !== 'text') {
              await db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation.id, envelope.tenantId]);
              console.timeEnd(`${tl} total`);
              logger.info({ tenantId: envelope.tenantId, from: envelope.identifier, externalId: envelope.externalId, msgType: envelope.messageType }, 'non-text message stored');
              continue;
            }

            const userText = envelope.text;

            // Turn trace (Issue 22): one collector per WA text turn.
            // Flushed fire-and-forget in the finally, AFTER dispatch.
            const trace = traces.open({
              channel: 'whatsapp',
              tenantId: envelope.tenantId,
              conversationId: conversation.id,
            });

            try {
              // ── 5. PARALLEL: mode check + last_message_at update ───
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

              // ── 6. PARALLEL: RAG + history + customer memory ───────
              console.time(`${tl} parallel-fetch`);

              const endFetch = trace.timer.start('fetch_parallel');
              const { knowledgeChunks, history, facts } = await assembleConversationContext({
                tenantId: envelope.tenantId,
                conversationId: conversation.id,
                customerId: customer.id,
                currentMessageId: messageId, // V-009: exclude this turn's inbound row by id
                text: userText,
                onTiming: (name, ms) => trace.timer.record(`fetch_parallel_${name}`, ms),
              });
              endFetch();

              console.timeEnd(`${tl} parallel-fetch`);

              // ── 7. GENERATE AI REPLY ───────────────────────────────
              let reply;
              try {
                console.time(`${tl} gemini`);
                reply = await aiService.generateReply(
                  tenant, customer, conversation, userText, history, knowledgeChunks, facts,
                  { channel: 'whatsapp', metrics: trace.timer }
                );
                console.timeEnd(`${tl} gemini`);
              } catch (aiErr) {
                logger.error({ tenantId: envelope.tenantId, err: aiErr.message }, 'AI generation failed');
                trace.setErrorFromException(aiErr, 'generate_reply');
                continue;
              }

              // ── 8. SEND VIA WHATSAPP (through dispatchOutbound) ────
              let sentWamid;
              try {
                console.time(`${tl} whatsapp-send`);
                const endDispatch = trace.timer.start('dispatch');
                const { externalId } = await dispatchOutbound({
                  tenantId: envelope.tenantId,
                  customerId: customer.id,
                  channel: 'whatsapp',
                  payload: { text: reply }
                });
                endDispatch();
                sentWamid = externalId;
                console.timeEnd(`${tl} whatsapp-send`);
              } catch (sendErr) {
                logger.error({ tenantId: envelope.tenantId, err: sendErr.message }, 'WhatsApp send failed');
                trace.setErrorFromException(sendErr, 'dispatch');
                continue;
              }

              // ── 9. STORE OUTBOUND AI MESSAGE ───────────────────────
              const endPersistOut = trace.timer.start('persist_outbound');
              await db.query(
                `INSERT INTO messages
                   (tenant_id, conversation_id, customer_id, external_id,
                    direction, sender, content, channel, msg_type)
                 VALUES ($1, $2, $3, $4, 'outbound', 'ai', $5, 'whatsapp', 'text')`,
                [envelope.tenantId, conversation.id, customer.id, sentWamid, reply]
              );
              endPersistOut();

              console.timeEnd(`${tl} total`);
              logger.info({ tenantId: envelope.tenantId, from: envelope.identifier, externalId: envelope.externalId }, 'message processed');
            } finally {
              trace.flush();
            }
          } catch (resultErr) {
            logger.error({ externalId: envelope.externalId, tenantId: envelope.tenantId, err: resultErr.message }, 'reply pipeline failed — message stored, reply skipped');
          }
        }
      }
    }

  } catch (err) {
    logger.error({ err: err.message }, 'webhook error');
  }
};

router.get('/',  verify);
router.post('/', correlation, verifySignature, handle);

module.exports = router;
module.exports._verifySignature = verifySignature;
