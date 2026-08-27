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

// Record a business event about a thread (migration 029, audit §8/P-2).
//
// One function so both channels write the same row shape: the WhatsApp path
// calls it from whatsapp/routes.js after the outbound persist, the voice path
// from internalVoice.js after each of its two mutually-exclusive outbound
// persists. Duplicating this INSERT at three sites is how the two channels
// would drift on column order, actor spelling, or a forgotten tenant filter.
//
// TENANT SCOPING IS STRUCTURAL, not a convention. The INSERT ... SELECT reads
// the conversation row and takes tenant_id/customer_id FROM IT, so a caller
// cannot attach an event to another tenant's thread even by passing a
// conversationId it has no business knowing: the WHERE finds no row and the
// statement inserts nothing. That is why this returns the inserted row or
// undefined rather than assuming success — a wrong tenant is silently zero
// rows, exactly as getParticipatingChannels returns [] for one.
//
// `type` and `channel` are unconstrained TEXT in the schema on purpose (see
// the 029 header). `actor` is CHECKed, so a bad actor raises 23514 here rather
// than storing a value nothing can interpret.
//
// `detail` MUST NOT carry patient utterances — conversational text lives in
// `messages` and nowhere else, which is what keeps a future retention sweep
// tractable. Pass null when there is nothing structural to record.
const recordEvent = async (
  tenantId, conversationId, { type, channel, actor, callSessionId = null, detail = null }
) => {
  const { rows } = await db.query(
    `INSERT INTO conversation_events
       (tenant_id, conversation_id, customer_id, call_session_id, type, channel, actor, detail)
     SELECT c.tenant_id, c.id, c.customer_id, $3, $4, $5, $6, $7
       FROM conversations c
      WHERE c.id = $1 AND c.tenant_id = $2
     RETURNING *`,
    [conversationId, tenantId, callSessionId, type, channel, actor, detail]
  );
  return rows[0];
};

const setMode = async (tenantId, conversationId, mode) => {
  const { rows } = await db.query(
    `UPDATE conversations SET mode = $2 WHERE id = $1 AND tenant_id = $3 RETURNING *`,
    [conversationId, mode, tenantId]
  );
  return rows[0];
};

// ── DISPOSITION, DERIVED ─────────────────────────────────────────────────────
//
// The audit's §8/P-3 proposed `conversations.disposition` as a materialised
// column with CHECK (disposition IN ('open','handled','needs_staff','booked')).
// It was DECLINED — see docs/audit/2026-08-disposition-deferred.md for the full
// argument. In short: `booked` is the wrong SHAPE rather than merely early (the
// one real captured patient booked an appointment and the design of record
// renders her `handled`); a CHECK on a column maintained atomically with an
// INSERT into an OPEN-set `type` column can roll that INSERT back and lose the
// event; and no reader exists — A-5 is two phases out.
//
// So this is the read, derived on demand. It is what a column would have held,
// and it is deliberately the ONLY place the mapping lives — the reconciliation
// oracle below drives off the same object, passed into SQL as jsonb, so the two
// cannot drift.

// The mapping, and it is short on purpose. `handled` is the ONE event type any
// code emits today (whatsapp/routes.js:266, internalVoice.js:288 and :546) and
// the one whose meaning is settled — public/demo/inbox.json renders exactly two
// statuses, `handled` and `needs_staff`, and `handled` is the one with a
// producer. Nothing else is mapped, because mapping it would settle a
// vocabulary question this session deliberately deferred.
//
// Note what is NOT here: 'escalated' -> 'needs_staff'. That looks obvious and is
// precisely the guess being avoided. `escalated` is an EVENT type; `needs_staff`
// is a DISPOSITION; deciding they are the same thing is A-2's call, made against
// real rows, not a line of mapping table written before an escalation signal
// exists.
const EVENT_TYPE_TO_DISPOSITION = Object.freeze({
  handled: 'handled',
});

