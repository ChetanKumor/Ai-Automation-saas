'use strict';

const db        = require('../../db/db');
const eventBus  = require('../../../core/events');
const EVENT     = require('../../../core/eventTypes');
const logger    = require('../../infra/logging/logger');

const CHANNEL_TYPES = Object.freeze(['whatsapp', 'voice', 'sms', 'email', 'instagram']);
const PHONE_CHANNELS = new Set(['whatsapp', 'voice', 'sms']);

function validateChannelType(channelType) {
  if (!CHANNEL_TYPES.includes(channelType)) {
    throw new Error(`Invalid channel type: ${channelType}`);
  }
}

async function resolveCustomer({ tenantId, channelType, identifier, profile }) {
  validateChannelType(channelType);

  // 1. Direct lookup via channel_identifiers
  const { rows: ciRows } = await db.query(
    `SELECT ci.customer_id, c.*
     FROM channel_identifiers ci
     JOIN customers c ON c.id = ci.customer_id AND c.tenant_id = $1
     WHERE ci.tenant_id = $1
       AND ci.channel_type = $2
       AND ci.identifier = $3`,
    [tenantId, channelType, identifier]
  );

  if (ciRows.length > 0) {
    await db.query(
      `UPDATE customers SET last_seen_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [ciRows[0].id, tenantId]
    );
    return ciRows[0];
  }

  // 2. Phone fallback — whatsapp/voice/sms share phone as join key
  if (PHONE_CHANNELS.has(channelType)) {
    const { rows: phoneRows } = await db.query(
      `SELECT * FROM customers
       WHERE tenant_id = $1 AND phone = $2
       ORDER BY id
       LIMIT 1`,
      [tenantId, identifier]
    );

    if (phoneRows.length > 1) {
      logger.warn(
        { tenantId, phone: identifier },
        'multiple customers found for phone — using oldest'
      );
    }

    if (phoneRows.length > 0) {
      const customer = phoneRows[0];

      await db.query(
        `INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, channel_type, identifier) DO NOTHING`,
        [tenantId, customer.id, channelType, identifier]
      );

      await db.query(
        `UPDATE customers SET last_seen_at = NOW() WHERE id = $1 AND tenant_id = $2`,
        [customer.id, tenantId]
      );

      eventBus.emit(EVENT.CUSTOMER_IDENTIFIED, {
        tenant_id: tenantId,
        customer_id: customer.id,
        channel_type: channelType,
        identifier,
      });

      return customer;
    }
  }

  // 3. New customer — concurrency-safe with channel_identifiers as arbiter
  if (!PHONE_CHANNELS.has(channelType)) {
    throw new Error(
      `Cannot create new customer via non-phone channel "${channelType}" — phone is required. ` +
      'Link identifier to an existing customer first.'
    );
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: [newCustomer] } = await client.query(
      `INSERT INTO customers (tenant_id, phone, name, last_seen_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, phone) DO UPDATE SET last_seen_at = NOW()
       RETURNING *`,
      [tenantId, identifier, profile?.name || null]
    );

    const { rowCount: ciInserted } = await client.query(
      `INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, channel_type, identifier) DO NOTHING`,
      [tenantId, newCustomer.id, channelType, identifier]
    );

    if (ciInserted === 0) {
      await client.query('ROLLBACK');

      const { rows: [winner] } = await db.query(
        `SELECT c.* FROM channel_identifiers ci
         JOIN customers c ON c.id = ci.customer_id AND c.tenant_id = $1
         WHERE ci.tenant_id = $1
           AND ci.channel_type = $2
           AND ci.identifier = $3`,
        [tenantId, channelType, identifier]
      );

      return winner;
    }

    await client.query('COMMIT');

    eventBus.emit(EVENT.CUSTOMER_CREATED, {
      tenant_id: tenantId,
      customer_id: newCustomer.id,
      channel_type: channelType,
      identifier,
    });

    return newCustomer;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getTimeline(customerId) {
  const { rows } = await db.query(
    `SELECT
       m.id,
       m.conversation_id,
       m.direction,
       m.sender,
       m.content,
       m.msg_type,
       m.created_at,
       c.status AS conversation_status,
       c.mode   AS conversation_mode
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.customer_id = $1
     ORDER BY m.created_at ASC`,
    [customerId]
  );
  return rows;
}

module.exports = { resolveCustomer, getTimeline, CHANNEL_TYPES };
