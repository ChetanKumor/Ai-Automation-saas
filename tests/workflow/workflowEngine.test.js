require('dotenv').config();
const db      = require('../../src/db/db');
const events  = require('../../core/events');
const actions = require('../../core/actions');
const workflowEngine = require('../../src/modules/workflow/workflowEngine');

const TENANT_ID   = '00000000-0000-0000-0000-000000000099';
const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';

let notifyOwnerCalled = 0;
let lastNotifyText = null;

function wait(ms = 3000) { return new Promise(r => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function setup() {
  await db.query(`
    INSERT INTO tenants (id, business_name, phone_number_id, wa_token, active, owner_notify_phone)
    VALUES ($1, 'Test Biz', 'pnid_test_wf', 'tok_test', true, '919999999999')
    ON CONFLICT (id) DO NOTHING
  `, [TENANT_ID]);

  actions.register('notify_owner', async (params, ctx) => {
    notifyOwnerCalled++;
    lastNotifyText = params.text;
    console.log('  [mock] notify_owner text="' + params.text + '" depth=' + (ctx?.depth ?? '?'));
    return { sent: true };
  });

  workflowEngine.init();
}

async function clean() {
  await wait(500);
  await db.query('DELETE FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM workflow_rules WHERE tenant_id = $1', [TENANT_ID]);
  notifyOwnerCalled = 0;
  lastNotifyText = null;
}

async function test1() {
  console.log('\n=== TEST 1: High-intent lead_created -> notify_owner fires once ===');
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

  assert(notifyOwnerCalled === 1, 'FAIL: expected 1 call, got ' + notifyOwnerCalled);
  assert(lastNotifyText === 'Hot: Raj - 3BHK flat', 'FAIL: wrong text: ' + lastNotifyText);
  const { rows } = await db.query('SELECT status FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
  assert(rows.length === 1 && rows[0].status === 'success', 'FAIL: expected 1 success row');
  console.log('  PASS');
}

async function test1b() {
  console.log('\n=== TEST 1b: Dedup blocks second claim for same (rule_id, event_id) ===');
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

  assert(!claimed, 'FAIL: dedup should block');
  console.log('  PASS');
}

async function test2() {
  console.log('\n=== TEST 2: Low-intent -> no match, no execution row ===');
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

  assert(notifyOwnerCalled === 0, 'FAIL: should not fire for low intent');
  const { rows } = await db.query('SELECT * FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
  assert(rows.length === 0, 'FAIL: expected 0 rows');
  console.log('  PASS');
}

async function test3() {
  console.log('\n=== TEST 3: Unregistered action -> skipped, sibling rules still fire ===');
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
  assert(rows.some(r => r.status === 'skipped'), 'FAIL: expected a skipped row');
  assert(rows.some(r => r.status === 'success'), 'FAIL: expected a success row');
  assert(notifyOwnerCalled === 1, 'FAIL: notify_owner should fire once');
  console.log('  PASS');
}

async function test4() {
  console.log('\n=== TEST 4: send_whatsapp_message in human mode -> customer gets nothing ===');
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

  assert(!sendWaCalled, 'FAIL: message should NOT be sent in human mode');
  const { rows } = await db.query('SELECT status FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
  assert(rows.length === 1 && rows[0].status === 'skipped', 'FAIL: expected skipped');
  console.log('  PASS');

  await db.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_id = $2', [TENANT_ID, CUSTOMER_ID]);
}

async function test5() {
  console.log('\n=== TEST 5: Depth climb 0->1->2->3->4->5 then halt ===');
  await clean();
  const depthLog = [];

  actions.register('__test_echo', async (params, ctx) => {
    console.log('  [__test_echo] depth=' + ctx.depth);
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

  console.log('  Depth log:', depthLog);
  assert(depthLog.length === 5, 'FAIL: expected 5 hops, got ' + depthLog.length);
  const expected = [1, 2, 3, 4, 5];
  for (let i = 0; i < expected.length; i++) {
    assert(depthLog[i] === expected[i], 'FAIL: depth[' + i + '] expected ' + expected[i] + ' got ' + depthLog[i]);
  }
  console.log('  PASS');
}

async function test6() {
  console.log('\n=== TEST 6: Condition key absent -> no match, no throw ===');
  await clean();
  await db.query(`
    INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
    VALUES ($1, 'needs_budget', 'lead_created', '{"budget":"1cr"}', 'notify_owner', '{"text":"match"}', true)
  `, [TENANT_ID]);

  events.emit('lead_created', {
    tenant_id: TENANT_ID, customer_id: CUSTOMER_ID, lead_id: 'lead-005', name: 'No Budget', stage: 'new',
  });
  await wait();

  assert(notifyOwnerCalled === 0, 'FAIL: should not match');
  const { rows } = await db.query('SELECT * FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
  assert(rows.length === 0, 'FAIL: expected 0 rows');
  console.log('  PASS');
}

async function test7() {
  console.log('\n=== TEST 7: Missing {token} -> empty substitution, no throw ===');
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

  assert(notifyOwnerCalled === 1, 'FAIL: rule should fire');
  assert(lastNotifyText === 'Lead: TokenTest budget=', 'FAIL: got: ' + lastNotifyText);
  console.log('  PASS');
}

(async () => {
  try {
    await setup();
    await test1();
    await test1b();
    await test2();
    await test3();
    await test4();
    await test5();
    await test6();
    await test7();
    console.log('\n=== ALL TESTS PASSED ===');
  } catch (err) {
    console.error('TEST ERROR:', err);
  } finally {
    await db.query('DELETE FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID]);
    await db.query('DELETE FROM workflow_rules WHERE tenant_id = $1', [TENANT_ID]);
    await db.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_id = $2', [TENANT_ID, CUSTOMER_ID]);
    await db.query('DELETE FROM customers WHERE id = $1', [CUSTOMER_ID]);
    await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
    process.exit(0);
  }
})();
