-- F1-R1: knowledge_chunks and tenant_entities gain updated_at + the EXISTING
-- set_updated_at trigger.
--
-- F1 fixed the readiness staleness formula so that it reads every storage home a
-- persisted check measures, not just config — see
-- lifecycleService.validationInputsChangedAt, which is the one consumer of these
-- two columns. It only half worked, because two of that union's three legs read
-- `max(created_at)` on tables that had no `updated_at` and no trigger:
--
--   • knowledge_chunks   → kb.populated, kb.retrieval   (FAQs)
--   • tenant_entities    → doctor.schedule, turn.scripted (doctor schedules)
--
-- A timestamp that can only be set at INSERT can only rise on an INSERT. So
-- editing a FAQ in place (knowledgeService.updateChunk is an UPDATE, never a
-- delete-and-reinsert), editing a doctor's schedule in place, or ARCHIVING a
-- doctor (doctorService.setArchived is `UPDATE ... SET type`, reached from the
-- portal's DELETE route on the has-appointments branch) left the measurement
-- exactly where it was and the validation run kept reporting a verdict that had
-- already expired.
--
-- The dangerous direction is the archive: it takes a bookable doctor out of the
-- register while the ring keeps reporting the check that counts them as passing.
-- That is F1 inverted — "you undid the work and the portal says you're fine" —
-- on the surface that decides go-live.
--
-- ── The trigger is the existing one ──────────────────────────────────────────
-- set_updated_at() is defined once, in schema.sql's SETUP block, and seven
-- tables already attach it (tenants, users, customers, conversations,
-- customer_memory, leads, payment_schedules). No new function is created here.
-- The guarded DO-block form and the trg_<table>_updated naming both follow 012
-- and 013, which are the two migrations that attach this same function.
--
-- ⚠️ The union's three legs are maintained by TWO different mechanisms, and the
-- next person to read that query should not assume otherwise: `tenant_configs`
-- has an `updated_at` and NO trigger — configService writes it explicitly on
-- every versioned config write. The two columns added below are trigger-
-- maintained. Both are correct; they are simply not the same mechanism.
--
-- ── Backfill ─────────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT NOW() stamps every pre-existing row with the migration
-- instant, so every outstanding validation run belonging to a tenant with any
-- FAQ or any doctor row goes stale exactly ONCE, on the deploy. That is the
-- correct outcome, not a bug: after this migration max(updated_at) is the honest
-- answer to "when did this input last move", and for rows written before the
-- column existed that answer is genuinely unknowable. A stale run costs a
-- re-check, never a wrong verdict. There is no production database at this
-- commit, so the real blast radius is the shared dev database.
--
-- ── Still open, deliberately not addressed here ──────────────────────────────
-- DELETE. Removing a FAQ LOWERS max(updated_at), so deleting the 5th FAQ takes a
-- clinic below kbMin while the run still reads fresh and the ring still reports
-- the old, higher verdict. No timestamp column can fix a max() that falls; it
-- needs a different signal (a tenant-level touch on delete, or a row count
-- carried in the union alongside the timestamp). Bounded meanwhile by
-- routes.js runGoLiveChain re-validating at the press, so a clinic that has
-- actually fallen below the minimum is still refused go-live.

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE tenant_entities
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_knowledge_chunks_updated'
  ) THEN
    CREATE TRIGGER trg_knowledge_chunks_updated BEFORE UPDATE ON knowledge_chunks
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tenant_entities_updated'
  ) THEN
    CREATE TRIGGER trg_tenant_entities_updated BEFORE UPDATE ON tenant_entities
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
