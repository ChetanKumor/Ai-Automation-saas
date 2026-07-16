'use strict';

const db                  = require('../../db/db');
const logger              = require('../../infra/logging/logger');
const identityService     = require('../identity/identityService');
const customerService     = require('../customer/customerService');
const conversationService = require('../conversation/conversationService');
const eventBus            = require('../../../core/events');
const EVENT               = require('../../../core/eventTypes');

/**
 * @typedef {Object} InboundEnvelope
 * @property {string} tenantId
 * @property {string} channel
 * @property {'inbound'} direction
 * @property {string} identifier
 * @property {string} externalId
 * @property {string} messageType
 * @property {string} [text]
 * @property {string} [mediaRef]
 * @property {Object} [profile]
 * @property {number} timestamp
 */

/**
 * @typedef {Object} ChannelAdapter
 * @property {string} channelType
 * @property {(req: Object) => boolean} verifyWebhook
 * @property {(value: Object, tenantId: string) => InboundEnvelope[]} parseInbound
 * @property {(args: {tenantId: string, customerId: string, payload: Object}) => Promise<{externalId: string}>} send
 */

const registry = new Map();

function register(adapter) {
  if (!adapter.channelType) throw new Error('Adapter must define channelType');
  registry.set(adapter.channelType, adapter);
}

function getAdapter(channelType) {
  const adapter = registry.get(channelType);
  if (!adapter) throw new Error(`Unknown channel: ${channelType}`);
  return adapter;
}

async function dispatchOutbound({ tenantId, customerId, channel, payload }) {
  const adapter = getAdapter(channel);
  return adapter.send({ tenantId, customerId, payload });
}

async function handleInbound(envelopes) {
  const results = [];

  for (const envelope of envelopes) {
    const timerLabel = `[Pipeline ${(envelope.externalId || '').slice(-6)}]`;
    console.time(`${timerLabel} total`);

    try {
      console.time(`${timerLabel} customer`);
      const customer = process.env.IDENTITY_RESOLUTION_ENABLED === 'true'
        ? await identityService.resolveCustomer({
            tenantId: envelope.tenantId,
            channelType: envelope.channel,
            identifier: envelope.identifier,
            profile: envelope.profile,
          })
        : await customerService.findOrCreate(envelope.tenantId, envelope.identifier);
      console.timeEnd(`${timerLabel} customer`);

      console.time(`${timerLabel} conversation`);
      const conversation = await conversationService.getOrCreateOpenConversation(
        envelope.tenantId, customer.id, envelope.channel
      );
      console.timeEnd(`${timerLabel} conversation`);

      // RETURNING id yields the inserted row's UUID on a real insert (V-009: the
      // turn path threads it to history exclusion); on an idempotency conflict the
      // clause returns no row and rowCount is 0, exactly as before.
      const { rowCount, rows: [inserted] } = await db.query(
        `INSERT INTO messages
           (tenant_id, conversation_id, customer_id, external_id,
            direction, sender, content, channel, msg_type, media_ref)
         VALUES ($1, $2, $3, $4, 'inbound', 'customer', $5, $6, $7, $8)
         ON CONFLICT (tenant_id, channel, external_id)
           WHERE external_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [envelope.tenantId, conversation.id, customer.id, envelope.externalId,
         envelope.text, envelope.channel, envelope.messageType, envelope.mediaRef || null]
      );

      if (rowCount === 0) {
        logger.info({ externalId: envelope.externalId }, 'duplicate message — skipping');
        continue;
      }

      eventBus.emit(EVENT.MESSAGE_RECEIVED, {
        tenant_id: envelope.tenantId,
        customer_id: customer.id,
        conversation_id: conversation.id,
        message_id: envelope.externalId,
        text: envelope.text,
        mode: conversation.mode,
        // Channel/type travel ON the event (V-002): subscribers must never infer
        // the channel — the extraction policy gate reads these two fields.
        channel: envelope.channel,
        msg_type: envelope.messageType,
      });

      results.push({ envelope, customer, conversation, timerLabel, messageId: inserted.id });
    } catch (err) {
      logger.error({ externalId: envelope.externalId, tenantId: envelope.tenantId, err: err.message }, 'envelope ingest failed — skipping');
    }
  }

  return results;
}

module.exports = { register, getAdapter, dispatchOutbound, handleInbound };
