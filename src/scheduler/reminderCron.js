const cron = require('node-cron');
const db = require('../db/db');
const tenantService = require('../modules/tenant/tenantService');
const whatsappService = require('../modules/whatsapp/whatsappService');

let running = false;

async function tick() {
  if (running) {
    console.log('[Reminder] Previous tick still running — skipping');
    return;
  }
  running = true;

  try {
    const { rows: due } = await db.query(`
      SELECT a.id AS appointment_id, a.appointment_time, a.doctor_name,
             a.customer_id, a.tenant_id,
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
      WHERE a.status = 'booked'
        AND a.reminder_sent = false
        AND t.reminders_enabled = true
        AND a.appointment_time > NOW()
        AND a.appointment_time <= NOW() + (t.reminder_hours_before || ' hours')::interval
    `);

    if (due.length > 0) {
      console.log(`[Reminder] Found ${due.length} appointment(s) due for reminder`);
    }

    for (const appt of due) {
      try {
        await processReminder(appt);
      } catch (err) {
        console.error(`[Reminder] Error processing appointment ${appt.appointment_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Reminder] Tick failed:', err.message);
  } finally {
    running = false;
  }
}

async function processReminder(appt) {
  const timeIST = new Date(appt.appointment_time)
    .toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

  const reminderText =
    `Reminder: ${appt.customer_name || 'Hi'}, your appointment with ${appt.doctor_name} ` +
    `at ${appt.business_name} is on ${timeIST}. See you soon!`;

  // Determine if customer is within 24h messaging window
  const withinWindow = appt.last_inbound_at &&
    (Date.now() - new Date(appt.last_inbound_at).getTime()) < 24 * 60 * 60 * 1000;

  if (!withinWindow && !appt.reminder_template_id) {
    // Outside window, no template configured — cannot send
    await db.query(
      `INSERT INTO notifications (tenant_id, type, content, sent_status)
       VALUES ($1, 'reminder', $2, 'needs_template')`,
      [appt.tenant_id, reminderText]
    );
    await db.query(
      `UPDATE appointments SET reminder_sent = true, reminder_sent_at = NOW() WHERE id = $1`,
      [appt.appointment_id]
    );
    console.log(
      `[Reminder] SKIPPED (outside 24h window, no template) → ${appt.customer_phone} | ` +
      `Last msg: ${appt.last_inbound_at ? new Date(appt.last_inbound_at).toISOString() : 'never'}`
    );
    return;
  }

  // Get full tenant object with decrypted wa_token
  const tenant = await tenantService.getByPhoneNumberId(appt.phone_number_id);
  if (!tenant) {
    console.error(`[Reminder] Tenant not found for phone_number_id: ${appt.phone_number_id}`);
    return;
  }

  let sentStatus = 'pending';

  if (withinWindow) {
    // Within 24h window — send free-text
    try {
      await whatsappService.sendMessage(tenant, appt.customer_phone, reminderText);
      sentStatus = 'sent';
      console.log(`[Reminder] Sent to ${appt.customer_phone}: ${reminderText}`);
    } catch (err) {
      const metaError = err.response?.data?.error;
      sentStatus = 'failed';
      console.error(`[Reminder] Send failed to ${appt.customer_phone}:`, metaError?.message || err.message);
    }
  } else if (appt.reminder_template_id) {
    // Outside window but template is configured — send template
    try {
      await sendTemplateMessage(tenant, appt);
      sentStatus = 'sent_template';
      console.log(`[Reminder] Template sent to ${appt.customer_phone}`);
    } catch (err) {
      sentStatus = 'failed';
      console.error(`[Reminder] Template send failed to ${appt.customer_phone}:`, err.message);
    }
  }

  // Record notification
  await db.query(
    `INSERT INTO notifications (tenant_id, type, content, sent_status)
     VALUES ($1, 'reminder', $2, $3)`,
    [appt.tenant_id, reminderText, sentStatus]
  );

  // Mark appointment as reminded (idempotency)
  await db.query(
    `UPDATE appointments SET reminder_sent = true, reminder_sent_at = NOW() WHERE id = $1`,
    [appt.appointment_id]
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
      }
    }
  );
}

function start() {
  cron.schedule('*/15 * * * *', () => {
    tick().catch(err => console.error('[Reminder] Unhandled tick error:', err.message));
  });
  console.log('[Reminder] Cron started — runs every 15 minutes');
}

module.exports = { start, tick };
