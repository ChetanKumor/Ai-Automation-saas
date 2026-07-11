'use strict';

// Trace queries (Issue 22) — the thin read layer behind the admin JSON routes
// (Issue 27's viewer page will consume the same two functions). Read-only.

const db = require('../../db/db');

/**
 * List traces, newest first. Exactly the filters the route validated:
 * at least one of conversation_id / correlation_id / tenant_id.
 */
async function listTraces({ conversationId = null, correlationId = null, tenantId = null, limit = 50 }) {
  const where = [];
  const params = [];
  if (conversationId) { params.push(conversationId); where.push(`conversation_id = $${params.length}`); }
  if (correlationId)  { params.push(correlationId);  where.push(`correlation_id = $${params.length}`); }
  if (tenantId)       { params.push(tenantId);       where.push(`tenant_id = $${params.length}`); }
  if (!where.length) throw new Error('listTraces: at least one filter is required');

  params.push(limit);
  const { rows } = await db.query(
    `SELECT * FROM turn_traces
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, turn_id DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** One trace by primary key, or null. */
async function getTrace(turnId) {
  const { rows } = await db.query(
    `SELECT * FROM turn_traces WHERE turn_id = $1`, [turnId]
  );
  return rows[0] || null;
}

module.exports = { listTraces, getTrace };
