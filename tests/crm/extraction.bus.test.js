require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ── LLM seam stub ───────────────────────────────────────────────────
// extractionHandler instantiates GoogleGenerativeAI at module load, so the
// stub must be in the require cache BEFORE the handler is required.
const FIXED_EXTRACTION = {
  name: 'Bus Test Lead',
  requirement: '2BHK flat',
  budget: '50L',
  intent_level: 'high',
};

let llmCalls = 0;

const genaiPath = require.resolve('@google/generative-ai');
require.cache[genaiPath] = {
  id: genaiPath,
  filename: genaiPath,
  loaded: true,
  exports: {
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return {
          generateContent: async () => {
            llmCalls += 1;
            return { response: { text: () => JSON.stringify(FIXED_EXTRACTION) } };
          },
        };
      }
    },
  },
};

const db = require('../../src/db/db');
const eventBus = require('../../core/events');
const EVENT = require('../../core/eventTypes');
const extractionHandler = require('../../src/modules/crm/extractionHandler');

const TENANT_ID = '00000000-0000-0000-0000-dddddddd0001';
const PHONE = '919990001234';

let customerId;
let conversationId;

async function waitFor(cond, timeoutMs = 3000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

async function leadRows() {
  const { rows } = await db.query(
    'SELECT * FROM leads WHERE tenant_id = $1 AND customer_id = $2',
    [TENANT_ID, customerId]
  );
  return rows;
}

describe('CRM extraction subscribes to canonical message.received (bus-level)', () => {
  before(async () => {
    // Cascade-clean any residue from a previous crashed run, then seed fresh.
    await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, active, ai_enabled)
       VALUES ($1, 'CRM Bus Test', 'pnid_crm_bus_test', true, true)`,
      [TENANT_ID]
    );
    const { rows: [customer] } = await db.query(
      'INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING id',
      [TENANT_ID, PHONE]
    );
    customerId = customer.id;
    const { rows: [conversation] } = await db.query(
      'INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id',
      [TENANT_ID, customerId]
    );
    conversationId = conversation.id;

    extractionHandler.init();
  });

  after(async () => {
    await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
    await db.close();
  });

  it('negative control: an unrelated event does not invoke the extraction handler', async () => {
    eventBus.emit(EVENT.CALL_STARTED, {
      tenant_id: TENANT_ID,
      customer_id: customerId,
      conversation_id: conversationId,
      text: 'I want a 2BHK flat, budget 50 lakh',
      mode: 'ai',
    });

    await new Promise((r) => setImmediate(() => setTimeout(r, 200)));

    assert.equal(llmCalls, 0, 'extraction must not run for unrelated events');
    assert.equal((await leadRows()).length, 0);
  });

  it('message.received emitted via the bus runs extraction and upserts a lead', async () => {
    // Exact payload shape production emits (channels/index.js:90,
    // internalVoice.js:155/:326).
    eventBus.emit(EVENT.MESSAGE_RECEIVED, {
      tenant_id: TENANT_ID,
      customer_id: customerId,
      conversation_id: conversationId,
      message_id: 'wamid.crm-bus-test-1',
      text: 'I want a 2BHK flat, budget 50 lakh',
      mode: 'ai',
    });

    const ran = await waitFor(async () => llmCalls > 0 && (await leadRows()).length > 0);
    assert.ok(ran, 'CRM handler never ran for the canonical message.received event');

    assert.equal(llmCalls, 1, 'handler must fire exactly once (single subscription)');

    const rows = await leadRows();
    assert.equal(rows.length, 1);
    const lead = rows[0];
    assert.equal(lead.tenant_id, TENANT_ID);
    assert.equal(lead.customer_id, customerId);
    assert.equal(lead.conversation_id, conversationId);
    assert.equal(lead.name, FIXED_EXTRACTION.name);
    assert.equal(lead.requirement, FIXED_EXTRACTION.requirement);
    assert.equal(lead.budget, FIXED_EXTRACTION.budget);
    assert.equal(lead.intent_level, FIXED_EXTRACTION.intent_level);
    assert.equal(lead.stage, 'new');
    assert.equal(lead.source, 'whatsapp');
  });
});
