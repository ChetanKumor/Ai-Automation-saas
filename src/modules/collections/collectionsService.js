const db       = require('../../db/db');
const eventBus = require('../../../core/events');

async function schedulePayment(tenantId, customerId, { amount, currency, due_date, reminder_send_at }) {
  const { rows } = await db.query(
    `INSERT INTO payment_schedules
       (tenant_id, customer_id, amount, currency, due_date, reminder_send_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [tenantId, customerId, amount, currency || 'INR', due_date, reminder_send_at]
  );
  return rows[0];
}

async function markPaid(tenantId, scheduleId) {
  const { rows: [row] } = await db.query(
    `UPDATE payment_schedules
     SET status = 'paid'
     WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('paid')
     RETURNING *`,
    [scheduleId, tenantId]
  );

  if (!row) return { error: 'Schedule not found or already paid' };

  eventBus.emit('payment_received', {
    tenant_id: tenantId,
    customer_id: row.customer_id,
    schedule_id: row.id,
    amount: row.amount,
    currency: row.currency,
  });

  console.log(`[Collections] payment_received: schedule=${row.id} amount=${row.amount}`);
  return { schedule: row };
}

async function getByTenant(tenantId, { status, limit = 50 } = {}) {
  let sql = `SELECT ps.*, c.phone AS customer_phone, c.name AS customer_name
             FROM payment_schedules ps
             JOIN customers c ON c.id = ps.customer_id
             WHERE ps.tenant_id = $1`;
  const params = [tenantId];

  if (status) {
    params.push(status);
    sql += ` AND ps.status = $${params.length}`;
  }

  params.push(Math.min(Number(limit) || 50, 200));
  sql += ` ORDER BY ps.due_date ASC LIMIT $${params.length}`;

  const { rows } = await db.query(sql, params);
  return rows;
}

module.exports = { schedulePayment, markPaid, getByTenant };
