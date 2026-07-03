'use strict';

const db               = require('../../db/db');
const logger           = require('../../infra/logging/logger');
const knowledgeService = require('../knowledge/knowledgeService');
const customerService  = require('../customer/customerService');

/**
 * Shared conversation context-assembly helper — the SINGLE retrieval path that
 * feeds aiService.generateReply, used by BOTH the WhatsApp and voice channels.
 *
 * This is a behavior-preserving extraction of the inline parallel-fetch that
 * lived in the WhatsApp inbound path (src/modules/channels/whatsapp/routes.js).
 * It returns exactly what that block returned, in the same shape, fetched the
 * same way (one round-trip, in parallel):
 *
 *   - knowledgeChunks : RAG chunks for `text` (best-effort; [] on failure)
 *   - history         : recent message history, oldest-first, EXCLUDING the
 *                       just-inserted inbound row (getRecentMessages OFFSET 1)
 *   - facts           : the customer's long-term memory rows, key-ordered
 *                       (each row also carries updated_at so the voice channel
 *                       can cap to the most recent facts; prompt text built
 *                       from key/value is unchanged)
 *
 * There is no channel-specific branching here: both channels assemble the same
 * context, which is what keeps "one conversation brain" true for voice — there
 * is no second context path. Callers persist the inbound message BEFORE calling
 * this (so history excludes it, matching the WhatsApp ordering).
 *
 * @param {Object}  args
 * @param {string}  args.tenantId
 * @param {string}  args.conversationId
 * @param {string}  args.customerId
 * @param {string}  args.text            The inbound user text (for RAG retrieval).
 * @param {number} [args.ragTopK=3]      Number of knowledge chunks to retrieve.
 * @returns {Promise<{ knowledgeChunks: Array, history: Array, facts: Array }>}
 */
async function assembleConversationContext({ tenantId, conversationId, customerId, text, ragTopK = 3 }) {
  const [knowledgeChunks, history, { rows: facts }] = await Promise.all([
    knowledgeService.getRelevantChunks(tenantId, text, ragTopK).catch((err) => {
      logger.error({ tenantId, err: err.message }, 'RAG failed (continuing without)');
      return [];
    }),
    customerService.getRecentMessages(tenantId, conversationId),
    db.query(
      `SELECT key, value, updated_at FROM customer_memory WHERE tenant_id = $1 AND customer_id = $2 ORDER BY key`,
      [tenantId, customerId]
    ),
  ]);

  return { knowledgeChunks, history, facts };
}

module.exports = { assembleConversationContext };
