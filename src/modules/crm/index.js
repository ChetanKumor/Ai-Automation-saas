const actions           = require('../../../core/actions');
const db                = require('../../db/db');
const crmService        = require('./crmService');
const extractionHandler = require('./extractionHandler');

function init() {
  actions.register('create_lead', async (params, ctx) => {
    const { rows } = await db.query(
      'SELECT id FROM customers WHERE id = $1 AND tenant_id = $2',
      [params.customer_id, ctx.tenant_id]
    );
    if (!rows.length) return { error: 'Customer not found for this tenant' };

    const lead = await crmService.upsertLead(ctx.tenant_id, params.customer_id, params);
    return lead || { error: 'Lead not created (customer may already have a converted/lost lead)' };
  });

  actions.register('update_lead_stage', async (params, ctx) => {
    return crmService.updateStage(ctx.tenant_id, params.lead_id, params.stage);
  });

  extractionHandler.init();

  console.log('[CRM] Module initialized');
}

module.exports = { init };
