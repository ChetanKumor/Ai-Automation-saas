const logger              = require('../infra/logging/logger');
const db                  = require('../db/db');
const tenantService       = require('../modules/tenant/tenantService');
const customerService     = require('../modules/customer/customerService');
const identityService     = require('../modules/identity/identityService');
const conversationService = require('../modules/conversation/conversationService');
const aiService           = require('../modules/ai/aiService');
const knowledgeService    = require('../modules/knowledge/knowledgeService');
const whatsappService     = require('../modules/whatsapp/whatsappService');
const ownerCommandHandler = require('../modules/owner/ownerCommandHandler');
const eventBus            = require('../../core/events');

const recentOwnerWamids = new Set();

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

    if (type !== 'text' || !msg.text?.body) {
      logger.info({ type, from }, 'non-text message — skipping');
      return;
    }

    const userText = msg.text.body;
    const timerLabel = `[Pipeline ${wamid.slice(-6)}]`;
    console.time(`${timerLabel} total`);

    // ── 1. RESOLVE TENANT (cached after first hit) ───────────────────
    console.time(`${timerLabel} tenant`);
    const tenant = await tenantService.getByPhoneNumberId(phoneNumberId);
    console.timeEnd(`${timerLabel} tenant`);
    if (!tenant) {
      logger.warn({ phoneNumberId }, 'no tenant for phone_number_id');
      return;
    }

    // ── OWNER DETECTION ─────────────────────────────────────────────
    const ownerPhone = tenant.owner_notify_phone?.replace(/\D/g, '');
    const senderNorm = from.replace(/\D/g, '');
    if (ownerPhone && senderNorm === ownerPhone) {
      if (recentOwnerWamids.has(wamid)) {
        logger.info({ wamid }, 'owner duplicate wamid — skipping');
        return;
      }
      recentOwnerWamids.add(wamid);
      setTimeout(() => recentOwnerWamids.delete(wamid), 10 * 60 * 1000);
      logger.info({ tenantId: tenant.id, from }, 'owner message detected');
      await ownerCommandHandler.handle(tenant, from, userText, wamid);
      return;
    }

    // ── 2. UPSERT CUSTOMER ───────────────────────────────────────────
    console.time(`${timerLabel} customer`);
    const waProfileName = value.contacts?.[0]?.profile?.name || null;
    const customer = process.env.IDENTITY_RESOLUTION_ENABLED === 'true'
      ? await identityService.resolveCustomer({
          tenantId: tenant.id,
          channelType: 'whatsapp',
          identifier: from,
          profile: waProfileName ? { name: waProfileName } : undefined,
        })
      : await customerService.findOrCreate(tenant.id, from);
    console.timeEnd(`${timerLabel} customer`);

    // ── 3. GET OR CREATE OPEN CONVERSATION ───────────────────────────
    console.time(`${timerLabel} conversation`);
    const conversation = await conversationService.getOrCreateOpenConversation(
      tenant.id, customer.id
    );
    console.timeEnd(`${timerLabel} conversation`);

    // ── 4. STORE INBOUND MESSAGE — idempotency via ON CONFLICT ───────
    const { rowCount } = await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, wamid, direction, sender, content)
       VALUES ($1, $2, $3, $4, 'inbound', 'customer', $5)
       ON CONFLICT (wamid) DO NOTHING`,
      [tenant.id, conversation.id, customer.id, wamid, userText]
    );

    if (rowCount === 0) {
      logger.info({ wamid }, 'duplicate wamid — skipping');
      return;
    }

    eventBus.emit('message_received', { tenant_id: tenant.id, customer_id: customer.id, conversation_id: conversation.id, message_id: wamid, text: userText, mode: conversation.mode });

    // ── 5. PARALLEL: mode check + last_message_at update ─────────────
    const [{ rows: [freshConv] }] = await Promise.all([
      db.query(`SELECT mode FROM conversations WHERE id = $1 AND tenant_id = $2`, [conversation.id, tenant.id]),
      db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation.id, tenant.id])
    ]);

    if (!freshConv || freshConv.mode === 'human' || !tenant.ai_enabled) {
      logger.info({ tenantId: tenant.id, mode: freshConv?.mode, aiEnabled: tenant.ai_enabled }, 'skipping AI');

      if (freshConv?.mode === 'human' && tenant.owner_notify_phone) {
        const preview = userText.length > 100 ? userText.slice(0, 97) + '...' : userText;
        try {
          await whatsappService.sendMessage(
            tenant,
            tenant.owner_notify_phone,
            `💬 Message from +${from}:\n${preview}`
          );
          logger.info({ tenantId: tenant.id, chars: preview.length }, 'human mode — forwarded to owner');
        } catch (fwdErr) {
          logger.error({ tenantId: tenant.id, err: fwdErr.message }, 'failed to forward to owner');
        }
      }

      return;
    }

    // ── 6. PARALLEL: RAG + history + customer memory ─────────────────
    console.time(`${timerLabel} parallel-fetch`);

    const [knowledgeChunks, history, { rows: facts }] = await Promise.all([
      knowledgeService.getRelevantChunks(tenant.id, userText, 3).catch(err => {
        logger.error({ tenantId: tenant.id, err: err.message }, 'RAG failed (continuing without)');
        return [];
      }),
      customerService.getRecentMessages(tenant.id, conversation.id),
      db.query(
        `SELECT key, value FROM customer_memory WHERE tenant_id = $1 AND customer_id = $2 ORDER BY key`,
        [tenant.id, customer.id]
      )
    ]);

    console.timeEnd(`${timerLabel} parallel-fetch`);

    // ── 7. GENERATE AI REPLY ─────────────────────────────────────────
    let reply;
    try {
      console.time(`${timerLabel} gemini`);
      reply = await aiService.generateReply(
        tenant, customer, conversation, userText, history, knowledgeChunks, facts
      );
      console.timeEnd(`${timerLabel} gemini`);
    } catch (aiErr) {
      logger.error({ tenantId: tenant.id, err: aiErr.message }, 'AI generation failed');
      return;
    }

    // ── 8. SEND VIA WHATSAPP ─────────────────────────────────────────
    try {
      console.time(`${timerLabel} whatsapp-send`);
      await whatsappService.sendMessage(tenant, from, reply);
      console.timeEnd(`${timerLabel} whatsapp-send`);
    } catch (sendErr) {
      logger.error({ tenantId: tenant.id, err: sendErr.message }, 'WhatsApp send failed');
      return;
    }

    // ── 9. STORE OUTBOUND AI MESSAGE (only after successful send) ────
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, direction, sender, content)
       VALUES ($1, $2, $3, 'outbound', 'ai', $4)`,
      [tenant.id, conversation.id, customer.id, reply]
    );

    console.timeEnd(`${timerLabel} total`);
    logger.info({ tenantId: tenant.id, from, wamid }, 'message processed');

  } catch (err) {
    logger.error({ err: err.message }, 'webhook error');
  }
};

module.exports = { verify, handle };
