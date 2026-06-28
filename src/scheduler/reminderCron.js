const cron = require('node-cron');
const logger = require('../infra/logging/logger');
const db = require('../db/db');
const tenantService = require('../modules/tenant/tenantService');
const whatsappService = require('../modules/channels/whatsapp/sender');
const { classifySendError } = require('../utils/classifySendError');

const LOCK_KEY = 770_202;
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
      logger.info('reminder advisory lock held — skipping');
      return;
    }
    lockAcquired = true;

    await reapStuck(client);
    await processDue(client);
  } catch (err) {
    logger.error({ err: err.message }, 'reminder tick failed');
  } finally {
    if (lockAcquired && client) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY])
        .catch(err => logger.error({ err: err.message }, 'reminder advisory unlock failed'));
    }
    if (client) client.release();
  }
}

async function reapStuck(client) {
  const { rowCount: recoveredCount } = await client.query(
    `UPDATE appointments
     SET reminder_status = 'sent'
     WHERE reminder_status = 'sending'
       AND reminder_sent_at IS NOT NULL
       AND last_attempt_at < NOW() - INTERVAL '10 minutes'`
  );
  if (recoveredCount > 0) {
    logger.info({ count: recoveredCount }, 'reminder recovered sent-but-unmarked rows');
  }

  const { rowCount: failedCount } = await client.query(
    `UPDATE appointments
     SET reminder_status = 'failed'
     WHERE reminder_status = 'sending'
       AND reminder_sent_at IS NULL
       AND reminder_attempts >= $1
       AND last_attempt_at < NOW() - INTERVAL '10 minutes'`,
    [MAX_ATTEMPTS]
  );
  if (failedCount > 0) {
    logger.info({ count: failedCount, maxAttempts: MAX_ATTEMPTS }, 'reminder permanently failed rows');
  }

  const { rowCount } = await client.query(
    `UPDATE appointments
     SET reminder_status = 'pending'
     WHERE reminder_status = 'sending'
       AND reminder_sent_at IS NULL
       AND reminder_attempts < $1
       AND last_attempt_at < NOW() - INTERVAL '10 minutes'`,
    [MAX_ATTEMPTS]
  );
  if (rowCount > 0) {
    logger.info({ count: rowCount }, 'reminder reaped stuck sending rows');
  }
}

