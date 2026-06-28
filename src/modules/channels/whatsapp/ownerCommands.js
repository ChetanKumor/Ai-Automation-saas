const db                  = require('../../../db/db');
const logger              = require('../../../infra/logging/logger');
const sender              = require('./sender');
const conversationService = require('../../conversation/conversationService');

const HELP_TEXT = `Zyon Admin Commands:
TAKEOVER <phone> — take over a conversation
STATUS — see active handoffs
MSG <text> — send message to active customer
DONE — return conversation to AI`;

const normalize = (phone) => phone?.replace(/\D/g, '') || '';

const handle = async (tenant, from, userText, wamid) => {
  const text = userText.trim();
  const upper = text.toUpperCase();

  try {
    if (upper.startsWith('TAKEOVER ')) {
      await handleTakeover(tenant, from, text);
    } else if (upper.startsWith('MSG ')) {
      await handleMsg(tenant, from, text);
    } else if (upper === 'DONE') {
      await handleDone(tenant, from);
    } else if (upper === 'STATUS') {
      await handleStatus(tenant, from);
    } else {
      const active = await getActiveHandoff(tenant.id);
      if (active) {
        await reply(tenant, from, `Unrecognized command while handling ${active}.\n\n${HELP_TEXT}`);
      } else {
        await reply(tenant, from, HELP_TEXT);
      }
    }
  } catch (err) {
    logger.error({ tenantId: tenant.id, err: err.message }, 'owner command error');
    try {
      await reply(tenant, from, '❌ Something went wrong. Please try again.');
    } catch (replyErr) {
      logger.error({ tenantId: tenant.id, err: replyErr.message }, 'failed to send error reply');
    }
  }
};

// ── TAKEOVER ──────────────────────────────────────────────────────

async function handleTakeover(tenant, ownerPhone, text) {
  const rawPhone = text.slice('TAKEOVER '.length).trim();
  const customerPhone = normalize(rawPhone);
  if (!customerPhone) {
    return reply(tenant, ownerPhone, '❌ Usage: TAKEOVER <phone number>');
  }

  // Auto-release previous handoff so it doesn't stay stuck in human mode
  const previousPhone = await getActiveHandoff(tenant.id);
  if (previousPhone && previousPhone !== customerPhone) {
    const { rows: [prevCust] } = await db.query(
      `SELECT id FROM customers WHERE tenant_id = $1 AND phone = $2`,
      [tenant.id, previousPhone]
    );
    if (prevCust) {
      const { rows: [prevConv] } = await db.query(
        `SELECT id FROM conversations WHERE tenant_id = $1 AND customer_id = $2 AND status = 'open'`,
        [tenant.id, prevCust.id]
      );
      if (prevConv) {
        await conversationService.setMode(tenant.id, prevConv.id, 'ai');
      }
      await closeHandoffSession(tenant.id, prevCust.id);
      logger.info({ tenantId: tenant.id, previousPhone }, 'auto-released previous handoff');
    }
  }

  const { rows: [customer] } = await db.query(
    `SELECT id, phone FROM customers WHERE tenant_id = $1 AND phone = $2`,
    [tenant.id, customerPhone]
  );
  if (!customer) {
    return reply(tenant, ownerPhone, `❌ No conversation found for ${rawPhone}`);
  }

  const { rows: [conv] } = await db.query(
    `SELECT id FROM conversations WHERE tenant_id = $1 AND customer_id = $2 AND status = 'open'`,
    [tenant.id, customer.id]
  );
  if (!conv) {
    return reply(tenant, ownerPhone, `❌ No open conversation for ${rawPhone}`);
  }

  await conversationService.setMode(tenant.id, conv.id, 'human');

  await db.query(
    `UPDATE tenants SET active_handoff_customer = $1 WHERE id = $2`,
    [customerPhone, tenant.id]
  );

  await db.query(
    `INSERT INTO handoff_sessions (tenant_id, customer_id, started_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, customer_id) WHERE ended_at IS NULL
     DO UPDATE SET started_by = EXCLUDED.started_by, started_at = NOW(), message_count = 0`,
    [tenant.id, customer.id, ownerPhone]
  );

  await reply(tenant, ownerPhone,
    `✅ You're now handling +${customerPhone}.\nTheir messages will forward to you.\nReply: MSG <text> to respond to them.\nType DONE when you want AI to resume.`
  );
  logger.info({ tenantId: tenant.id, customerPhone }, 'TAKEOVER: owner took over');
}

// ── MSG ───────────────────────────────────────────────────────────

