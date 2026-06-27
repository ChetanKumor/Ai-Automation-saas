const cron            = require('node-cron');
const logger          = require('../../infra/logging/logger');
const db              = require('../../db/db');
const tenantService   = require('../tenant/tenantService');
const whatsappService = require('../whatsapp/whatsappService');
const eventBus        = require('../../../core/events');
const { classifySendError } = require('../../utils/classifySendError');

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
      logger.info('collections advisory lock held — skipping');
      return;
    }
    lockAcquired = true;

    await reapStuck(client);
    await processDue(client);
    await markOverdue(client);
  } catch (err) {
    logger.error({ err: err.message }, 'collections tick failed');
  } finally {
    if (lockAcquired && client) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY])
        .catch(err => logger.error({ err: err.message }, 'collections advisory unlock failed'));
    }
    if (client) client.release();
  }
}

async function reapStuck(client) {
  const { rowCount: recoveredCount } = await client.query(
    `UPDATE payment_schedules
     SET status = 'sent'
     WHERE status = 'sending'
       AND sent_at IS NOT NULL
       AND last_attempt_at < NOW() - INTERVAL '10 minutes'`
  );
  if (recoveredCount > 0) {
    logger.info({ count: recoveredCount }, 'collections recovered sent-but-unmarked rows');
  }

  const { rowCount: failedCount } = await client.query(
    `UPDATE payment_schedules
     SET status = 'failed'
     WHERE status = 'sending'
       AND sent_at IS NULL
       AND attempts >= $1
       AND last_attempt_at < NOW() - INTERVAL '10 minutes'`,
    [MAX_ATTEMPTS]
  );
  if (failedCount > 0) {
    logger.info({ count: failedCount, maxAttempts: MAX_ATTEMPTS }, 'collections permanently failed rows');
  }

  const { rowCount } = await client.query(
    `UPDATE payment_schedules
     SET status = 'pending'
     WHERE status = 'sending'
       AND sent_at IS NULL
       AND attempts < $1
       AND last_attempt_at < NOW() - INTERVAL '10 minutes'`,
    [MAX_ATTEMPTS]
  );
  if (rowCount > 0) {
    logger.info({ count: rowCount }, 'collections reaped stuck sending rows');
  }
}

async function claimDueRows() {
  const claimClient = await db.getClient();
  try {
    await claimClient.query('BEGIN');
    const { rows: due } = await claimClient.query(
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

    if (due.length > 0) {
      const ids = due.map(r => r.id);
      await claimClient.query(
        `UPDATE payment_schedules
         SET status = 'sending', attempts = attempts + 1, last_attempt_at = NOW(), sent_at = NULL
         WHERE id = ANY($1::uuid[])`,
        [ids]
      );
    }

    await claimClient.query('COMMIT');
    return due;
  } catch (err) {
    await claimClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    claimClient.release();
  }
}

async function processDue(client) {
  const due = await claimDueRows();
  if (!due.length) return;
  logger.info({ count: due.length }, 'collections processing due reminders');

  for (const row of due) {
    try {
      const withinWindow = await isWithinWindow(client, row.tenant_id, row.customer_id);

      if (!withinWindow) {
        await client.query(
          `UPDATE payment_schedules SET status = 'needs_template' WHERE id = $1`,
          [row.id]
        );
        logger.info({ scheduleId: row.id, customerPhone: row.customer_phone }, 'collections needs_template — outside 24h window');
        continue;
      }

      const tenant = await tenantService.getByPhoneNumberId(row.phone_number_id);
      if (!tenant) {
        logger.error({ phoneNumberId: row.phone_number_id }, 'collections tenant not found');
        await client.query(
          `UPDATE payment_schedules SET status = 'failed' WHERE id = $1`,
          [row.id]
        );
        continue;
      }

      const text = buildReminderText(row);

      try {
        await whatsappService.sendMessage(tenant, row.customer_phone, text);
      } catch (sendErr) {
        const disposition = classifySendError(sendErr);
        const currentAttempts = row.attempts + 1;
        const metaError = sendErr.response?.data?.error;

        let nextStatus;
        if (disposition === 'timeout') {
          nextStatus = 'needs_review';
          logger.error({ scheduleId: row.id }, 'collections timeout — moved to needs_review');
        } else if (disposition === 'needs_template') {
          nextStatus = 'needs_template';
          logger.info({ scheduleId: row.id }, 'collections needs_template — re-engagement error from Meta');
        } else if (disposition === 'retryable' && currentAttempts < MAX_ATTEMPTS) {
          nextStatus = 'pending';
          logger.warn({ scheduleId: row.id, attempt: currentAttempts, maxAttempts: MAX_ATTEMPTS, err: metaError?.message || sendErr.message }, 'collections retryable error');
        } else {
          nextStatus = 'failed';
          logger.error({ scheduleId: row.id, disposition, status: sendErr.response?.status, code: metaError?.code, err: metaError?.message || sendErr.message }, 'collections permanent failure');
        }

        await client.query(
          `UPDATE payment_schedules SET status = $2 WHERE id = $1`,
          [row.id, nextStatus]
        );
        continue;
      }

      await client.query(
        `UPDATE payment_schedules SET sent_at = NOW() WHERE id = $1`,
        [row.id]
      );

      await client.query(
        `UPDATE payment_schedules SET status = 'sent'
         WHERE id = $1 AND status = 'sending'`,
        [row.id]
      );

      eventBus.emit('payment_reminder_sent', {
        tenant_id: row.tenant_id,
        customer_id: row.customer_id,
        schedule_id: row.id,
        amount: row.amount,
        currency: row.currency,
      });

      logger.info({ scheduleId: row.id, customerPhone: row.customer_phone, currency: row.currency, amount: row.amount }, 'collections reminder sent');
    } catch (err) {
      logger.error({ scheduleId: row.id, err: err.message }, 'collections send failed');
      await client.query(
        `UPDATE payment_schedules SET status = 'failed' WHERE id = $1`,
        [row.id]
      ).catch(dbErr => logger.error({ scheduleId: row.id, err: dbErr.message }, 'collections failed to mark failed'));
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
    logger.info({ count: overdue.length }, 'collections marked schedules overdue');
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
  const task = cron.schedule('*/30 * * * *', () => {
    tick().catch(err => logger.error({ err: err.message }, 'collections unhandled tick error'));
  });
  logger.info('collections cron started — runs every 30 minutes');
  return task;
}

module.exports = { start, tick };