async function claimDueAppointments() {
  const claimClient = await db.getClient();
  try {
    await claimClient.query('BEGIN');
    const { rows: due } = await claimClient.query(`
      SELECT a.id AS appointment_id, a.appointment_time, a.doctor_name,
             a.customer_id, a.tenant_id, a.reminder_attempts,
             c.phone AS customer_phone, c.name AS customer_name,
             t.business_name, t.phone_number_id, t.reminder_hours_before,
             t.reminder_template_id,
             (SELECT MAX(m.created_at) FROM messages m
              WHERE m.customer_id = a.customer_id
                AND m.tenant_id = a.tenant_id
                AND m.direction = 'inbound') AS last_inbound_at
      FROM appointments a
      JOIN tenants t ON t.id = a.tenant_id
      JOIN customers c ON c.id = a.customer_id
      WHERE a.reminder_status = 'pending'
        AND a.status = 'booked'
        AND t.reminders_enabled = true
        AND a.appointment_time > NOW()
        AND a.appointment_time <= NOW() + (t.reminder_hours_before || ' hours')::interval
      FOR UPDATE OF a SKIP LOCKED
    `);

    if (due.length > 0) {
      const ids = due.map(r => r.appointment_id);
      await claimClient.query(
        `UPDATE appointments
         SET reminder_status = 'sending',
             reminder_attempts = reminder_attempts + 1,
             last_attempt_at = NOW(),
             reminder_sent_at = NULL
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
  const due = await claimDueAppointments();
  if (!due.length) return;
  logger.info({ count: due.length }, 'processing due reminders');

  for (const appt of due) {
    try {
      await processReminder(client, appt);
    } catch (err) {
      logger.error({ appointmentId: appt.appointment_id, err: err.message }, 'reminder processing error');
      await client.query(
        `UPDATE appointments SET reminder_status = 'failed' WHERE id = $1`,
        [appt.appointment_id]
      ).catch(dbErr => logger.error({ appointmentId: appt.appointment_id, err: dbErr.message }, 'reminder failed to mark failed'));
    }
  }
}

async function processReminder(client, appt) {
  const timeIST = new Date(appt.appointment_time)
    .toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

  const reminderText =
    `Reminder: ${appt.customer_name || 'Hi'}, your appointment with ${appt.doctor_name} ` +
    `at ${appt.business_name} is on ${timeIST}. See you soon!`;

  const withinWindow = appt.last_inbound_at &&
    (Date.now() - new Date(appt.last_inbound_at).getTime()) < WINDOW_MS;

  if (!withinWindow && !appt.reminder_template_id) {
    await client.query(
      `UPDATE appointments SET reminder_status = 'needs_template' WHERE id = $1`,
      [appt.appointment_id]
    );
    await db.query(
      `INSERT INTO notifications (tenant_id, type, content, sent_status)
       VALUES ($1, 'reminder', $2, 'needs_template')`,
      [appt.tenant_id, reminderText]
    );
    logger.info({ customerPhone: appt.customer_phone, lastInbound: appt.last_inbound_at || 'never' }, 'reminder skipped — outside 24h window, no template');
    return;
  }

  const tenant = await tenantService.getByPhoneNumberId(appt.phone_number_id);
  if (!tenant) {
    logger.error({ phoneNumberId: appt.phone_number_id }, 'reminder tenant not found');
    await client.query(
      `UPDATE appointments SET reminder_status = 'failed' WHERE id = $1`,
      [appt.appointment_id]
    );
    return;
  }

  let sentStatus;
  let sendErr = null;

  if (withinWindow) {
    try {
      await whatsappService.sendMessage(tenant, appt.customer_phone, reminderText);
      sentStatus = 'sent';
      logger.info({ customerPhone: appt.customer_phone }, 'reminder sent');
    } catch (err) {
      sendErr = err;
    }
  } else if (appt.reminder_template_id) {
    try {
      await sendTemplateMessage(tenant, appt);
      sentStatus = 'sent';
      logger.info({ customerPhone: appt.customer_phone }, 'reminder template sent');
    } catch (err) {
      sendErr = err;
    }
  }

  if (sendErr) {
    const disposition = classifySendError(sendErr);
    const currentAttempts = appt.reminder_attempts + 1;
    const metaError = sendErr.response?.data?.error;

    let nextStatus;
    if (disposition === 'timeout') {
      nextStatus = 'needs_review';
      logger.error({ appointmentId: appt.appointment_id }, 'reminder timeout — moved to needs_review');
    } else if (disposition === 'needs_template') {
      nextStatus = 'needs_template';
      logger.info({ appointmentId: appt.appointment_id }, 'reminder needs_template — re-engagement error from Meta');
    } else if (disposition === 'retryable' && currentAttempts < MAX_ATTEMPTS) {
      nextStatus = 'pending';
      logger.warn({ appointmentId: appt.appointment_id, attempt: currentAttempts, maxAttempts: MAX_ATTEMPTS, err: metaError?.message || sendErr.message }, 'reminder retryable error');
    } else {
      nextStatus = 'failed';
      logger.error({ appointmentId: appt.appointment_id, disposition, status: sendErr.response?.status, code: metaError?.code, err: metaError?.message || sendErr.message }, 'reminder permanent failure');
    }

    await client.query(
      `UPDATE appointments SET reminder_status = $2 WHERE id = $1`,
      [appt.appointment_id, nextStatus]
    );

    await db.query(
      `INSERT INTO notifications (tenant_id, type, content, sent_status)
       VALUES ($1, 'reminder', $2, $3)`,
      [appt.tenant_id, reminderText, nextStatus]
    );
    return;
  }

  await client.query(
    `UPDATE appointments SET reminder_sent_at = NOW(), reminder_sent = true WHERE id = $1`,
    [appt.appointment_id]
  );

  await client.query(
    `UPDATE appointments SET reminder_status = 'sent'
     WHERE id = $1 AND reminder_status = 'sending'`,
    [appt.appointment_id]
  );

  await db.query(
    `INSERT INTO notifications (tenant_id, type, content, sent_status)
     VALUES ($1, 'reminder', $2, $3)`,
    [appt.tenant_id, reminderText, sentStatus]
  );
}

async function sendTemplateMessage(tenant, appt) {
  const timeIST = new Date(appt.appointment_time)
    .toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

  const axios = require('axios');
  await axios.post(
    `https://graph.facebook.com/v22.0/${tenant.phone_number_id}/messages`,
    {
      messaging_product: 'whatsapp',
      to: appt.customer_phone,
      type: 'template',
      template: {
        name: appt.reminder_template_id,
        language: { code: 'en' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: appt.customer_name || 'Patient' },
            { type: 'text', text: appt.doctor_name },
            { type: 'text', text: timeIST },
            { type: 'text', text: appt.business_name }
          ]
        }]
      }
    },
    {
      headers: {
        Authorization: `Bearer ${tenant.wa_token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30_000,
    }
  );
}

function start() {
  const task = cron.schedule('*/15 * * * *', () => {
    tick().catch(err => logger.error({ err: err.message }, 'reminder unhandled tick error'));
  });
  logger.info('reminder cron started — runs every 15 minutes');
  return task;
}

module.exports = { start, tick };
