const db = require('../../db/db');

// Returns the single open conversation for this customer, creating one if none exists.
// The partial unique index (customer_id WHERE status='open') guarantees at most one open
// conversation per customer; the DO UPDATE forces RETURNING to always yield a row.
const getOrCreateOpenConversation = async (tenantId, customerId) => {
  const { rows } = await db.query(
    `INSERT INTO conversations (tenant_id, customer_id)
     VALUES ($1, $2)
     ON CONFLICT (customer_id) WHERE status = 'open'
     DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [tenantId, customerId]
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
