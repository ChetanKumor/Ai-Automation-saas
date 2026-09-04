require('dotenv').config();
const { Pool } = require('pg');
/* ── The control connection, and the two guards that keep it off production ──
 *
 * This script writes fabricated schedule rows on whatever this connection
 * names, and its default used to be DATABASE_URL — which on a dev machine
 * here is production Neon, not a dev database (F-A029: DATABASE_URL is
 * ep-dry-bird-….neon.tech/neondb while
 * the suite's TEST_DATABASE_URL is localhost:5432/saas_crm_test).  ADMIN-S5
 * drove a harness of this shape by hand for a red-check and had to override
 * that default at the command line to keep CREATE/DROP DATABASE off the live
 * company.  A default that has to be remembered is not a guard.
 *
 * So: TEST_DATABASE_URL first, and both guards below, copied in shape from
 * scripts/seed-portal-owner.js — the one script in scripts/ that already had
 * them:
 *   Guard 1  NODE_ENV=production.  Refused, with NO override.  Every other
 *            guard here has an escape hatch; this is the one that makes
 *            offering them safe.
 *   Guard 2  the host, asserted on the target pg would really dial, parsed by
 *            pg's own parser.  A regex over the URL text passes
 *            `…?options=host%3Dlocalhost` and rejects a unix socket path;
 *            this does neither.  Non-local requires --allow-remote-host.
 *
 * pg-connection-string is not a new dependency: pg requires this exact module
 * (node_modules/pg/lib/connection-parameters.js:7).
 */
const { parse: parseAdminCs } = require('pg-connection-string');
const SEED_DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!SEED_DB) { console.error('✗ neither TEST_DATABASE_URL nor DATABASE_URL is set.'); process.exit(1); }
if (process.env.NODE_ENV === 'production') {
  console.error('✗ NODE_ENV=production. This script writes fabricated schedule rows and will not run against production.');
  process.exit(1);
}
{
  let adminHost;
  try { adminHost = parseAdminCs(SEED_DB).host || 'localhost'; } catch (err) {
    console.error(`✗ the control connection string could not be parsed by pg's own parser: ${err.message}`);
    process.exit(1);
  }
  const local = adminHost.startsWith('/')
    || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(adminHost.toLowerCase());
  if (!local && !process.argv.includes('--allow-remote-host')) {
    console.error(`✗ database host '${adminHost}' is not local.\n`
      + '  This script writes fabricated schedule rows.\n'
      + '  If that really is your dev database, re-run with --allow-remote-host.');
    process.exit(1);
  }
  if (!local) console.warn(`⚠ Host '${adminHost}' is NOT local — proceeding only because --allow-remote-host was passed.`);
}
const pool = new Pool({ connectionString: SEED_DB });

const TENANT_PHONE_ID = process.argv.slice(2).find((a) => !a.startsWith('--')) || '1210047605526057';

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
