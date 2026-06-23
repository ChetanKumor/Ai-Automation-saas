const actions          = require('./actions');
const db               = require('../src/db/db');
const whatsappService  = require('../src/modules/whatsapp/whatsappService');
const tenantService    = require('../src/modules/tenant/tenantService');

function init() {
  actions.register('notify_owner', async (params, ctx) => {
    const tenantId = params.tenant_id || ctx.tenant_id;
    if (!tenantId || !params.text) {
      console.warn('[CoreActions] notify_owner: missing tenant_id or text');
      return { skipped: true };
    }

    const { rows: [tenant] } = await db.query(
      `SELECT id, phone_number_id, owner_notify_phone FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (!tenant) return { error: 'Tenant not found' };
    if (!tenant.owner_notify_phone) {
      console.log(`[CoreActions] notify_owner: no owner_notify_phone for tenant ${tenantId}`);
      return { skipped: true, reason: 'no_owner_phone' };
    }

    const fullTenant = await tenantService.getByPhoneNumberId(tenant.phone_number_id);
    if (!fullTenant) return { error: 'Tenant credentials not found' };

    await whatsappService.sendMessage(fullTenant, tenant.owner_notify_phone, params.text);
    return { sent: true };
  });

  actions.register('send_whatsapp_message', async (params, ctx) => {
    const tenantId = params.tenant_id || ctx.tenant_id;
    if (!tenantId || !params.customer_id || !params.text) {
      console.warn('[CoreActions] send_whatsapp_message: missing tenant_id, customer_id, or text');
      return { skipped: true };
    }

    const { rows: [conv] } = await db.query(
      `SELECT mode FROM conversations
       WHERE customer_id = $1 AND tenant_id = $2 AND status = 'open'`,
      [params.customer_id, tenantId]
    );

    if (conv && conv.mode === 'human') {
      console.log(`[CoreActions] send_whatsapp_message: skipped — conversation is in human mode (tenant=${tenantId} customer=${params.customer_id})`);
      return { skipped: true, reason: 'human_mode' };
    }

    const { rows: [customer] } = await db.query(
      `SELECT phone FROM customers WHERE id = $1 AND tenant_id = $2`,
      [params.customer_id, tenantId]
    );
    if (!customer) return { error: 'Customer not found for this tenant' };

    const { rows: [tenant] } = await db.query(
      `SELECT phone_number_id FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (!tenant) return { error: 'Tenant not found' };

    const fullTenant = await tenantService.getByPhoneNumberId(tenant.phone_number_id);
    if (!fullTenant) return { error: 'Tenant credentials not found' };

    await whatsappService.sendMessage(fullTenant, customer.phone, params.text);
    return { sent: true };
  });

  console.log('[CoreActions] Registered: notify_owner, send_whatsapp_message');
}

module.exports = { init };
