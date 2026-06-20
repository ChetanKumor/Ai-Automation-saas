require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TENANT_PHONE_ID = process.argv[2] || '1210047605526057';

async function seed() {
  const { rows: [tenant] } = await pool.query(
    'SELECT id, business_name FROM tenants WHERE phone_number_id = $1', [TENANT_PHONE_ID]
  );
  if (!tenant) { console.error('Tenant not found for phone_number_id:', TENANT_PHONE_ID); process.exit(1); }

  console.log(`Seeding schedules for: ${tenant.business_name} (${tenant.id})`);

  const schedules = [
    { doctor: 'Dr. Sharma', days: ['Mon', 'Wed', 'Fri'], start: '10:00', end: '17:00', slot_minutes: 30 },
    { doctor: 'Dr. Reddy',  days: ['Tue', 'Thu', 'Sat'], start: '09:00', end: '16:00', slot_minutes: 30 },
  ];

  // Clear old schedules for this tenant
  await pool.query("DELETE FROM tenant_entities WHERE tenant_id = $1 AND type = 'schedule'", [tenant.id]);

  for (const sched of schedules) {
    await pool.query(
      'INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1, $2, $3)',
      [tenant.id, 'schedule', JSON.stringify(sched)]
    );
    console.log(`  Added: ${sched.doctor} — ${sched.days.join(', ')} ${sched.start}–${sched.end}`);
  }

  // Set owner_notify_phone (same as the business WhatsApp number for testing)
  await pool.query(
    'UPDATE tenants SET owner_notify_phone = phone_number_id WHERE id = $1',
    [tenant.id]
  );
  console.log('  Set owner_notify_phone = phone_number_id (for testing)');

  console.log('Done.');
  await pool.end();
}

seed().catch(e => { console.error(e); process.exit(1); });
