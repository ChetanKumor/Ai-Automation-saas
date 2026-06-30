require('dotenv').config();

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Pure-unit: every data source is mocked, so this runs WITHOUT a database and
// asserts the shared helper is a behavior-preserving extraction of the WhatsApp
// inline parallel-fetch (same three sources, same shape, same RAG fallback).
const db                = require('../../src/db/db');
const knowledgeService  = require('../../src/modules/knowledge/knowledgeService');
const customerService   = require('../../src/modules/customer/customerService');
const { assembleConversationContext } = require('../../src/modules/conversation/contextAssembler');

const { mock } = require('node:test');

describe('assembleConversationContext (shared context helper)', () => {
  afterEach(() => mock.restoreAll());

  it('assembles { knowledgeChunks, history, facts } from the three sources with the right args', async () => {
    const seen = {};
    mock.method(knowledgeService, 'getRelevantChunks', async (tenantId, text, topK) => {
      seen.rag = { tenantId, text, topK };
      return [{ content: 'clinic hours 9-6' }];
    });
    mock.method(customerService, 'getRecentMessages', async (tenantId, conversationId) => {
      seen.history = { tenantId, conversationId };
      return [{ sender: 'customer', content: 'hi' }];
    });
    mock.method(db, 'query', async (text, params) => {
      seen.facts = { text, params };
      return { rows: [{ key: 'budget', value: '50000' }] };
    });

    const out = await assembleConversationContext({
      tenantId: 'T1',
      conversationId: 'C1',
      customerId: 'U1',
      text: 'what are your hours?',
    });

    assert.deepEqual(out.knowledgeChunks, [{ content: 'clinic hours 9-6' }]);
    assert.deepEqual(out.history, [{ sender: 'customer', content: 'hi' }]);
    assert.deepEqual(out.facts, [{ key: 'budget', value: '50000' }]);

    // RAG gets the inbound text + default topK of 3 (matches the WhatsApp path).
    assert.deepEqual(seen.rag, { tenantId: 'T1', text: 'what are your hours?', topK: 3 });
    assert.deepEqual(seen.history, { tenantId: 'T1', conversationId: 'C1' });
    // Memory facts are tenant- AND customer-scoped, key-ordered.
    assert.match(seen.facts.text, /FROM customer_memory/);
    assert.match(seen.facts.text, /ORDER BY key/);
    assert.deepEqual(seen.facts.params, ['T1', 'U1']);
  });

  it('RAG failure is best-effort: knowledgeChunks=[] while history/facts still return', async () => {
    mock.method(knowledgeService, 'getRelevantChunks', async () => { throw new Error('embeddings down'); });
    mock.method(customerService, 'getRecentMessages', async () => [{ sender: 'ai', content: 'earlier reply' }]);
    mock.method(db, 'query', async () => ({ rows: [{ key: 'lang', value: 'te' }] }));

    const out = await assembleConversationContext({
      tenantId: 'T1', conversationId: 'C1', customerId: 'U1', text: 'hello',
    });

    assert.deepEqual(out.knowledgeChunks, []);
    assert.deepEqual(out.history, [{ sender: 'ai', content: 'earlier reply' }]);
    assert.deepEqual(out.facts, [{ key: 'lang', value: 'te' }]);
  });

  it('honors a custom ragTopK', async () => {
    let topKSeen;
    mock.method(knowledgeService, 'getRelevantChunks', async (_t, _x, topK) => { topKSeen = topK; return []; });
    mock.method(customerService, 'getRecentMessages', async () => []);
    mock.method(db, 'query', async () => ({ rows: [] }));

    await assembleConversationContext({ tenantId: 'T', conversationId: 'C', customerId: 'U', text: 'x', ragTopK: 5 });
    assert.equal(topKSeen, 5);
  });
});
