-- Milestone: Appointment booking + availability

-- Flexible entity store for schedules, services, etc.
CREATE TABLE IF NOT EXISTS tenant_entities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_entities_tenant_type ON tenant_entities(tenant_id, type);

-- Owner notification phone (clinic's WhatsApp number for booking alerts)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_notify_phone TEXT;

-- Appointments
CREATE TABLE IF NOT EXISTS appointments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  doctor_name      TEXT NOT NULL,
  appointment_time TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_tenant_time ON appointments(tenant_id, appointment_time);

-- Prevent double-booking: same doctor + same time slot for the same tenant
CREATE UNIQUE INDEX IF NOT EXISTS uniq_doctor_slot
  ON appointments(tenant_id, doctor_name, appointment_time)
  WHERE status = 'booked';

-- Notifications log
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  content     TEXT NOT NULL,
  sent_status TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id);
