const db = require('../../db/db');
const whatsappService = require('../whatsapp/whatsappService');

async function notifyOwnerOfBooking(tenant, bookingResult) {
  const content = `New appointment: ${bookingResult.patient_name || 'Patient'} with ${bookingResult.doctor} at ${bookingResult.time}`;

  const { rows: [notif] } = await db.query(
    `INSERT INTO notifications (tenant_id, type, content, sent_status)
     VALUES ($1, 'appointment_booked', $2, 'pending') RETURNING id`,
    [tenant.id, content]
  );

  if (!tenant.owner_notify_phone) {
    await db.query('UPDATE notifications SET sent_status = $1 WHERE id = $2', ['no_phone', notif.id]);
    console.log(`[Notification] No owner_notify_phone for tenant ${tenant.business_name} — skipped WhatsApp`);
    return;
  }

  try {
    await whatsappService.sendMessage(tenant, tenant.owner_notify_phone, content);
    await db.query('UPDATE notifications SET sent_status = $1 WHERE id = $2', ['sent', notif.id]);
    console.log(`[Notification] Owner notified: ${content}`);
  } catch (err) {
    const metaError = err.response?.data?.error;
    const isWindowError = metaError?.code === 131047 || metaError?.error_subcode === 131047;
    const status = isWindowError ? 'failed_window' : 'failed';
    await db.query('UPDATE notifications SET sent_status = $1 WHERE id = $2', [status, notif.id]);
    console.error(`[Notification] Owner alert failed (${status}):`, metaError?.message || err.message);
  }
}

module.exports = { notifyOwnerOfBooking };
