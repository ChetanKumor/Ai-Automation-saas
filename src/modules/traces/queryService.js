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

/**
 * One trace by primary key WITHIN a tenant, or null.
 *
 * tenantId is required and is never defaulted. This read sat INSIDE a service and
 * was unscoped for as long as it existed: routing a read through the service
 * layer conferred no tenant scoping, so a turn_id alone fetched any tenant's
 * trace. A trace on another tenant is indistinguishable here from one that does
 * not exist — both are null. (ADMIN-S3a; supersedes F-A011's "raw SQL in a
 * handler is where a missing predicate hides".)
 */
async function getTrace(tenantId, turnId) {
  const { rows } = await db.query(
    `SELECT * FROM turn_traces WHERE turn_id = $1 AND tenant_id = $2`, [turnId, tenantId]
  );
  return rows[0] || null;
}

module.exports = { listTraces, getTrace };
