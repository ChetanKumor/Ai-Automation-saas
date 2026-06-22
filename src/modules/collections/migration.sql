-- Collections: payment reminder schedules
CREATE TABLE payment_schedules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  amount           NUMERIC(12,2) NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'INR',
  due_date         DATE NOT NULL,
  reminder_send_at TIMESTAMPTZ NOT NULL,

  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'sending', 'sent', 'paid',
                                       'overdue', 'failed', 'needs_template')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_schedules_tenant ON payment_schedules(tenant_id);
CREATE INDEX idx_payment_schedules_due ON payment_schedules(tenant_id, status, reminder_send_at);

CREATE TRIGGER trg_payment_schedules_updated BEFORE UPDATE ON payment_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
