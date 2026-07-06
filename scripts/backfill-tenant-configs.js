#!/usr/bin/env node
'use strict';

// Dev utility (Issue 8): seed clinicDefaults for every tenant that has no
// tenant_configs row yet. Idempotent — tenants that already have a config row
// are skipped (the LEFT JOIN filter), so re-running is safe and writes nothing.
//
// Writes THROUGH configService (source 'cli'), so each seed lands exactly like a
// real write: version=1 in tenant_configs plus a matching tenant_config_revisions
// row. This is NOT wired into boot or migrations — invoke it explicitly.
//
//   node scripts/backfill-tenant-configs.js

require('dotenv').config();
const db = require('../src/db/db');
const { writeTenantConfig } = require('../src/modules/config/configService');

async function main() {
  const { rows: tenants } = await db.query(
    `SELECT t.id, t.business_name
       FROM tenants t
       LEFT JOIN tenant_configs c ON c.tenant_id = t.id
      WHERE c.tenant_id IS NULL
      ORDER BY t.created_at`);

  if (tenants.length === 0) {
    console.log('All tenants already have a config row — nothing to backfill.');
    return;
  }

  console.log(`Backfilling clinicDefaults for ${tenants.length} tenant(s):`);
  for (const t of tenants) {
    const { version } = await writeTenantConfig(t.id, {}, 'cli');
    console.log(`  ✓ ${t.business_name} (${t.id}) → version ${version}`);
  }
  console.log('Done.');
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    // Surface path-level validation issues verbatim if it was a config error.
    console.error('Backfill failed:', err.issues || err.message || err);
    await db.close();
    process.exit(1);
  });
