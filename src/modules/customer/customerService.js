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

module.exports = { findOrCreate, getRecentMessages };