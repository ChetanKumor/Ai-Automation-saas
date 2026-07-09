const axios = require('axios');
const logger = require('../../../infra/logging/logger');

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

// Cheapest possible liveness probe: a GET on the phone-number node reading a
// single field. No message is sent — this only proves the phone_number_id
// resolves and the (decrypted) token is accepted by Meta. Used by the
// validation service's whatsapp.live check. Resolves to the verified_name on
// success; throws (the axios error, detail already shaped by the caller) on any
// non-2xx. `tenant` needs { phone_number_id, wa_token } (decrypted token).
const pingNumber = async (tenant) => {
  const res = await axios.get(`${BASE}/${tenant.phone_number_id}`, {
    params: { fields: 'verified_name,display_phone_number' },
    headers: { Authorization: `Bearer ${tenant.wa_token}` },
    timeout: 15_000,
  });
  return res.data?.verified_name || res.data?.display_phone_number || 'ok';
};

module.exports = { sendMessage, pingNumber };
