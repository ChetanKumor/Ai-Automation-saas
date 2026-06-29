'use strict';

const db = require('../../db/db');

/**
 * call_sessions persistence (raw SQL, tenant-scoped). One row per phone call;
 * the individual turns are stored in `messages` (channel='voice'). No business
 * logic lives here — just create/update/get for the voice lifecycle.
 */

/**
 * Create a call session (status defaults to 'initiated', started_at = now()).
 * @returns {Promise<Object>} the inserted row
 */
async function create({
  tenantId,
  customerId,
  conversationId = null,
  provider,
  externalCallId = null,
  direction,
  fromNumber = null,
  toNumber = null,
  languageDetected = null,
  status = 'initiated',
}) {
  const { rows: [row] } = await db.query(
    `INSERT INTO call_sessions
       (tenant_id, customer_id, conversation_id, provider, external_call_id, direction,
        from_number, to_number, language_detected, status, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     RETURNING *`,
    [tenantId, customerId, conversationId, provider, externalCallId, direction,
     fromNumber, toNumber, languageDetected, status]
  );
  return row;
}

/**
 * Update a call session. Only provided fields change (COALESCE). Tenant-scoped.
 * @returns {Promise<Object|null>} the updated row, or null if not found
 */
async function updateStatus(id, tenantId, {
  status = null,
  endedAt = null,
  durationSeconds = null,
  recordingUrl = null,
  languageDetected = null,
} = {}) {
  const { rows: [row] } = await db.query(
    `UPDATE call_sessions SET
       status            = COALESCE($3, status),
       ended_at          = COALESCE($4, ended_at),
       duration_seconds  = COALESCE($5, duration_seconds),
       recording_url     = COALESCE($6, recording_url),
       language_detected = COALESCE($7, language_detected)
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, tenantId, status, endedAt, durationSeconds, recordingUrl, languageDetected]
  );
  return row || null;
}

/**
 * Fetch a call session by id (tenant-scoped).
 * @returns {Promise<Object|null>}
 */
async function get(id, tenantId) {
  const { rows: [row] } = await db.query(
    'SELECT * FROM call_sessions WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  return row || null;
}

module.exports = { create, updateStatus, get };
