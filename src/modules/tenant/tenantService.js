const db = require('../../db/db');
const { decrypt } = require('../../utils/encryption');

// Simple in-memory cache — avoids DB hit on every message
const cache = new Map();

const getByPhoneNumberId = async (phoneNumberId) => {
  if (cache.has(phoneNumberId)) return cache.get(phoneNumberId);

  const { rows } = await db.query(
    `SELECT id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled
     FROM tenants WHERE phone_number_id = $1 AND active = true LIMIT 1`,
    [phoneNumberId]
  );

  if (!rows[0]) return null;

  rows[0].wa_token = decrypt(rows[0].wa_token);

  // Cache for 5 minutes (caches decrypted token — avoids repeated decryption)
  cache.set(phoneNumberId, rows[0]);
  setTimeout(() => cache.delete(phoneNumberId), 5 * 60 * 1000);

  return rows[0];
};

module.exports = { getByPhoneNumberId };