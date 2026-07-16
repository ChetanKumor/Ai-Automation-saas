'use strict';

// Workflow engine integration tests — exercises rule matching, dedup, depth guard,
// and action dispatch against the real DB using isolated fixed-UUID test fixtures.
// Scoped to TENANT_ID/CUSTOMER_ID constants; cleans up in after().
// Skips when DATABASE_URL is unset (same pattern as other integration suites).

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db      = require('../../src/db/db');
const events  = require('../../core/events');
const actions = require('../../core/actions');
const workflowEngine = require('../../src/modules/workflow/workflowEngine');

const TENANT_ID   = '00000000-0000-0000-0000-000000000099';
const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';

function wait(ms = 3000) { return new Promise(r => setTimeout(r, ms)); }

describe('workflowEngine (integration)', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL not set' }, () => {
  let notifyOwnerCalled = 0;
  let lastNotifyText = null;

  async function clean() {
    await wait(500);
    await db.query('DELETE FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
    await db.query('DELETE FROM workflow_rules WHERE tenant_id = $1', [TENANT_ID]);
    notifyOwnerCalled = 0;
    lastNotifyText = null;
  }

  before(async () => {
    await db.query(`
      INSERT INTO tenants (id, business_name, phone_number_id, wa_token, active, owner_notify_phone)
      VALUES ($1, 'Test Biz', 'pnid_test_wf', 'tok_test', true, '919999999999')
      ON CONFLICT (id) DO NOTHING
    `, [TENANT_ID]);

    actions.register('notify_owner', async (params) => {
      notifyOwnerCalled++;
      lastNotifyText = params.text;
      return { sent: true };
    });

    workflowEngine.init();
  });

  after(async () => {
    await db.query('DELETE FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
    await db.query('DELETE FROM workflow_rules WHERE tenant_id = $1', [TENANT_ID]);
    await db.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_id = $2', [TENANT_ID, CUSTOMER_ID]);
    await db.query('DELETE FROM customers WHERE id = $1', [CUSTOMER_ID]);
    await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
  });

  it('high-intent lead_created -> notify_owner fires once', async () => {
    await clean();
    await db.query(`
      INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
      VALUES ($1, 'hot_lead_notify', 'lead_created', '{"intent_level":"high"}', 'notify_owner',
              '{"text":"Hot: {name} - {requirement}"}', true)
    `, [TENANT_ID]);

    events.emit('lead_created', {
      tenant_id: TENANT_ID, customer_id: CUSTOMER_ID, lead_id: 'lead-001',
      name: 'Raj', requirement: '3BHK flat', intent_level: 'high', stage: 'new',
    });
    await wait();

    assert.equal(notifyOwnerCalled, 1, 'expected 1 call');
    assert.equal(lastNotifyText, 'Hot: Raj - 3BHK flat');
    const { rows } = await db.query('SELECT status FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'success');
  });

  it('dedup blocks second claim for same (rule_id, event_id)', async () => {
    // Piggybacks on the hot_lead_notify rule left by the previous test.
    const { rows: [rule] } = await db.query(
      'SELECT id FROM workflow_rules WHERE tenant_id = $1 AND name = $2', [TENANT_ID, 'hot_lead_notify']
    );
    const fakeEventId = 'dedup-' + Date.now();
    await db.query(`
      INSERT INTO workflow_executions (tenant_id, rule_id, event_id, event_type, status)
      VALUES ($1, $2, $3, 'lead_created', 'success')
    `, [TENANT_ID, rule.id, fakeEventId]);

    const { rows: [claimed] } = await db.query(`
      INSERT INTO workflow_executions (tenant_id, rule_id, event_id, event_type, status)
      VALUES ($1, $2, $3, 'lead_created', 'running')
      ON CONFLICT (rule_id, event_id) DO NOTHING RETURNING id
    `, [TENANT_ID, rule.id, fakeEventId]);

    assert.equal(claimed, undefined, 'dedup should block second insert');
  });

  it('low-intent -> no match, no execution row', async () => {
    await clean();
    await db.query(`
      INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
      VALUES ($1, 'hot_lead_notify', 'lead_created', '{"intent_level":"high"}', 'notify_owner',
              '{"text":"Hot: {name}"}', true)
    `, [TENANT_ID]);

    events.emit('lead_created', {
      tenant_id: TENANT_ID, customer_id: CUSTOMER_ID, lead_id: 'lead-002',
      name: 'Priya', intent_level: 'low', stage: 'new',
    });
    await wait();

    assert.equal(notifyOwnerCalled, 0, 'should not fire for low intent');
    const { rows } = await db.query('SELECT * FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
    assert.equal(rows.length, 0, 'expected 0 execution rows');
  });

  it('unregistered action -> skipped, sibling rules still fire', async () => {
    await clean();
    await db.query(`
      INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
      VALUES ($1, 'ghost_call', 'lead_created', '{}', 'place_call', '{"phone":"{phone}"}', true)
    `, [TENANT_ID]);
    await db.query(`
      INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
      VALUES ($1, 'always_notify', 'lead_created', '{}', 'notify_owner', '{"text":"New lead: {name}"}', true)
    `, [TENANT_ID]);

    events.emit('lead_created', {
      tenant_id: TENANT_ID, customer_id: CUSTOMER_ID, lead_id: 'lead-003',
      name: 'Amit', stage: 'new',
    });
    await wait();

    const { rows } = await db.query(
      'SELECT status FROM workflow_executions WHERE tenant_id = $1 ORDER BY created_at', [TENANT_ID]
    );
    assert.ok(rows.some(r => r.status === 'skipped'), 'expected a skipped row for place_call');
    assert.ok(rows.some(r => r.status === 'success'), 'expected a success row for notify_owner');
    assert.equal(notifyOwnerCalled, 1, 'notify_owner should fire once');
  });

  it('send_whatsapp_message in human mode -> skipped', async () => {
    await clean();
    await db.query(`
      INSERT INTO customers (id, tenant_id, phone)
      VALUES ($1, $2, '919876543210')
      ON CONFLICT (id) DO NOTHING
    `, [CUSTOMER_ID, TENANT_ID]);
    await db.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_id = $2', [TENANT_ID, CUSTOMER_ID]);
    await db.query(`
      INSERT INTO conversations (tenant_id, customer_id, status, mode)
      VALUES ($1, $2, 'open', 'human')
    `, [TENANT_ID, CUSTOMER_ID]);

    let sendWaCalled = false;
    actions.register('send_whatsapp_message', async (params, ctx) => {
      const tenantId = params.tenant_id || ctx.tenant_id;
      const { rows: [conv] } = await db.query(
        "SELECT mode FROM conversations WHERE customer_id = $1 AND tenant_id = $2 AND status = 'open'",
        [params.customer_id, tenantId]
      );
      if (!conv || conv.mode === 'human') return { skipped: true, reason: 'human_mode' };
      sendWaCalled = true;
      return { sent: true };
    });

    await db.query(`
      INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
      VALUES ($1, 'auto_reply', 'lead_created', '{}', 'send_whatsapp_message',
              '{"customer_id":"{customer_id}","text":"Welcome!"}', true)
    `, [TENANT_ID]);

    events.emit('lead_created', {
      tenant_id: TENANT_ID, customer_id: CUSTOMER_ID, lead_id: 'lead-004', name: 'Test', stage: 'new',
    });
    await wait();

    assert.equal(sendWaCalled, false, 'message should NOT be sent in human mode');
    const { rows } = await db.query('SELECT status FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'skipped');

    await db.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_id = $2', [TENANT_ID, CUSTOMER_ID]);
  });

  it('depth climb 0->1->2->3->4->5 then halt', { timeout: 15000 }, async () => {
    await clean();
    const depthLog = [];

    actions.register('__test_echo', async (params, ctx) => {
      depthLog.push(ctx.depth);
      events.emit('__test_event', { tenant_id: ctx.tenant_id, ping: 'pong' }, {
        depth: ctx.depth,
        causation_id: ctx.causation_id,
      });
      return { echoed: true };
    });

    await db.query(`
      INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
      VALUES ($1, 'echo_cycle', '__test_event', '{}', '__test_echo', '{}', true)
    `, [TENANT_ID]);

    events.emit('__test_event', { tenant_id: TENANT_ID, ping: 'start' });
    await wait(10000);

    assert.deepStrictEqual(depthLog, [1, 2, 3, 4, 5]);
  });

  it('condition key absent -> no match, no throw', async () => {
    await clean();
    await db.query(`
      INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
      VALUES ($1, 'needs_budget', 'lead_created', '{"budget":"1cr"}', 'notify_owner', '{"text":"match"}', true)
    `, [TENANT_ID]);

    events.emit('lead_created', {
      tenant_id: TENANT_ID, customer_id: CUSTOMER_ID, lead_id: 'lead-005', name: 'No Budget', stage: 'new',
    });
    await wait();

    assert.equal(notifyOwnerCalled, 0, 'should not match when condition key is absent');
    const { rows } = await db.query('SELECT * FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
    assert.equal(rows.length, 0, 'expected 0 execution rows');
  });

  it('missing {token} -> empty substitution, no throw', async () => {
    await clean();
    await db.query(`
      INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
      VALUES ($1, 'missing_token', 'lead_created', '{}', 'notify_owner',
              '{"text":"Lead: {name} budget={nonexistent_field}"}', true)
    `, [TENANT_ID]);

    events.emit('lead_created', {
      tenant_id: TENANT_ID, customer_id: CUSTOMER_ID, lead_id: 'lead-006', name: 'TokenTest', stage: 'new',
    });
    await wait();

    assert.equal(notifyOwnerCalled, 1, 'rule should fire');
    assert.equal(lastNotifyText, 'Lead: TokenTest budget=');
  });
});