// The current disposition of one thread, derived from conversation_events.
//
// ── THE FOUR RETURNS, and why none of them collapses into another ────────────
//
//   undefined  the conversation is not visible to this tenant — foreign, or no
//              such id. Same shape as recordEvent's undefined and
//              getParticipatingChannels' [], and indistinguishable between the
//              two cases, which is the point.
//   'open'     visible, ZERO events. The only defensible default and the one
//              P-3 itself proposed. Read it as "no outcome has been RECORDED",
//              never as "nothing happened": a550e900 is a real 115-message
//              thread that predates migration 029 and derives 'open'.
//   'handled'  the latest event is `handled`.
//   null       events exist and the latest one is of a type this function will
//              not name a disposition for.
//
// ── Why an unmapped type returns null, and not the three alternatives ────────
//
//   NOT 'open'          — that is a lie. It says no outcome was recorded when
//                         one was, and it is the single most dangerous wrong
//                         answer here because it is indistinguishable from the
//                         honest empty case.
//   NOT 'unknown'       — inventing a disposition value is exactly what the
//                         ruling declined to do, and it is lossy: `escalated`
//                         and some future `sms_delivered` would read alike.
//   NOT the raw type    — pass-through is tempting, because it would mirror
//                         029's "the day escalation exists it is an INSERT, not
//                         a migration" one layer up. It is still wrong: it
//                         returns EVENT vocabulary where a DISPOSITION is
//                         expected, so the first caller to filter on
//                         'escalated' would have settled the vocabulary
//                         question by accident, in code. That is the decision
//                         this session deferred, and pass-through would make it
//                         silently.
//
// null forces a caller to handle it. There is no caller in src/ yet, by design.
//
// ── Tenant scoping is structural, as recordEvent's is ────────────────────────
// The FROM is `conversations`, and the events are joined on the tenant_id read
// off THAT ROW (`e.tenant_id = c.tenant_id`), never on the caller's argument.
// $2 only decides whether the conversation row is visible at all. A caller
// passing another tenant's conversation id sees no row and gets undefined —
// identical to what an unknown id returns.
//
// ── The ordering caveat, named rather than hidden ────────────────────────────
// `conversation_events` has no monotonic sequence: `created_at` defaults to
// NOW(), which is TRANSACTION start time, so two events written in one
// transaction share it exactly. `id DESC` breaks that tie DETERMINISTICALLY —
// the same query returns the same row every time — but `id` is a random
// gen_random_uuid(), so among simultaneous events the winner is arbitrary
// rather than chronological. Today nothing writes two events in one
// transaction, so this is latent. It is a real gap in 029's shape for anyone
// deriving "latest" and it is filed with the deferral.
const deriveDisposition = async (tenantId, conversationId) => {
  const { rows } = await db.query(
    `SELECT ($3::jsonb ->> latest.type) AS disposition, latest.type AS latest_type
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT e.type
           FROM conversation_events e
          WHERE e.conversation_id = c.id
            AND e.tenant_id       = c.tenant_id
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1
       ) latest ON TRUE
      WHERE c.id = $1 AND c.tenant_id = $2`,
    [conversationId, tenantId, JSON.stringify(EVENT_TYPE_TO_DISPOSITION)]
  );
  if (rows.length === 0) return undefined;          // not this tenant's, or no such thread
  if (rows[0].latest_type === null) return 'open';  // visible, no events recorded
  return rows[0].disposition;                       // mapped, or null when unmapped
};

