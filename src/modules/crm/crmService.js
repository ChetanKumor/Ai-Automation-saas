const db = require('../../db/db');

const VALID_TRANSITIONS = {
  new:       ['contacted', 'converted', 'lost'],
  contacted: ['converted', 'lost'],
  converted: [],
  lost:      [],
};

async function upsertLead(tenantId, customerId, data) {
  const { conversation_id, name, phone, requirement, budget, intent_level, source } = data;

  const { rows } = await db.query(
    `INSERT INTO leads (tenant_id, customer_id, conversation_id, name, phone, requirement, budget, intent_level, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, customer_id) WHERE stage NOT IN ('converted', 'lost')
     DO UPDATE SET
       name          = COALESCE(EXCLUDED.name, leads.name),
       phone         = COALESCE(EXCLUDED.phone, leads.phone),
       requirement   = COALESCE(EXCLUDED.requirement, leads.requirement),
       budget        = COALESCE(EXCLUDED.budget, leads.budget),
       intent_level  = COALESCE(EXCLUDED.intent_level, leads.intent_level),
       conversation_id = COALESCE(EXCLUDED.conversation_id, leads.conversation_id)
     RETURNING *, (xmax = 0) AS is_new`,
    [tenantId, customerId, conversation_id || null, name || null, phone || null,
     requirement || null, budget || null, intent_level || 'low', source || 'whatsapp']
  );

  return rows[0] || null;
}

const ALL_STAGES = ['new', 'contacted', 'converted', 'lost'];

async function updateStage(tenantId, leadId, newStage) {
  if (!ALL_STAGES.includes(newStage)) {
    return { error: 'Invalid stage' };
  }

  const allowedFrom = Object.entries(VALID_TRANSITIONS)
    .filter(([, targets]) => targets.includes(newStage))
    .map(([from]) => from);

  if (!allowedFrom.length) {
    return { error: `No valid transitions to '${newStage}'` };
  }

  const { rows: [updated] } = await db.query(
    `UPDATE leads SET stage = $1
     WHERE id = $2 AND tenant_id = $3 AND stage = ANY($4::text[])
     RETURNING *`,
    [newStage, leadId, tenantId, allowedFrom]
  );

  if (!updated) {
    return { error: `Lead not found or cannot transition to '${newStage}'` };
  }
  return { lead: updated };
}

module.exports = { upsertLead, updateStage };
