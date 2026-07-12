'use strict';

// V-009: getRecentMessages must exclude the CURRENT turn's inbound message by id,
// not by position (OFFSET 1). The positional exclusion assumes the newest row IS
// the current one — false on the shared cross-channel conversation, where a message
// on the other channel can land between the current insert and the history fetch.
//
// Runs against a REAL throwaway scratch database (same genesis pattern as the
// lifecycle/validation suites). Disjoint DB-name prefix (zyon_hx_) so no other
// suite's sweep drops it mid-run. Skips when DATABASE_URL is unset.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_hx_';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_hx\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

describe('getRecentMessages history exclusion (integration)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, customerService, tenantId, customerId, conversationId;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    process.env.DATABASE_URL = scratchCs;
    db = require('../../src/db/db');
    customerService = require('../../src/modules/customer/customerService');

    const { rows: [t] } = await db.query(
      `INSERT INTO tenants (business_name, slug, phone_number_id) VALUES ($1,$2,$3) RETURNING id`,
      ['Sunrise Dental', 'hx-' + crypto.randomBytes(3).toString('hex'), 'hx-' + crypto.randomBytes(4).toString('hex')]);
    tenantId = t.id;

    const { rows: [cust] } = await db.query(
      `INSERT INTO customers (tenant_id, phone) VALUES ($1,$2) RETURNING id`,
      [tenantId, '919999900000']);
    customerId = cust.id;

    const { rows: [conv] } = await db.query(
      `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1,$2) RETURNING id`,
      [tenantId, customerId]);
    conversationId = conv.id;
  });

  after(async () => {
    process.env.DATABASE_URL = ADMIN;
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  // Insert one message with an explicit created_at, returning its id.
  async function insertMsg({ direction, sender, content, channel, at }) {
    const { rows: [m] } = await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tenantId, conversationId, customerId, direction, sender, content, channel, at]);
    return m.id;
  }

  it('the race: a concurrent other-channel message stays in history; only the current id is excluded', async () => {
    // A fresh conversation frame for this case.
    const { rows: [conv] } = await db.query(
      `INSERT INTO conversations (tenant_id, customer_id, status) VALUES ($1,$2,'closed') RETURNING id`,
      [tenantId, customerId]);
    const convId = conv.id;

    const t0 = '2026-07-12T10:00:00+05:30';
    const t1 = '2026-07-12T10:01:00+05:30';
    const t2 = '2026-07-12T10:01:30+05:30'; // LATER than the current message

    // Prior turn's reply (older history).
    const priorId = (await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, created_at)
       VALUES ($1,$2,$3,'outbound','ai',$4,'voice',$5) RETURNING id`,
      [tenantId, convId, customerId, 'earlier reply', t0])).rows[0].id;

    // A = the CURRENT turn's inbound (voice), persisted first by the turn path.
    const currentId = (await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, created_at)
       VALUES ($1,$2,$3,'inbound','customer',$4,'voice',$5) RETURNING id`,
      [tenantId, convId, customerId, 'current question', t1])).rows[0].id;

    // B = a CONCURRENT WhatsApp message that lands while the voice turn hydrates —
    // newer than A, so it is the newest row in the conversation.
    const concurrentId = (await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, created_at)
       VALUES ($1,$2,$3,'inbound','customer',$4,'whatsapp',$5) RETURNING id`,
      [tenantId, convId, customerId, 'concurrent message', t2])).rows[0].id;

    // RED — the OLD positional query (ORDER BY created_at DESC, OFFSET 1) drops the
    // WRONG row: it skips B (the newest, concurrent) and KEEPS A (the current one,
    // which then duplicates into context). This is the race, reproduced.
    const old = (await db.query(
      `SELECT content FROM messages WHERE tenant_id=$1 AND conversation_id=$2
       ORDER BY created_at DESC OFFSET 1 LIMIT 10`,
      [tenantId, convId])).rows.reverse().map((r) => r.content);
    assert.deepEqual(old, ['earlier reply', 'current question'],
      'old OFFSET 1 drops the concurrent message and keeps the current one (the bug)');

    // GREEN — excluding by the known current id keeps B and drops exactly A.
    const history = await customerService.getRecentMessages(tenantId, convId, currentId);
    const contents = history.map((r) => r.content);
    assert.ok(contents.includes('concurrent message'), 'concurrent message must survive');
    assert.ok(!contents.includes('current question'), 'current message must be excluded');
    assert.deepEqual(contents, ['earlier reply', 'concurrent message']);

    // Sanity: ids used are distinct (guards a same-timestamp accident).
    assert.equal(new Set([priorId, currentId, concurrentId]).size, 3);
  });

  it('sequential (no race): history is byte-identical to the incumbent OFFSET-1 output', async () => {
    const base = Date.parse('2026-07-12T09:00:00+05:30');
    const seeded = [
      { direction: 'inbound',  sender: 'customer', content: 'hi',              channel: 'whatsapp' },
      { direction: 'outbound', sender: 'ai',       content: 'hello, how can I help?', channel: 'whatsapp' },
      { direction: 'inbound',  sender: 'customer', content: 'what are your hours?',    channel: 'whatsapp' },
      { direction: 'outbound', sender: 'ai',       content: '9 to 6',          channel: 'whatsapp' },
    ];
    for (let i = 0; i < seeded.length; i++) {
      await insertMsg({ ...seeded[i], at: new Date(base + i * 60000).toISOString() });
    }
    // The current inbound is the newest row — the non-race case OFFSET 1 was built for.
    const currentId = await insertMsg({
      direction: 'inbound', sender: 'customer', content: 'ok book me',
      channel: 'whatsapp', at: new Date(base + seeded.length * 60000).toISOString(),
    });

    // Baseline: what OFFSET 1 would have returned (newest == current, so it's correct here).
    const baseline = (await db.query(
      `SELECT sender, content FROM messages WHERE tenant_id=$1 AND conversation_id=$2
       ORDER BY created_at DESC OFFSET 1 LIMIT 10`,
      [tenantId, conversationId])).rows.reverse();

    const history = await customerService.getRecentMessages(tenantId, conversationId, currentId);
    assert.deepEqual(history, baseline, 'sequential behavior is byte-identical to the old query');
  });

  it('requires excludeMessageId — throws rather than silently regressing to the positional race', async () => {
    await assert.rejects(
      customerService.getRecentMessages(tenantId, conversationId),
      /excludeMessageId is required/,
    );
  });
});
