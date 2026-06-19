const db = require('../../db/db');

const findOrCreate = async (tenantId, phone) => {
  // Try to find first
  const { rows: existing } = await db.query(
    `SELECT * FROM customers WHERE tenant_id = $1 AND phone = $2`,
    [tenantId, phone]
  );

  if (existing[0]) return existing[0];

  // Create new customer
  const { rows } = await db.query(
    `INSERT INTO customers (tenant_id, phone)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING *`,
    [tenantId, phone]
  );

  return rows[0];
};

const getRecentMessages = async (customerId, limit = 10) => {
  const { rows } = await db.query(
    `SELECT role, content FROM messages
     WHERE customer_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [customerId, limit]
  );

  return rows.reverse(); // oldest first for AI context
};

module.exports = { findOrCreate, getRecentMessages };