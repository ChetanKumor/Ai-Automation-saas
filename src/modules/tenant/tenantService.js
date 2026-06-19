const db = require('../../db/db');

// Simple in-memory cache — avoids DB hit on every message
const cache = new Map();

const getByPhoneNumberId = async (phoneNumberId) => {
  if (cache.has(phoneNumberId)) return cache.get(phoneNumberId);

  const { rows } = await db.query(
    `SELECT * FROM tenants WHERE phone_number_id = $1 AND active = true LIMIT 1`,
    [phoneNumberId]
  );

  if (!rows[0]) return null;

  // Cache for 5 minutes
  cache.set(phoneNumberId, rows[0]);
  setTimeout(() => cache.delete(phoneNumberId), 5 * 60 * 1000);

  return rows[0];
};

module.exports = { getByPhoneNumberId };