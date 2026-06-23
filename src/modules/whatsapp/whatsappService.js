const axios = require('axios');

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
    console.log(`[WhatsApp] Sent to ${toPhone}, message_id: ${res.data?.messages?.[0]?.id || 'unknown'}`);
  } catch (err) {
    const detail = err.response?.data?.error || err.message;
    console.error(`[WhatsApp] Send failed to ${toPhone}:`, JSON.stringify(detail));
    throw err;
  }
};

module.exports = { sendMessage };