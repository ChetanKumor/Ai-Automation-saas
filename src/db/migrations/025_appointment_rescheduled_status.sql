-- B2: appointments.status gains 'rescheduled'.
--
-- An appointment that has been MOVED is superseded, not cancelled. The move
-- writes a NEW row with status 'booked' and flips the OLD row to 'rescheduled',
-- so the old time survives as a record ("you moved me and never told me" is a
-- dispute settled with a row, not a memory) and stays distinguishable from a
-- patient cancellation.
--
-- Widening this CHECK is the ENTIRE schema change: no column is added, and
-- uniq_doctor_slot is not touched. That index is partial on `status = 'booked'`,
-- so the old row leaves it the moment it flips and its slot is bookable again
-- with no index change at all.
--
-- Every other reader of this column filters POSITIVELY on `= 'booked'` —
-- appointmentService.checkAvailability, reminderCron's claim query, and
-- scriptedTurnCheck's bookedAppointment — so a superseded row is correctly
-- excluded from all three without a line of change. The admin appointments
-- route selects the column unfiltered and its page never renders it.
--
-- Same DROP/ADD pattern as 007, which widened this table's reminder_status. The
-- constraint is declared inline and unnamed in 003 and in schema.sql, so
-- Postgres auto-named it `appointments_status_check` — which is the name both
-- the migrate path and a fresh genesis converge on.

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_status_check
    CHECK (status IN ('booked', 'cancelled', 'rescheduled'));