// ── THE RECONCILIATION ORACLE ────────────────────────────────────────────────
//
// This is the thing deferring the column buys, and the reason the deferral is
// not "do nothing". A materialised `disposition` is a cache with one in-process
// writer, and a cache is only as good as the query that can prove it has not
// drifted. That query has to exist before the column does, or the column ships
// with drift assumed absent rather than shown absent.
//
// With no column to compare against, "drift" is expressed against the signals
// that ought to agree with a disposition: `conversations.mode` and an open
// `handoff_sessions` row. Both mean a human is on the thread. A derivation that
// says `handled` or `open` while either is true is wrong about the one thing
// the Inbox's headline filter exists to show.
//
// ── What each finding means ──────────────────────────────────────────────────
//
//   mode_human_but_derived_<x>       conversations.mode = 'human'. Set by
//                                    ownerCommands.js:91 on TAKEOVER, which
//                                    emits NO conversation_event — the mode gate
//                                    returns before the emitter, deliberately
//                                    (whatsapp/routes.js:160-178). So the thread
//                                    a human is actively working derives
//                                    'handled', and the "Needs staff" filter
//                                    would not show it. THIS IS THE DEFECT THAT
//                                    KILLED THE COLUMN. A-2 closes it by
//                                    emitting on that branch.
//   open_handoff_but_derived_<x>     an unended handoff_sessions row exists.
//                                    Same defect, seen through the other
//                                    signal, and it can appear WITHOUT the
//                                    mode one: ownerCommands sets mode back to
//                                    'ai' at :68 and :180 while a session row
//                                    can still be open.
//   uninterpretable_latest_type      the latest event is of a type
//                                    EVENT_TYPE_TO_DISPOSITION does not map, so
//                                    deriveDisposition returns null. Not drift
//                                    — it is the open-set vocabulary arriving,
//                                    and the signal that the mapping needs a
//                                    decision.
//
// ── Two join details that are not incidental ─────────────────────────────────
// `handoff_sessions` is CUSTOMER-scoped, not conversation-scoped: it has no
// conversation_id (schema.sql:403-411), which is §6.1 card 5's whole complaint.
// It is therefore joined by customer, and restricted to c.status = 'open',
// because an open handoff is a statement about the customer's CURRENT thread
// and would otherwise flag every closed thread they have ever had.
// idx_handoff_sessions_active is UNIQUE on (tenant_id, customer_id) WHERE
// ended_at IS NULL, so that join cannot fan out.
//
// Tenant-scoped by the same structure as everything else here: `conversations`
// is the FROM, and both joins take tenant_id off that row.
//
// Returns [] for a clean tenant, and [] for a tenant that does not exist.
const findDispositionDisagreements = async (tenantId) => {
  const { rows } = await db.query(
    `WITH derived AS (
       SELECT c.id, c.customer_id, c.mode, c.status,
              latest.type                        AS latest_type,
              latest.created_at                  AS latest_at,
              ($2::jsonb ->> latest.type)        AS mapped,
              CASE WHEN latest.type IS NULL THEN 'open'
                   ELSE ($2::jsonb ->> latest.type) END AS derived,
              h.id                               AS open_handoff_id
         FROM conversations c
         LEFT JOIN LATERAL (
           SELECT e.type, e.created_at
             FROM conversation_events e
            WHERE e.conversation_id = c.id
              AND e.tenant_id       = c.tenant_id
            ORDER BY e.created_at DESC, e.id DESC
            LIMIT 1
         ) latest ON TRUE
         LEFT JOIN handoff_sessions h
           ON h.tenant_id   = c.tenant_id
          AND h.customer_id = c.customer_id
          AND h.ended_at IS NULL
          AND c.status = 'open'
        WHERE c.tenant_id = $1
     )
     SELECT id AS conversation_id, customer_id, mode, status,
            latest_type, latest_at, derived,
            (open_handoff_id IS NOT NULL) AS open_handoff,
            -- COALESCE, not a NOT NULL guard: an uninterpretable latest type
            -- makes derived NULL, and a bare || would then swallow the
            -- human-on-the-thread finding entirely — the one finding that must
            -- never go missing. It renders as '..._null' instead.
            ARRAY_REMOVE(ARRAY[
              CASE WHEN mode = 'human'
                   THEN 'mode_human_but_derived_' || COALESCE(derived, 'null') END,
              CASE WHEN open_handoff_id IS NOT NULL
                   THEN 'open_handoff_but_derived_' || COALESCE(derived, 'null') END,
              CASE WHEN latest_type IS NOT NULL AND mapped IS NULL
                   THEN 'uninterpretable_latest_type' END
            ], NULL) AS findings
       FROM derived
      WHERE (mode = 'human')
         OR (open_handoff_id IS NOT NULL)
         OR (latest_type IS NOT NULL AND mapped IS NULL)
      ORDER BY latest_at DESC NULLS LAST, id DESC`,
    [tenantId, JSON.stringify(EVENT_TYPE_TO_DISPOSITION)]
  );
  return rows;
};

module.exports = {
  getOrCreateOpenConversation,
  getParticipatingChannels,
  recordEvent,
  setMode,
  deriveDisposition,
  findDispositionDisagreements,
  EVENT_TYPE_TO_DISPOSITION,
};
