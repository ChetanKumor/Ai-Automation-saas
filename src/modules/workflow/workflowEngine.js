const events  = require('../../../core/events');
const actions = require('../../../core/actions');
const logger  = require('../../infra/logging/logger');
const db      = require('../../db/db');

const MAX_WORKFLOW_DEPTH = 5;

function matchesConditions(conditions, payload) {
  if (!conditions || typeof conditions !== 'object') return true;
  const keys = Object.keys(conditions);
  if (keys.length === 0) return true;
  for (const k of keys) {
    if (!(k in payload)) return false;
    if (String(payload[k]) !== String(conditions[k])) return false;
  }
  return true;
}

function interpolate(actionParams, payload) {
  const result = {};
  for (const [k, v] of Object.entries(actionParams)) {
    if (typeof v === 'string') {
      result[k] = v.replace(/\{(\w+)\}/g, (_, token) => {
        if (token in payload) return String(payload[token]);
        logger.warn({ token }, 'workflow missing interpolation token — replaced with empty string');
        return '';
      });
    } else {
      result[k] = v;
    }
  }
  return result;
}

async function onEvent(event) {
  if (!event.tenant_id) {
    logger.debug({ eventType: event.type }, 'workflow event without tenant_id — skipping');
    return;
  }

  if (event.depth >= MAX_WORKFLOW_DEPTH) {
    logger.info({ maxDepth: MAX_WORKFLOW_DEPTH, eventType: event.type }, 'workflow depth limit reached — halting');
    return;
  }

  const { rows: rules } = await db.query(
    `SELECT * FROM workflow_rules
     WHERE tenant_id = $1 AND trigger_event = $2 AND enabled = true`,
    [event.tenant_id, event.type]
  );

  if (!rules.length) return;

  for (const rule of rules) {
    let claimedId = null;
    try {
      if (!matchesConditions(rule.conditions, event.payload)) continue;

      const { rows: [claimed] } = await db.query(
        `INSERT INTO workflow_executions (tenant_id, rule_id, event_id, event_type, status)
         VALUES ($1, $2, $3, $4, 'running')
         ON CONFLICT (rule_id, event_id) DO NOTHING
         RETURNING id`,
        [event.tenant_id, rule.id, event.event_id, event.type]
      );

      if (!claimed) continue;
      claimedId = claimed.id;

      const params = interpolate(rule.action_params, event.payload);

      const ctx = {
        tenant_id: event.tenant_id,
        depth: event.depth + 1,
        causation_id: event.event_id,
      };

      const result = await actions.execute(rule.action, params, ctx);

      let status = 'success';
      let error  = null;
      if (result?.skipped) {
        status = 'skipped';
      } else if (result?.error) {
        status = 'failed';
        error  = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      }

      await db.query(
        `UPDATE workflow_executions SET status = $1, error = $2 WHERE id = $3`,
        [status, error, claimedId]
      );

      logger.info({ rule: rule.name, action: rule.action, status, depth: ctx.depth, eventType: event.type }, 'workflow rule executed');
    } catch (err) {
      logger.error({ rule: rule.name, ruleId: rule.id, err: err.message }, 'workflow rule failed');
      if (claimedId) {
        await db.query(
          `UPDATE workflow_executions SET status = 'failed', error = $1 WHERE id = $2`,
          [err.message, claimedId]
        ).catch(updateErr => logger.error({ err: updateErr.message }, 'workflow failed to mark execution failed'));
      }
    }
  }
}

// Scalability notes (known boundaries — do not build now):
// - Rule lookup is a per-event DB read. At scale, cache rules per tenant
//   with TTL invalidation (mirror the existing tenant cache pattern).
//   The partial index on (tenant_id, trigger_event) WHERE enabled = true
//   already covers current volume.
// - Sequential per-rule dispatch is intentional for predictability.
//   Parallelize with Promise.allSettled only if one event ever matches
//   many rules.
// - In-memory bus is single-process. Multi-instance requires a durable
//   outbox + worker and a reaper for stuck 'running' rows. Out of scope
//   by design.

let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;
  events.on('*', onEvent);
  logger.info('workflow engine initialized');
}

module.exports = { init };
