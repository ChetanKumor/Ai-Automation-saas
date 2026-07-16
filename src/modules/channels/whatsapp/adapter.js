'use strict';

const crypto        = require('crypto');
const logger        = require('../../../infra/logging/logger');
const db            = require('../../../db/db');
const tenantService = require('../../tenant/tenantService');
const sender        = require('./sender');

function extractMessageContent(msg) {
  switch (msg.type) {
    case 'text':
      if (!msg.text?.body) return null;
      return { content: msg.text.body, mediaRef: null, msgType: 'text' };
    case 'image':
      return { content: msg.image?.caption || '[image]', mediaRef: msg.image?.id || null, msgType: 'image' };
    case 'audio':
      return { content: '[audio]', mediaRef: msg.audio?.id || null, msgType: 'audio' };
    case 'video':
      return { content: msg.video?.caption || '[video]', mediaRef: msg.video?.id || null, msgType: 'video' };
    case 'document':
      return { content: msg.document?.caption || msg.document?.filename || '[document]', mediaRef: msg.document?.id || null, msgType: 'document' };
    case 'location':
      return { content: `[location: ${msg.location?.latitude},${msg.location?.longitude}]`, mediaRef: null, msgType: 'location' };
    case 'sticker':
      return { content: '[sticker]', mediaRef: msg.sticker?.id || null, msgType: 'sticker' };
    default:
      return { content: `[${msg.type}]`, mediaRef: null, msgType: msg.type || 'unknown' };
  }
}

function verifyWebhook(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;

  const expected = 'sha256=' +
    crypto.createHmac('sha256', process.env.META_APP_SECRET)
      .update(req.body)
      .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);

  return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
}

function parseInbound(waValue, tenantId) {
  const messages = waValue.messages;
  if (!messages || !messages.length) return [];

  const contacts = waValue.contacts || [];

  return messages.map(msg => {
    const extracted = extractMessageContent(msg);
    if (!extracted) return null;

    const contact      = contacts.find(c => c.wa_id === msg.from);
    const profileName  = contact?.profile?.name || null;

    return {
      tenantId,
      channel: 'whatsapp',
      direction: 'inbound',
      identifier: msg.from,
      externalId: msg.id,
      messageType: extracted.msgType,
      text: extracted.content,
      mediaRef: extracted.mediaRef,
      profile: profileName ? { name: profileName } : undefined,
      timestamp: Date.now(),
    };
  }).filter(Boolean);
}

async function send({ tenantId, customerId, payload }) {
  const { rows: [t] } = await db.query(
    'SELECT phone_number_id FROM tenants WHERE id = $1 AND active = true',
    [tenantId]
  );
  if (!t) throw new Error('Tenant not found or inactive');

  const tenant = await tenantService.getByPhoneNumberId(t.phone_number_id);
  if (!tenant) throw new Error('Tenant credentials not found');

  const { rows: [customer] } = await db.query(
    'SELECT phone FROM customers WHERE id = $1 AND tenant_id = $2',
    [customerId, tenantId]
  );
  if (!customer) throw new Error('Customer not found');

  const externalId = await sender.sendMessage(tenant, customer.phone, payload.text);
  return { externalId };
}

module.exports = {
  channelType: 'whatsapp',
  verifyWebhook,
  parseInbound,
  send,
  extractMessageContent,
};
