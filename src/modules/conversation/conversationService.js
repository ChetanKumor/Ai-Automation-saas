const db = require('../../db/db');

// `channel` here is the channel that is OPENING the thread. It lands in
// conversations.origin_channel and is never updated afterwards, because the
// ON CONFLICT arbiter below is (tenant_id, customer_id) WHERE status='open'
// with channel absent from the key: a returning customer's open thread is
// reused whichever edge they arrive on, and DO UPDATE touches only updated_at.
// That is deliberate — one patient, one thread — and it is exactly why the
// column cannot answer "which channels is this thread on".
// For that, use getParticipatingChannels below.
const getOrCreateOpenConversation = async (tenantId, customerId, channel = 'whatsapp') => {
  const { rows } = await db.query(
    `INSERT INTO conversations (tenant_id, customer_id, origin_channel)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, customer_id) WHERE status = 'open'
     DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [tenantId, customerId, channel]
  );
  return rows[0];
};

// The channels a conversation actually carries, derived from its messages —
// the authoritative answer, as against origin_channel's "how it began".
// messages.channel is NOT NULL DEFAULT 'whatsapp' and written explicitly at
// every INSERT site, so a message can never be missing from this.
//
// Tenant-scoped on purpose: a conversation id is a UUID and looks unguessable,
// but every other query in this codebase filters by tenant_id and an id-only
// read here would be the one place a caller could learn something about
// another tenant's thread. An unknown id, or one belonging to another tenant,
// returns [] — indistinguishable, which is the point.
//
// Sorted so callers and assertions get a stable order. Returns [] for a
// conversation that exists but has never spoken.
const getParticipatingChannels = async (tenantId, conversationId) => {
  const { rows } = await db.query(
    `SELECT DISTINCT m.channel
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1
        AND m.tenant_id = $2
        AND c.tenant_id = $2
      ORDER BY m.channel`,
    [conversationId, tenantId]
  );
  return rows.map((r) => r.channel);
};

const setMode = async (tenantId, conversationId, mode) => {
  const { rows } = await db.query(
    `UPDATE conversations SET mode = $2 WHERE id = $1 AND tenant_id = $3 RETURNING *`,
    [conversationId, mode, tenantId]
  );
  return rows[0];
};

module.exports = { getOrCreateOpenConversation, getParticipatingChannels, setMode };
