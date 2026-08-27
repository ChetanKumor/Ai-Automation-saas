-- Migration 029: conversation_events — the durable outcome/event log.
--
-- Audit: docs/audit/2026-08-conversation-model.md §8 (P-2), §9 (M-2).
-- Ships P-2 verbatim. M-1, M-3, M-4 and M-5 are NOT in this change.
--
-- ── Why this table, and why it is first ──────────────────────────────────────
-- The audit's §5 element table marks `outcome` ABSENT: `conversations.status`
-- is open/closed/pending, a LIFECYCLE state, and nothing in the schema says
-- "Appointment booked" vs "Needs staff". The demo's outcome card is rendered
-- from the booking row, not from an outcome field, because there is no outcome
-- field.
--
-- This table is the truth for that. §8's P-3 (`conversations.disposition`,
-- migration 030, NOT shipped here) is defined as "strictly a materialised read
-- of the latest conversation_events row" — so it cannot precede this one
-- without being a column with no source. Everything else in §9 is a different
-- axis: M-1 is per-turn attribution on `messages`, M-4 is booking provenance on
-- `appointments`. M-2 is the only migration in the set that carries outcome.
--
-- ── THE VOCABULARY DECISION, and the evidence behind it ──────────────────────
-- `type` and `channel` are UNCONSTRAINED TEXT. `actor` carries a CHECK. That
-- split is deliberate and it is the whole design risk of this table, so the
-- reasoning is recorded here rather than in a session log.
--
-- The precedent in this schema is unambiguous. `conversations.mode` and
-- `conversations.status` carry CHECKs; `conversations.origin_channel` and
-- `messages.channel` do not, and `turn_traces.channel` is explicitly commented
-- "(open set)". The unconstrained one is the one that just renamed cleanly:
-- migration 028 is a single ALTER … RENAME COLUMN, and its own header says why
-- — "there is no CHECK, no enum and no index on it to move".
--
-- And this repo has already paid the bill for guessing a vocabulary short,
-- twice, in migrations whose ENTIRE content is a widened CHECK:
--
--   007_needs_review_status.sql       widened TWO CHECKs (payment_schedules.status
--                                     and appointments.reminder_status) to admit
--                                     'needs_template' and 'needs_review'
--   025_appointment_rescheduled_status.sql
--                                     widened appointments.status to admit
--                                     'rescheduled'; its header: "Widening this
--                                     CHECK is the ENTIRE schema change"
--
-- Neither column was renamed. Neither was mistyped. The only thing wrong in
-- both cases was the guess about how many values there would be — which is
-- exactly the guess a CHECK on `type` would demand BEFORE a single patient
-- conversation exists, for a vocabulary far less settled than "how many states
-- can a reminder be in".
--
-- ── Widening is the cheap direction. Reshaping is not. ───────────────────────
-- Adding a value costs one DROP/ADD CONSTRAINT, as 007 and 025 show. Two
-- non-obvious costs ride along even there: the constraint name is Postgres's
-- auto-generated guess (025 needed a paragraph to argue the migrate path and a
-- fresh genesis converge on `appointments_status_check`), and
-- `DROP CONSTRAINT IF EXISTS` with a WRONG name silently no-ops — leaving the
-- old, narrow constraint still enforcing behind a green migration.
--
-- The expensive direction is different in kind. It is discovering that a value
-- already written into the CHECK is the wrong SHAPE — needs splitting, merging
-- or renaming — because then live rows violate the replacement and the
-- constraint swap needs a data backfill inside it. A guessed outcome vocabulary
-- produces that failure, not the cheap one. Capture liberally now; settle the
-- vocabulary from real rows later, with
--
--   SELECT type, COUNT(*) FROM conversation_events GROUP BY type;
--
-- as the query that settles it. That argument belongs to migration 030, where
-- `disposition`'s CHECK forces it.
--
-- ── Why `actor` IS constrained, against that grain ───────────────────────────
-- `actor` is not a vocabulary guess. It is a closed enumeration of who can act
-- in this system, and it already exists twice in this schema under CHECKs:
-- `messages.sender` CHECK IN ('customer','ai','agent') and
-- `knowledge_chunks.source` CHECK IN ('ai','agent','system'). A fifth actor
-- would be a product rewrite, not a discovered value. Closed by construction,
-- so constrained.
--
-- ── THE HOLE, named rather than papered over ─────────────────────────────────
-- The comment on `type` below lists five values. This migration ships emitters
-- for exactly ONE of them, 'handled'.
--
--   'escalated'       — DELIBERATELY ABSENT from the emitters. Escalation is a
--                       deferred product feature, and it is not merely unbuilt:
--                       §9/A-2 records that it "needs the AI to have any
--                       escalation signal, which today it does not". Nothing in
--                       aiService can say "I need a human". The hole stays.
--   'handoff_started' — deferred with handoff, and structurally single-path
--   'handoff_ended'     anyway: ownerCommands.js is WhatsApp-only, reachable
--                       solely by an owner typing TAKEOVER/DONE.
--   'booked'          — arrives with M-4. Emitting it now would mean widening
--                       appointmentService.bookAppointment's signature — shared
--                       by both channels — to serve an event this migration
--                       does not ship.
--
-- The hole costs nothing precisely BECAUSE `type` is unconstrained: the day the
-- escalation signal exists, 'escalated' is an INSERT, not a migration. That is
-- the strongest argument for the free column and it is load-bearing here.
--
-- ── ON DELETE, deliberately unlike turn_traces ───────────────────────────────
-- conversation_id CASCADEs, where turn_traces sets NULL. These are business
-- events ABOUT a thread; if the thread is gone they are not evidence of
-- anything, and under the audit's retention concern they should go with it.
-- call_session_id is SET NULL and nullable: WhatsApp events have no call.
--
-- `detail` must never carry patient utterances. Keeping conversational text
-- confined to `messages` is what makes a future retention sweep tractable.
--
-- ── Scope ────────────────────────────────────────────────────────────────────
-- CREATE TABLE + two indexes. No existing table is altered, no column added to
-- one, no constraint tightened on existing data. Nothing here can fail on a
-- populated database other than by running long. Idempotent it is NOT, in
-- keeping with 028: re-running raises 42P07, which is unreachable through the
-- runner (src/db/migrate.js filters pending against every recorded filename).

CREATE TABLE conversation_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id)        ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id)  ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id)      ON DELETE CASCADE,
  call_session_id UUID          REFERENCES call_sessions(id)  ON DELETE SET NULL,

  type      TEXT NOT NULL,          -- 'escalated' | 'handled' | 'booked'
                                    -- | 'handoff_started' | 'handoff_ended'
                                    -- open set — see the vocabulary note above
  channel   TEXT NOT NULL,          -- 'whatsapp' | 'voice' — open set, as turn_traces.channel
  actor     TEXT NOT NULL           -- who caused it
              CHECK (actor IN ('ai', 'agent', 'system', 'customer')),
  detail    JSONB,                  -- type-specific; never free patient text
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversation_events_conversation
  ON conversation_events(conversation_id, created_at);
CREATE INDEX idx_conversation_events_tenant_type_created
  ON conversation_events(tenant_id, type, created_at DESC);
