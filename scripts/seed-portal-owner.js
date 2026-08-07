#!/usr/bin/env node
'use strict';

// seed-portal-owner — create or update a portal owner on a LOCAL DEV tenant with
// a password you supply, so the portal can be signed into for review without
// depending on a one-time temp password from the admin panel.
//
// Usage:
//   PORTAL_SEED_PASSWORD='…' node scripts/seed-portal-owner.js --email you@example.com
//     [--tenant <uuid>] [--password <pw>] [--allow-remote-host] [--allow-second-owner]
//
// Exit codes: 0 success · 1 refused (guard tripped, bad input, or tenant missing).
//
// DEV TOOLING. This writes a password YOU chose, which means it is a password
// that has been typed, shell-historied and possibly screen-shared. It is not the
// operator reset path: that is the admin panel's
// POST /admin/api/tenants/:id/owner/reset, which generates the password server-side
// precisely so no operator ever knows it. Never point this at a real clinic.
//
// ── On email casing ──────────────────────────────────────────────────────────
// The email is stored trimmed and LOWERCASED. That matches the login path with no
// defect in between, verified rather than assumed:
//   src/portal/routes.js:98-100   lowercases + trims the submitted email
//   src/portal/routes.js:114-116  looks up `WHERE lower(email) = $1`
//   src/admin/adminRoutes.js:794-797  lowercases before its INSERT (the only
//                                     `INSERT INTO users` in all of src/)
// Both sides lower, so the row this script writes logs in with the CURRENT code.
// No casing issue was filed, because there is none.

require('dotenv').config();

// pg's OWN connection-string parser (node_modules/pg/lib/connection-parameters.js:7
// requires this exact module). Using it means the host guard below asserts on the
// target pg would really dial, not on a substring of the env var — a string match
// would pass `…?options=host%3Dlocalhost` and fail a socket path. Not a new
// dependency: it is a direct dependency of pg, already installed.
const { parse: parseConnectionString } = require('pg-connection-string');

const db = require('../src/db/db');
const { status } = require('../src/db/migrate');
// The single hashing path. scrypt and its work factors are NEVER restated here —
// auth.js encodes them into the stored string so verify reads them back. A second
// copy of those parameters is how a seeded row stops verifying after a bump.
const { hashPassword } = require('../src/portal/auth');

// Smile Dental (Voice Dev) — the long-lived local dev tenant.
const DEFAULT_TENANT = '11111111-1111-1111-1111-111111111111';

// Same permissive shape the admin create route uses (adminRoutes.js:781): one @,
// a dot in the domain, no whitespace. We are not the arbiter of deliverable
// addresses — there is no email transport anywhere in this repo.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = `Usage:
  PORTAL_SEED_PASSWORD='…' node scripts/seed-portal-owner.js --email <address>
    [--tenant <uuid>]           default ${DEFAULT_TENANT} (Smile Dental (Voice Dev))
    [--password <pw>]           prefer PORTAL_SEED_PASSWORD — a CLI password lands
                                in your shell history and the process list
    [--allow-remote-host]       permit a non-local database host
    [--allow-second-owner]      permit a tenant that already has a different active owner`;

function die(msg, { usage = false } = {}) {
  console.error(`✗ ${msg}`);
  if (usage) console.error(`\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    email: null, tenant: DEFAULT_TENANT, password: null,
    allowRemoteHost: false, allowSecondOwner: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--allow-remote-host') out.allowRemoteHost = true;
    else if (a === '--allow-second-owner') out.allowSecondOwner = true;
    else if (a === '--email') out.email = args[++i];
    else if (a === '--tenant') out.tenant = args[++i];
    else if (a === '--password') out.password = args[++i];
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else die(`Unknown argument: ${a}`, { usage: true });
  }
  return out;
}

// ── Guard 1: never production ────────────────────────────────────────────────
// No flag overrides this one. Every other guard here has an escape hatch; this
// one is the reason the escape hatches are safe to offer.
function assertNotProduction() {
  if (process.env.NODE_ENV === 'production') {
    die('NODE_ENV=production. This script writes a human-chosen password and will not run against production.');
  }
}

