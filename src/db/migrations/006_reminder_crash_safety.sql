-- Milestone: Crash-safe appointment reminders (mirrors collections pattern)

-- New state-machine columns
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (reminder_status IN ('pending', 'sending', 'sent', 'failed'));

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- BACKFILL: every row that was already sent must be marked 'sent',
-- otherwise the cron will mass-resend them on first run.
UPDATE appointments
  SET reminder_status = 'sent'
  WHERE reminder_sent = true;

-- Index for the cron's main query
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_due
  ON appointments(reminder_status, appointment_time)
  WHERE reminder_status = 'pending';