async function handleMsg(tenant, ownerPhone, text) {
  const msgBody = text.slice('MSG '.length).trim();
  if (!msgBody) {
    return reply(tenant, ownerPhone, '❌ Usage: MSG <your message>');
  }

  const activePhone = await getActiveHandoff(tenant.id);
  if (!activePhone) {
    return reply(tenant, ownerPhone, '❌ No active handoff. Use TAKEOVER <phone> first.');
  }

  const { rows: [customer] } = await db.query(
    `SELECT id FROM customers WHERE tenant_id = $1 AND phone = $2`,
    [tenant.id, activePhone]
  );
  if (!customer) {
    return reply(tenant, ownerPhone, '❌ Active handoff customer not found. Use DONE and try again.');
  }

  const { rows: [conv] } = await db.query(
    `SELECT id FROM conversations WHERE tenant_id = $1 AND customer_id = $2 AND status = 'open'`,
    [tenant.id, customer.id]
  );
  if (!conv) {
    return reply(tenant, ownerPhone, '❌ No open conversation for that customer.');
  }

  const sentWamid = await sender.sendMessage(tenant, activePhone, msgBody);

  await db.query(
    `INSERT INTO messages
       (tenant_id, conversation_id, customer_id, wamid, external_id,
        direction, sender, content, channel)
     VALUES ($1, $2, $3, $4, $4, 'outbound', 'agent', $5, 'whatsapp')`,
    [tenant.id, conv.id, customer.id, sentWamid, msgBody]
  );

  await db.query(
    `UPDATE handoff_sessions SET message_count = message_count + 1
     WHERE tenant_id = $1 AND customer_id = $2 AND ended_at IS NULL`,
    [tenant.id, customer.id]
  );

  await reply(tenant, ownerPhone, '✅ Sent');
  logger.info({ tenantId: tenant.id, activePhone }, 'MSG sent to customer');
}

// ── DONE ──────────────────────────────────────────────────────────

async function handleDone(tenant, ownerPhone) {
  const activePhone = await getActiveHandoff(tenant.id);
  if (!activePhone) {
    return reply(tenant, ownerPhone, '❌ No active handoff to end.');
  }

  const { rows: [customer] } = await db.query(
    `SELECT id FROM customers WHERE tenant_id = $1 AND phone = $2`,
    [tenant.id, activePhone]
  );

  if (customer) {
    const { rows: [conv] } = await db.query(
      `SELECT id FROM conversations WHERE tenant_id = $1 AND customer_id = $2 AND status = 'open'`,
      [tenant.id, customer.id]
    );
    if (conv) {
      await conversationService.setMode(tenant.id, conv.id, 'ai');
    }
    await closeHandoffSession(tenant.id, customer.id);
  }

  await db.query(
    `UPDATE tenants SET active_handoff_customer = NULL WHERE id = $1`,
    [tenant.id]
  );

  await reply(tenant, ownerPhone, '✅ AI has resumed for that customer.');
  logger.info({ tenantId: tenant.id, activePhone }, 'DONE: AI resumed');
}

// ── STATUS ────────────────────────────────────────────────────────

async function handleStatus(tenant, ownerPhone) {
  const { rows } = await db.query(
    `SELECT c.phone, conv.updated_at
     FROM conversations conv
     JOIN customers c ON c.id = conv.customer_id
     WHERE conv.tenant_id = $1 AND conv.mode = 'human' AND conv.status = 'open'
     ORDER BY conv.updated_at DESC`,
    [tenant.id]
  );

  if (rows.length === 0) {
    return reply(tenant, ownerPhone, 'No active handoffs.');
  }

  const lines = rows.map(r => {
    const since = new Date(r.updated_at).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
    });
    return `• +${r.phone} (since ${since})`;
  });

  await reply(tenant, ownerPhone, `Active handoffs:\n${lines.join('\n')}`);
}

// ── HELPERS ───────────────────────────────────────────────────────

async function closeHandoffSession(tenantId, customerId) {
  await db.query(
    `UPDATE handoff_sessions SET ended_at = NOW()
     WHERE tenant_id = $1 AND customer_id = $2 AND ended_at IS NULL`,
    [tenantId, customerId]
  );
}

async function getActiveHandoff(tenantId) {
  const { rows: [t] } = await db.query(
    `SELECT active_handoff_customer FROM tenants WHERE id = $1`,
    [tenantId]
  );
  return t?.active_handoff_customer || null;
}

async function reply(tenant, to, text) {
  await sender.sendMessage(tenant, to, text);
}

module.exports = { handle };
