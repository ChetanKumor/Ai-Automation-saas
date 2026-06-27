const actions            = require('../../../core/actions');
const logger             = require('../../infra/logging/logger');
const db                 = require('../../db/db');
const collectionsService = require('./collectionsService');
const collectionsCron    = require('./collectionsCron');

function init() {
  actions.register('schedule_payment_reminder', async (params, ctx) => {
    if (!params.customer_id || !params.amount || !params.due_date || !params.reminder_send_at) {
      logger.warn('schedule_payment_reminder: missing required params');
      return { skipped: true };
    }
    if (Number(params.amount) <= 0) return { error: 'Amount must be positive' };

    const { rows } = await db.query(
      'SELECT id FROM customers WHERE id = $1 AND tenant_id = $2',
      [params.customer_id, ctx.tenant_id]
    );
    if (!rows.length) return { error: 'Customer not found for this tenant' };

    return collectionsService.schedulePayment(ctx.tenant_id, params.customer_id, params);
  });

  actions.register('mark_payment_received', async (params, ctx) => {
    if (!params.schedule_id) {
      logger.warn('mark_payment_received: missing schedule_id');
      return { skipped: true };
    }
    return collectionsService.markPaid(ctx.tenant_id, params.schedule_id, ctx);
  });

  const cronTask = collectionsCron.start();
  module.exports.cronTask = cronTask;

  logger.info('collections module initialized');
}

module.exports = { init };
