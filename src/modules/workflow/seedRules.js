require('dotenv').config();
const logger = require('../../infra/logging/logger');
const db = require('../../db/db');

const RULES = [
  {
    name: 'hot_lead_alert',
    trigger_event: 'lead_created',
    conditions: { intent_level: 'high' },
    action: 'notify_owner',
    action_params: { text: '\u{1F525} Hot lead: {name} — {requirement} (budget: {budget})' },
  },
  {
    name: 'overdue_escalation',
    trigger_event: 'payment_overdue',
    conditions: {},
    action: 'place_call',
    action_params: { customer_id: '{customer_id}', text: 'Payment overdue: {currency} {amount} (schedule {schedule_id})' },
  },
];

async function seed() {
  const { rows: tenants } = await db.query(
    'SELECT id, business_name FROM tenants WHERE active = true ORDER BY created_at'
  );

  if (!tenants.length) {
    logger.info('no active tenants found — nothing to seed');
    return;
  }

  let total = 0;
  for (const tenant of tenants) {
    for (const rule of RULES) {
      const { rowCount } = await db.query(
        `INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (tenant_id, name) DO NOTHING`,
        [tenant.id, rule.name, rule.trigger_event, JSON.stringify(rule.conditions),
         rule.action, JSON.stringify(rule.action_params)]
      );
      total += rowCount;
    }
    logger.info({ tenantId: tenant.id, businessName: tenant.business_name }, 'seed rules tenant processed');
  }
  logger.info({ total }, 'seed rules done');
}

seed()
  .then(() => process.exit(0))
  .catch(err => {
    logger.error({ err: err.message }, 'seed rules error');
    process.exit(1);
  });
