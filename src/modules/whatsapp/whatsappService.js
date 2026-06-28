const axios = require('axios');
const logger = require('../../infra/logging/logger');

const BASE = 'https://graph.facebook.com/v22.0';

const sendMessage = async (tenant, toPhone, text) => {
  if (!text) throw new Error('Cannot send empty message');
  try {
    const res = await axios.post(
      `${BASE}/${tenant.phone_number_id}/messages`,
      {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${tenant.wa_token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30_000,
      }
    );
    const messageId = res.data?.messages?.[0]?.id || null;
    logger.info({ toPhone, messageId: messageId || 'unknown' }, 'WhatsApp message sent');
    return messageId;
  } catch (err) {
    const detail = err.response?.data?.error || err.message;
    logger.error({ toPhone, detail }, 'WhatsApp send failed');
    throw err;
  }
};

module.exports = { sendMessage };