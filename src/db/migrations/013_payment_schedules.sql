-- Collections: payment reminder schedules (final schema including sent_at + idempotency)

CREATE TABLE IF NOT EXISTS payment_schedules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency         TEXT NOT NULL DEFAULT 'INR',
  due_date         DATE NOT NULL,
  reminder_send_at TIMESTAMPTZ NOT NULL,

  status           TEXT NOT NULL DEFAULT 'pending'
                     CONSTRAINT payment_schedules_status_check
                     CHECK (status IN ('pending', 'sending', 'sent', 'paid',
                                       'overdue', 'failed', 'needs_template', 'needs_review')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_schedules_tenant
  ON payment_schedules(tenant_id);

CREATE INDEX IF NOT EXISTS idx_payment_schedules_due
  ON payment_schedules(tenant_id, status, reminder_send_at);

-- Prevent duplicate schedules for the same customer+due_date+amount
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payment_schedule_per_customer_due
  ON payment_schedules(tenant_id, customer_id, due_date, amount)
  WHERE status NOT IN ('paid', 'failed');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payment_schedules_updated'
  ) THEN
    CREATE TRIGGER trg_payment_schedules_updated BEFORE UPDATE ON payment_schedules
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
