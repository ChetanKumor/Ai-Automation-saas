-- Add 'needs_review' status for timeout-ambiguous sends (collections + reminders)
-- Add 'needs_template' + 'needs_review' to appointment reminder_status

ALTER TABLE payment_schedules
  DROP CONSTRAINT IF EXISTS payment_schedules_status_check;
ALTER TABLE payment_schedules
  ADD CONSTRAINT payment_schedules_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'paid',
                      'overdue', 'failed', 'needs_template', 'needs_review'));

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_reminder_status_check;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_reminder_status_check
    CHECK (reminder_status IN ('pending', 'sending', 'sent', 'failed',
                               'needs_template', 'needs_review'));
