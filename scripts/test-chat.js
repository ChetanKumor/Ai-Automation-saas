#!/usr/bin/env node
// Local test harness: simulates the full webhook pipeline without WhatsApp or ngrok.
// Usage:
//   node scripts/test-chat.js                        # interactive mode
//   node scripts/test-chat.js "doctor available?"     # single message

require('dotenv').config();
const readline = require('readline');
const db = require('../src/db/db');
const tenantService = require('../src/modules/tenant/tenantService');
const customerService = require('../src/modules/customer/customerService');
const conversationService = require('../src/modules/conversation/conversationService');
const knowledgeService = require('../src/modules/knowledge/knowledgeService');
const aiService = require('../src/modules/ai/aiService');

const TENANT_PHONE_ID = process.env.TEST_TENANT_PHONE_ID || '1210047605526057';
const TEST_CUSTOMER_PHONE = process.env.TEST_CUSTOMER_PHONE || '919999900000';

async function processMessage(tenant, customer, conversation, text) {
  const [knowledgeChunks, history, { rows: facts }] = await Promise.all([
    knowledgeService.getRelevantChunks(tenant.id, text, 3).catch(() => []),
    customerService.getRecentMessages(tenant.id, conversation.id),
    db.query(
      `SELECT key, value FROM customer_memory WHERE tenant_id = $1 AND customer_id = $2 ORDER BY key`,
      [tenant.id, customer.id]
    )
  ]);

  const reply = await aiService.generateReply(
    tenant, customer, conversation, text, history, knowledgeChunks, facts
  );

  // Store both messages so history builds up across turns
  const testWamid = 'test_' + Date.now();
  await db.query(
    `INSERT INTO messages
       (tenant_id, conversation_id, customer_id, external_id,
        direction, sender, content, channel)
     VALUES ($1, $2, $3, $4, 'inbound', 'customer', $5, 'whatsapp')
     ON CONFLICT (tenant_id, channel, external_id)
       WHERE external_id IS NOT NULL DO NOTHING`,
    [tenant.id, conversation.id, customer.id, testWamid, text]
  );
  await db.query(
    `INSERT INTO messages
       (tenant_id, conversation_id, customer_id, direction, sender, content, channel)
     VALUES ($1, $2, $3, 'outbound', 'ai', $4, 'whatsapp')`,
    [tenant.id, conversation.id, customer.id, reply]
  );

  return reply;
}

async function main() {
  const tenant = await tenantService.getByPhoneNumberId(TENANT_PHONE_ID);
  if (!tenant) { console.error('Tenant not found:', TENANT_PHONE_ID); process.exit(1); }
  console.log(`Tenant: ${tenant.business_name}`);

  const customer = await customerService.findOrCreate(tenant.id, TEST_CUSTOMER_PHONE);
  const conversation = await conversationService.getOrCreateOpenConversation(tenant.id, customer.id);
  console.log(`Customer: ${customer.phone} | Conversation: ${conversation.id}\n`);

  // Single-message mode
  const oneShot = process.argv.slice(2).join(' ').trim();
  if (oneShot) {
    const reply = await processMessage(tenant, customer, conversation, oneShot);
    console.log(`Bot: ${reply}`);
    process.exit(0);
  }

  // Interactive mode
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.question('You: ', async (input) => {
    const text = input.trim();
    if (!text || text === 'exit') { rl.close(); process.exit(0); }
    try {
      const reply = await processMessage(tenant, customer, conversation, text);
      console.log(`Bot: ${reply}\n`);
    } catch (err) {
      console.error('Error:', err.message);
    }
    prompt();
  });

  prompt();
}

main().catch(e => { console.error(e); process.exit(1); });
