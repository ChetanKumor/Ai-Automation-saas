const db                  = require('../db/db');
const tenantService       = require('../modules/tenant/tenantService');
const customerService     = require('../modules/customer/customerService');
const conversationService = require('../modules/conversation/conversationService');
const aiService           = require('../modules/ai/aiService');
const knowledgeService    = require('../modules/knowledge/knowledgeService');
const whatsappService     = require('../modules/whatsapp/whatsappService');

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
  // Respond immediately — prevents Meta from retrying on slow processing
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.[0]) return;

    const phoneNumberId = value.metadata?.phone_number_id;
    const msg           = value.messages[0];
    const { id: wamid, from, type } = msg;

    // Only handle text messages for now
    if (type !== 'text' || !msg.text?.body) return;

    const userText = msg.text.body;

    // ── 1. RESOLVE TENANT ────────────────────────────────────────────
    const tenant = await tenantService.getByPhoneNumberId(phoneNumberId);
    if (!tenant) {
      console.warn(`No tenant for phone_number_id: ${phoneNumberId}`);
      return;
    }

    // ── 2. UPSERT CUSTOMER — stamps last_seen_at ─────────────────────
    const customer = await customerService.findOrCreate(tenant.id, from);

    // ── 3. GET OR CREATE OPEN CONVERSATION ───────────────────────────
    const conversation = await conversationService.getOrCreateOpenConversation(
      tenant.id, customer.id
    );

    // ── 4. STORE INBOUND MESSAGE — idempotency via ON CONFLICT ───────
    // rowCount === 0 means wamid already exists → duplicate delivery from Meta
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

    await db.query(
      `UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [conversation.id, tenant.id]
    );

    // ── 5. HUMAN HANDOFF / AI-DISABLED CHECK ─────────────────────────
    // Re-read mode from DB to avoid race condition where agent took over
    // between getOrCreate and here
    const { rows: [freshConv] } = await db.query(
      `SELECT mode FROM conversations WHERE id = $1 AND tenant_id = $2`,
      [conversation.id, tenant.id]
    );
    if (!freshConv || freshConv.mode === 'human' || !tenant.ai_enabled) {
      console.log(`[${tenant.business_name}] Skipping AI (mode=${freshConv?.mode}, ai_enabled=${tenant.ai_enabled})`);
      return;
    }

    // ── 6. RAG — retrieve relevant business knowledge ─────────────
    let knowledgeChunks = [];
    try {
      knowledgeChunks = await knowledgeService.getRelevantChunks(tenant.id, userText, 3);
    } catch (ragErr) {
      console.error(`[${tenant.business_name}] RAG retrieval failed (continuing without):`, ragErr.message);
    }

    // ── 7. FETCH HISTORY + GENERATE AI REPLY ────────────────────────
    let reply;
    try {
      const history = await customerService.getRecentMessages(tenant.id, conversation.id);
      reply = await aiService.generateReply(
        tenant, customer, conversation, userText, history, knowledgeChunks
      );
    } catch (aiErr) {
      console.error(`[${tenant.business_name}] AI generation failed:`, aiErr.message);
      return;
    }

    // ── 8. SEND VIA WHATSAPP ─────────────────────────────────────────
    try {
      await whatsappService.sendMessage(tenant, from, reply);
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

    console.log(`[${tenant.business_name}] ${from}: "${userText}" → "${reply}"`);

  } catch (err) {
    console.error('Webhook error:', err);
  }
};

module.exports = { verify, handle };