// ── Guard 2: the database host ───────────────────────────────────────────────
// Asserts on the PARSED connection target, never on the env var's text. pg
// defaults an absent host to 'localhost' (node_modules/pg/lib/defaults.js:12) and
// treats a leading '/' as a unix domain socket (connection-parameters.js:105);
// both are local, and both are reproduced here so the guard agrees with the
// driver rather than with an assumption about it.
function resolveDbTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) die('DATABASE_URL is not set.');

  let parsed;
  try {
    parsed = parseConnectionString(url);
  } catch (err) {
    die(`DATABASE_URL could not be parsed by pg's own parser: ${err.message}`);
  }

  const host = parsed.host || 'localhost';
  const isSocket = host.startsWith('/');
  const isLocal = isSocket || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());
  return { host, database: parsed.database || '(default)', isLocal };
}

function assertLocalHost(target, allowRemoteHost) {
  if (target.isLocal) return;
  if (!allowRemoteHost) {
    die(`database host '${target.host}' is not local.\n` +
        "  This tenant's data may not be yours to rewrite. If this really is your dev\n" +
        '  database, re-run with --allow-remote-host.');
  }
  console.warn(`⚠ Host '${target.host}' is NOT local — proceeding only because --allow-remote-host was passed.`);
}

// ── Guard 3: pending migrations ──────────────────────────────────────────────
// Mirrors provision-tenant.js:79-86, and it is the guard this script exists
// because of. A dev database one migration behind is what made portal login
// return 500 for every account: login SELECTs users.password_changed_at
// (routes.js:115), migration 027 adds it, and an unmigrated database raises
// 42703 — which routes.js:119-122 turns into a 500 and login.html:132-136 then
// renders as "That email and password don't match". A perfect row in a stale
// schema is unloggable-into, so refusing here is cheaper than the diagnosis.
async function assertMigrationsCurrent() {
  const st = await status({ logger: { log() {}, error() {} } });
  if (st.hasPending) {
    die(`${st.pending.length} pending migration(s): ${st.pending.join(', ')}\n` +
        '  Run `npm run db:migrate` first — portal login reads a column a stale schema may not have.');
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  assertNotProduction();
  const target = resolveDbTarget();
  assertLocalHost(target, opts.allowRemoteHost);

  // ── Password: supplied, never generated, never defaulted ───────────────────
  // No fallback of any kind. A script that invents a password when you forget to
  // pass one is a script that puts a password you do not know into your database.
  const password = process.env.PORTAL_SEED_PASSWORD || opts.password;
  if (typeof password !== 'string' || password.trim().length === 0) {
    die('No password supplied. Set PORTAL_SEED_PASSWORD or pass --password. There is no default.',
      { usage: true });
  }
  if (opts.password) {
    console.warn('⚠ --password was used: that value is now in your shell history and was visible in the process list.');
  }

  const email = typeof opts.email === 'string' ? opts.email.trim().toLowerCase() : '';
  if (!email) die('--email is required.', { usage: true });
  if (!EMAIL_RE.test(email)) die(`Not a valid email address: ${email}`);
  if (!UUID_RE.test(opts.tenant)) die(`Not a valid tenant UUID: ${opts.tenant}`);

  await assertMigrationsCurrent();

  const t = await db.query('SELECT id, business_name FROM tenants WHERE id = $1', [opts.tenant]);
  if (!t.rows[0]) die(`Tenant not found: ${opts.tenant}`);
  const tenant = t.rows[0];

  // ── Guard 4: don't manufacture the ambiguity that breaks the reset route ───
  // findTenantOwner (adminRoutes.js:854-862) returns { count, owner: null } when a
  // tenant holds more than one active owner, and both the reset route (:940-944)
  // and its verification card refuse rather than guess which one to act on. `users`
  // is UNIQUE (tenant_id, email) only, so nothing in the schema stops a second
  // owner row — this guard is the thing that stops it. Matched on lower(email) for
  // the same reason login is.
  const others = await db.query(
    `SELECT email FROM users
      WHERE tenant_id = $1 AND role = 'owner' AND active = true AND lower(email) <> $2
      ORDER BY created_at`,
    [opts.tenant, email]
  );
  if (others.rowCount > 0) {
    const list = others.rows.map((r) => r.email).join(', ');
    if (!opts.allowSecondOwner) {
      die(`'${tenant.business_name}' already has ${others.rowCount} other active owner account(s): ${list}\n` +
          '  Adding another makes the admin password-reset route refuse this tenant with a 409.\n' +
          '  Re-run with --allow-second-owner if that is what you want.');
    }
    console.warn(`⚠ Creating a second owner alongside: ${list}`);
    console.warn('  The admin reset route will now refuse this tenant with a 409 (owner ambiguity).');
  }

  // ── Upsert ─────────────────────────────────────────────────────────────────
  // Found by lower(email) rather than by the UNIQUE (tenant_id, email) index, so a
  // pre-existing mixed-case row is UPDATED rather than duplicated — the index is
  // on the raw column, but login matches on lower(email), and two rows differing
  // only in case would make login's `rows.length === 1` rule fail closed forever.
  const existing = await db.query(
    'SELECT id, email, active, role FROM users WHERE tenant_id = $1 AND lower(email) = $2',
    [opts.tenant, email]
  );

  const hash = hashPassword(password);
  let userId;
  let action;

  if (existing.rows[0]) {
    const row = existing.rows[0];
    // password_changed_at is moved DELIBERATELY, not incidentally. It is the
    // session epoch (migration 027): requirePortalAuth compares the session's copy
    // to this column on every request, so moving it signs out every existing
    // session for this user. Re-running this script is therefore idempotent in the
    // row it leaves behind, but NOT invisible to anyone signed in as that user.
    // role/active are re-asserted so a deactivated or demoted dev account is
    // repaired by a re-run instead of silently staying unusable.
    const upd = await db.query(
      `UPDATE users
          SET password_hash = $1, password_changed_at = NOW(),
              role = 'owner', active = true, email = $2
        WHERE id = $3 AND tenant_id = $4
        RETURNING id`,
      [hash, email, row.id, opts.tenant]
    );
    userId = upd.rows[0].id;
    action = 'updated';
  } else {
    try {
      const ins = await db.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, active)
         VALUES ($1, $2, $3, 'owner', true) RETURNING id`,
        [opts.tenant, email, hash]
      );
      userId = ins.rows[0].id;
      action = 'created';
    } catch (err) {
      if (err.code === '23505') {
        die(`A user with this email already exists for this tenant under different casing: ${email}`);
      }
      throw err;
    }
  }

  const port = process.env.PORT || 3000;
  console.log('');
  console.log(`✓ Portal owner ${action}.`);
  console.log(`  Tenant   : ${tenant.business_name}  (${opts.tenant})`);
  console.log(`  Email    : ${email}`);
  console.log(`  User id  : ${userId}`);
  console.log(`  Database : ${target.database} @ ${target.host}`);
  console.log(`  Sign in  : http://localhost:${port}/portal/login.html`);
  console.log('');
  // The password is NOT echoed. You supplied it; the script has no reason to
  // repeat it into a terminal, a screen share or a scrollback buffer.
  console.log('  The password you supplied was hashed and stored. It is not printed back.');
  if (action === 'updated') {
    console.log('  password_changed_at moved: any existing portal session for this user is now');
    console.log('  signed out (migration 027 session epoch).');
  }
  console.log('');
  console.log('⚠ LOCAL DEVELOPMENT ONLY. This account has a password a human chose and typed.');
  console.log('  Real owner accounts are created and reset from the admin panel, which generates');
  console.log('  the password server-side so no operator ever knows it.');
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    console.error(`✗ ${err.message}`);
    await db.close().catch(() => {});
    process.exit(1);
  });
