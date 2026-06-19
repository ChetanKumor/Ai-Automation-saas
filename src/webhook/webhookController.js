const db              = require('../db/db');
const tenantService   = require('../modules/tenant/tenantService');
const customerService = require('../modules/customer/customerService');
const aiService       = require('../modules/ai/aiService');
const whatsappService = require('../modules/whatsapp/whatsappService');

// Webhook verification (Meta calls this once when you register URL)
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



// Incoming message handler
const handle = async (req, res) => {
    console.log("Webhook hit:", JSON.stringify(req.body, null, 2));
  // Always respond 200 to Meta immediately — prevent retries
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    // Ignore delivery receipts and read events — only process messages
    if (!value?.messages?.[0]) return;

    const phoneNumberId = value.metadata?.phone_number_id;
    const msg           = value.messages[0];
    const { id: wamid, from, type } = msg;

    // ── 1. IDEMPOTENCY — skip if already processed ──────────────────
    try {
      await db.query(
        `INSERT INTO messages (wamid, tenant_id, customer_id, role, content)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (wamid) DO NOTHING`,
        // We'll do a real insert below; this is just a conflict guard
        // Use a separate small table approach instead:
        [wamid, '00000000-0000-0000-0000-000000000000',
                '00000000-0000-0000-0000-000000000000', 'user', '_check']
      );
    } catch (_) {}

    // Check if wamid already exists properly
    const { rows: dup } = await db.query(
      `SELECT id FROM messages WHERE wamid = $1`, [wamid]
    );
    if (dup[0]) return; // Already processed

    // ── 2. NON-TEXT — skip for now ───────────────────────────────────
    if (type !== 'text' || !msg.text?.body) return;

    const userText = msg.text.body;

    // ── 3. RESOLVE TENANT ────────────────────────────────────────────
    const tenant = await tenantService.getByPhoneNumberId(phoneNumberId);
    if (!tenant) {
      console.warn(`No tenant found for phone_number_id: ${phoneNumberId}`);
      return;
    }

    // ── 4. UPSERT CUSTOMER ───────────────────────────────────────────
    const customer = await customerService.findOrCreate(tenant.id, from);

    // ── 5. SAVE INCOMING MESSAGE ─────────────────────────────────────
    await db.query(
      `INSERT INTO messages (tenant_id, customer_id, wamid, role, content)
       VALUES ($1, $2, $3, 'user', $4)`,
      [tenant.id, customer.id, wamid, userText]
    );

    // ── 6. FETCH HISTORY + GENERATE AI REPLY ────────────────────────
    const history = await customerService.getRecentMessages(customer.id);
    const reply   = await aiService.generateReply(tenant, customer, userText, history);

    // ── 7. SAVE AI REPLY ─────────────────────────────────────────────
    await db.query(
      `INSERT INTO messages (tenant_id, customer_id, role, content)
       VALUES ($1, $2, 'ai', $3)`,
      [tenant.id, customer.id, reply]
    );

    // ── 8. SEND REPLY ────────────────────────────────────────────────
    await whatsappService.sendMessage(tenant, from, reply);

    console.log(`[${tenant.business_name}] ${from}: "${userText}" → "${reply}"`);

  } catch (err) {
    console.error('Webhook error:', err.message);
  }
};

module.exports = { verify, handle };