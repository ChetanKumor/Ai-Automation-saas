const db                  = require('../db/db');
const tenantService       = require('../modules/tenant/tenantService');
const customerService     = require('../modules/customer/customerService');
const conversationService = require('../modules/conversation/conversationService');
const aiService           = require('../modules/ai/aiService');
const knowledgeService    = require('../modules/knowledge/knowledgeService');
const whatsappService     = require('../modules/whatsapp/whatsappService');
const ownerCommandHandler = require('../modules/owner/ownerCommandHandler');

const recentOwnerWamids = new Set();

const verify = (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
};

const handle = async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.[0]) {
      if (value?.statuses) console.log(`[Webhook] Status update: ${value.statuses[0]?.status} for ${value.statuses[0]?.recipient_id}`);
      return;
    }

    const phoneNumberId = value.metadata?.phone_number_id;
    const msg           = value.messages[0];
    const { id: wamid, from, type } = msg;

    if (type !== 'text' || !msg.text?.body) {
      console.log(`[Webhook] Non-text message (${type}) from ${from} — skipping`);
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
      console.warn(`No tenant for phone_number_id: ${phoneNumberId}`);
      return;
    }

    // ── OWNER DETECTION ─────────────────────────────────────────────
    const ownerPhone = tenant.owner_notify_phone?.replace(/\D/g, '');
    const senderNorm = from.replace(/\D/g, '');
    if (ownerPhone && senderNorm === ownerPhone) {
      if (recentOwnerWamids.has(wamid)) {
        console.log(`[Owner] Duplicate wamid ${wamid} — skipping`);
        return;
      }
      recentOwnerWamids.add(wamid);
      setTimeout(() => recentOwnerWamids.delete(wamid), 10 * 60 * 1000);
      console.log(`[${tenant.business_name}] Owner message detected from ${from}`);
      await ownerCommandHandler.handle(tenant, from, userText, wamid);
      return;
    }

    // ── 2. UPSERT CUSTOMER ───────────────────────────────────────────
    console.time(`${timerLabel} customer`);
    const customer = await customerService.findOrCreate(tenant.id, from);
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
      console.log(`Duplicate wamid ${wamid} — skipping`);
      return;
    }

    // ── 5. PARALLEL: mode check + last_message_at update ─────────────
    const [{ rows: [freshConv] }] = await Promise.all([
      db.query(`SELECT mode FROM conversations WHERE id = $1 AND tenant_id = $2`, [conversation.id, tenant.id]),
      db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation.id, tenant.id])
    ]);

    if (!freshConv || freshConv.mode === 'human' || !tenant.ai_enabled) {
      console.log(`[${tenant.business_name}] Skipping AI (mode=${freshConv?.mode}, ai_enabled=${tenant.ai_enabled})`);
      return;
    }

    // ── 6. PARALLEL: RAG + history + customer memory ─────────────────
    console.time(`${timerLabel} parallel-fetch`);

    const [knowledgeChunks, history, { rows: facts }] = await Promise.all([
      knowledgeService.getRelevantChunks(tenant.id, userText, 3).catch(err => {
        console.error(`[${tenant.business_name}] RAG failed (continuing without):`, err.message);
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
      console.error(`[${tenant.business_name}] AI generation failed:`, aiErr.message);
      return;
    }

    // ── 8. SEND VIA WHATSAPP ─────────────────────────────────────────
    try {
      console.time(`${timerLabel} whatsapp-send`);
      await whatsappService.sendMessage(tenant, from, reply);
      console.timeEnd(`${timerLabel} whatsapp-send`);
    } catch (sendErr) {
      console.error(`[${tenant.business_name}] WhatsApp send failed:`, sendErr.message);
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
    console.log(`[${tenant.business_name}] ${from}: "${userText}" → "${reply}"`);

  } catch (err) {
    console.error('Webhook error:', err);
  }
};

module.exports = { verify, handle };
