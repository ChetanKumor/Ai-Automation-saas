const cron            = require('node-cron');
const db              = require('../../db/db');
const tenantService   = require('../tenant/tenantService');
const whatsappService = require('../whatsapp/whatsappService');
const eventBus        = require('../../../core/events');

const LOCK_KEY = 770_201;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

async function tick() {
  let client;
  let lockAcquired = false;

  try {
    client = await db.getClient();

    const { rows: [{ acquired }] } = await client.query(
      `SELECT pg_try_advisory_lock($1) AS acquired`, [LOCK_KEY]
    );
    if (!acquired) {
      console.log('[Collections] Advisory lock held by another process — skipping');
      return;
    }
    lockAcquired = true;

    await reapStuck(client);
    await processDue(client);
    await markOverdue(client);
  } catch (err) {
    console.error('[Collections] Tick failed:', err.message);
  } finally {
    if (lockAcquired && client) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY])
        .catch(err => console.error('[Collections] Advisory unlock failed:', err.message));
    }
    if (client) client.release();
  }
}

async function reapStuck(client) {
  // Permanently fail rows that exceeded max attempts
  const { rowCount: failedCount } = await client.query(
    `UPDATE payment_schedules
     SET status = 'failed'
     WHERE status = 'sending'
       AND attempts >= $1
       AND last_attempt_at < NOW() - INTERVAL '10 minutes'`,
    [MAX_ATTEMPTS]
  );
  if (failedCount > 0) {
    console.log(`[Collections] Permanently failed ${failedCount} row(s) exceeding ${MAX_ATTEMPTS} attempts`);
  }

  // Reset remaining stuck rows to pending for retry
  const { rowCount } = await client.query(
    `UPDATE payment_schedules
     SET status = 'pending', attempts = attempts + 1
     WHERE status = 'sending'
       AND last_attempt_at < NOW() - INTERVAL '10 minutes'`
  );
  if (rowCount > 0) {
    console.log(`[Collections] Reaped ${rowCount} stuck sending row(s)`);
  }
}

async function processDue(client) {
  const { rows: due } = await client.query(
    `SELECT ps.id, ps.tenant_id, ps.customer_id, ps.amount, ps.currency,
            ps.due_date, ps.attempts,
            c.phone AS customer_phone, c.name AS customer_name,
            t.phone_number_id, t.business_name
     FROM payment_schedules ps
     JOIN customers c ON c.id = ps.customer_id
     JOIN tenants t ON t.id = ps.tenant_id
     WHERE ps.status = 'pending'
       AND ps.reminder_send_at <= NOW()
     ORDER BY ps.reminder_send_at ASC
     FOR UPDATE OF ps SKIP LOCKED`
  );

  if (!due.length) return;
  console.log(`[Collections] Processing ${due.length} due reminder(s)`);

  for (const row of due) {
    try {
      await client.query(
        `UPDATE payment_schedules SET status = 'sending', last_attempt_at = NOW() WHERE id = $1`,
        [row.id]
      );

      const withinWindow = await isWithinWindow(client, row.tenant_id, row.customer_id);

      if (!withinWindow) {
        await client.query(
          `UPDATE payment_schedules SET status = 'needs_template' WHERE id = $1`,
          [row.id]
        );
        console.log(`[Collections] needs_template: schedule=${row.id} customer=${row.customer_phone} (outside 24h window)`);
        continue;
      }

      const tenant = await tenantService.getByPhoneNumberId(row.phone_number_id);
      if (!tenant) {
        console.error(`[Collections] Tenant not found for phone_number_id: ${row.phone_number_id}`);
        await client.query(
          `UPDATE payment_schedules SET status = 'failed', attempts = attempts + 1 WHERE id = $1`,
          [row.id]
        );
        continue;
      }

      const text = buildReminderText(row);
      await whatsappService.sendMessage(tenant, row.customer_phone, text);

      // Message accepted by Meta — marking 'sent' is critical; retry if DB hiccups
      let marked = false;
      for (let i = 0; i < 3; i++) {
        try {
          await client.query(
            `UPDATE payment_schedules SET status = 'sent', attempts = attempts + 1 WHERE id = $1`,
            [row.id]
          );
          marked = true;
          break;
        } catch (dbErr) {
          console.error(`[Collections] Retry ${i + 1}/3 marking sent for schedule=${row.id}:`, dbErr.message);
        }
      }
      if (!marked) {
        console.error(`[Collections] CRITICAL: message sent but failed to mark sent — schedule=${row.id}. Row stays in 'sending' to prevent resend.`);
        continue;
      }

      eventBus.emit('payment_reminder_sent', {
        tenant_id: row.tenant_id,
        customer_id: row.customer_id,
        schedule_id: row.id,
        amount: row.amount,
        currency: row.currency,
      });

      console.log(`[Collections] Sent reminder: schedule=${row.id} → ${row.customer_phone} (${row.currency} ${row.amount})`);
    } catch (err) {
      console.error(`[Collections] Send failed for schedule=${row.id}:`, err.message);
      await client.query(
        `UPDATE payment_schedules SET status = 'failed', attempts = attempts + 1 WHERE id = $1`,
        [row.id]
      ).catch(dbErr => console.error(`[Collections] Failed to mark failed: schedule=${row.id}`, dbErr.message));
    }
  }
}

async function markOverdue(client) {
  const { rows: overdue } = await client.query(
    `UPDATE payment_schedules
     SET status = 'overdue'
     WHERE status IN ('pending', 'failed', 'needs_template')
       AND due_date < CURRENT_DATE
     RETURNING id, tenant_id, customer_id, amount, currency`
  );

  for (const row of overdue) {
    eventBus.emit('payment_overdue', {
      tenant_id: row.tenant_id,
      customer_id: row.customer_id,
      schedule_id: row.id,
      amount: row.amount,
      currency: row.currency,
    });
  }

  if (overdue.length > 0) {
    console.log(`[Collections] Marked ${overdue.length} schedule(s) overdue`);
  }
}

async function isWithinWindow(client, tenantId, customerId) {
  const { rows: [row] } = await client.query(
    `SELECT MAX(created_at) AS last_inbound_at
     FROM messages
     WHERE tenant_id = $1 AND customer_id = $2 AND direction = 'inbound'`,
    [tenantId, customerId]
  );
  if (!row?.last_inbound_at) return false;
  return (Date.now() - new Date(row.last_inbound_at).getTime()) < WINDOW_MS;
}

function buildReminderText(row) {
  const dueDateStr = new Date(row.due_date).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'long',
  });
  const name = row.customer_name || 'Hi';
  return `${name}, this is a friendly reminder from ${row.business_name}: ` +
    `your payment of ${row.currency} ${row.amount} is due on ${dueDateStr}. ` +
    `Please make the payment at your earliest convenience. Thank you!`;
}

function start() {
  cron.schedule('*/30 * * * *', () => {
    tick().catch(err => console.error('[Collections] Unhandled tick error:', err.message));
  });
  console.log('[Collections] Cron started — runs every 30 minutes');
}

module.exports = { start, tick };
