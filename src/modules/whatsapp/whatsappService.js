const axios = require('axios');

const BASE = 'https://graph.facebook.com/v19.0';

const sendMessage = async (tenant, toPhone, text) => {
  await axios.post(
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
      }
    }
  );
};

module.exports = { sendMessage };