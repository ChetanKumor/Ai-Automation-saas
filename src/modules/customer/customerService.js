const db = require('../../db/db');

const findOrCreate = async (tenantId, phone) => {
  const { rows } = await db.query(
    `INSERT INTO customers (tenant_id, phone, last_seen_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (tenant_id, phone) DO UPDATE SET last_seen_at = NOW()
     RETURNING *`,
    [tenantId, phone]
  );
  return rows[0];
};

/**
 * Recent message history for a conversation, oldest-first, EXCLUDING the current
 * turn's just-inserted inbound message by its id.
 *
 * V-009: the incumbent excluded the current message with `OFFSET 1`, which assumes
 * the newest row IS the current one. On the shared cross-channel conversation that
 * is a race — a WhatsApp message landing while a voice turn hydrates makes OFFSET 1
 * drop the WRONG (concurrent) row while the current message duplicates into history.
 * We exclude by the known inserted id instead: no OFFSET, no ordering assumption.
 *
 * `excludeMessageId` is REQUIRED (throws if absent) so no caller can silently
 * regress to the positional race. Ordering/limit semantics are otherwise unchanged.
 *
 * @param {string} tenantId
 * @param {string} conversationId
 * @param {string} excludeMessageId  id of the current turn's inbound message row.
 * @param {number} [limit=10]
 */
const getRecentMessages = async (tenantId, conversationId, excludeMessageId, limit = 10) => {
  if (!excludeMessageId) {
    throw new Error('getRecentMessages: excludeMessageId is required (V-009: exclude current message by id, not OFFSET 1)');
  }
  const { rows } = await db.query(
    `SELECT sender, content FROM messages
     WHERE tenant_id = $1 AND conversation_id = $2 AND id <> $3
     ORDER BY created_at DESC
     LIMIT $4`,
    [tenantId, conversationId, excludeMessageId, limit]
  );
  return rows.reverse(); // oldest first for AI context
};

/**
 * Resolve the effective language for a customer interaction, honoring the stored
 * preferred_language prior. STT-detected language is used only when the prior is
 * null, and is persisted as the new prior (first-detection write-back).
 *
 * @param {string} tenantId
 * @param {string} customerId
 * @param {string|null} detected  Language detected by STT for this turn.
 * @returns {Promise<string|null>} the effective language
 */
const resolveLanguage = async (tenantId, customerId, detected = null) => {
  const { rows: [row] } = await db.query(
    'SELECT preferred_language FROM customers WHERE id = $1 AND tenant_id = $2',
    [customerId, tenantId]
  );

  const existing = row ? row.preferred_language : null;
  if (existing) return existing; // stored prior wins; ignore detection

  if (detected) {
    // First detection — persist it (guarded so we never overwrite a set prior).
    await db.query(
      `UPDATE customers SET preferred_language = $1
       WHERE id = $2 AND tenant_id = $3 AND preferred_language IS NULL`,
      [detected, customerId, tenantId]
    );
    return detected;
  }

  return null;
};

module.exports = { findOrCreate, getRecentMessages, resolveLanguage };