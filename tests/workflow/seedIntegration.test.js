require('dotenv').config();
const db      = require('../../src/db/db');
const events  = require('../../core/events');
const actions = require('../../core/actions');
const workflowEngine = require('../../src/modules/workflow/workflowEngine');

function wait(ms = 3000) { return new Promise(r => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

let notifyOwnerCalled = 0;
let lastNotifyText = null;

(async () => {
  try {
    const { rows: [tenant] } = await db.query(
      'SELECT id, business_name FROM tenants WHERE active = true ORDER BY created_at LIMIT 1'
    );
    if (!tenant) throw new Error('No active tenant');
    console.log(`Using tenant: ${tenant.business_name} (${tenant.id})`);

    actions.register('notify_owner', async (params, ctx) => {
      notifyOwnerCalled++;
      lastNotifyText = params.text;
      console.log(`  [mock] notify_owner text="${params.text}" depth=${ctx?.depth}`);
      return { sent: true };
    });

    workflowEngine.init();

    // Clean previous test executions for this tenant
    await db.query('DELETE FROM workflow_executions WHERE tenant_id = $1', [tenant.id]);

    // === TEST A: High-intent lead_created → hot_lead_alert fires ===
    console.log('\n=== TEST A: High-intent lead → hot_lead_alert → notify_owner ===');
    events.emit('lead_created', {
      tenant_id: tenant.id,
      customer_id: '00000000-0000-0000-0000-000000000001',
      lead_id: '00000000-0000-0000-0000-000000000002',
      name: 'Priya Sharma',
      requirement: '3BHK in Andheri',
      budget: '1.5cr',
      intent_level: 'high',
      stage: 'new',
    });
    await wait();

    assert(notifyOwnerCalled === 1, 'expected notify_owner called 1 time, got ' + notifyOwnerCalled);
    assert(lastNotifyText.includes('Priya Sharma'), 'text should contain name');
    assert(lastNotifyText.includes('3BHK in Andheri'), 'text should contain requirement');
    assert(lastNotifyText.includes('1.5cr'), 'text should contain budget');

    const { rows: execs1 } = await db.query(
      "SELECT status FROM workflow_executions WHERE tenant_id = $1 AND event_type = 'lead_created'",
      [tenant.id]
    );
    assert(execs1.length === 1, 'expected 1 execution row, got ' + execs1.length);
    assert(execs1[0].status === 'success', 'expected success, got ' + execs1[0].status);
    console.log('  PASS — notify_owner fired, execution row success');

    // === TEST B: payment_overdue → overdue_escalation → place_call (skipped) ===
    console.log('\n=== TEST B: payment_overdue → overdue_escalation → place_call (skipped) ===');
    events.emit('payment_overdue', {
      tenant_id: tenant.id,
      customer_id: '00000000-0000-0000-0000-000000000001',
      schedule_id: '00000000-0000-0000-0000-000000000003',
      amount: '50000',
      currency: 'INR',
    });
    await wait();

    const { rows: execs2 } = await db.query(
      "SELECT status FROM workflow_executions WHERE tenant_id = $1 AND event_type = 'payment_overdue'",
      [tenant.id]
    );
    assert(execs2.length === 1, 'expected 1 execution row for overdue, got ' + execs2.length);
    assert(execs2[0].status === 'skipped', 'expected skipped for unregistered place_call, got ' + execs2[0].status);
    console.log('  PASS — place_call skipped (unregistered), no crash');

    // === TEST C: Verify admin API returns results ===
    console.log('\n=== TEST C: Admin API returns workflow executions ===');
    const { rows: allExecs } = await db.query(
      `SELECT we.status, wr.name AS rule_name, we.event_type
       FROM workflow_executions we
       JOIN workflow_rules wr ON wr.id = we.rule_id
       WHERE we.tenant_id = $1
       ORDER BY we.created_at DESC`,
      [tenant.id]
    );
    console.log('  Executions:', JSON.stringify(allExecs));
    assert(allExecs.length >= 2, 'expected at least 2 execution rows');
    assert(allExecs.some(e => e.rule_name === 'hot_lead_alert' && e.status === 'success'), 'missing hot_lead_alert success');
    assert(allExecs.some(e => e.rule_name === 'overdue_escalation' && e.status === 'skipped'), 'missing overdue_escalation skipped');
    console.log('  PASS — both executions visible');

    console.log('\n=== ALL SEED INTEGRATION TESTS PASSED ===');
  } catch (err) {
    console.error('TEST ERROR:', err);
    process.exit(1);
  } finally {
    await db.query(
      "DELETE FROM workflow_executions WHERE tenant_id = (SELECT id FROM tenants WHERE active = true ORDER BY created_at LIMIT 1)"
    );
    process.exit(0);
  }
})();
