const db = require('../../db/db');

const getOrCreateOpenConversation = async (tenantId, customerId, channel = 'whatsapp') => {
  const { rows } = await db.query(
    `INSERT INTO conversations (tenant_id, customer_id, channel)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, customer_id) WHERE status = 'open'
     DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [tenantId, customerId, channel]
  );
  return rows[0];
};

const setMode = async (tenantId, conversationId, mode) => {
  const { rows } = await db.query(
    `UPDATE conversations SET mode = $2 WHERE id = $1 AND tenant_id = $3 RETURNING *`,
    [conversationId, mode, tenantId]
  );
  return rows[0];
};

module.exports = { getOrCreateOpenConversation, setMode };
