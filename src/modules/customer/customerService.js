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

const getRecentMessages = async (tenantId, conversationId, limit = 10) => {
  const { rows } = await db.query(
    `SELECT sender, content FROM messages
     WHERE tenant_id = $1 AND conversation_id = $2
     ORDER BY created_at DESC
     OFFSET 1
     LIMIT $3`,
    [tenantId, conversationId, limit]
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