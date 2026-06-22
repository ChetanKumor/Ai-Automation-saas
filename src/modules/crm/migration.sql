-- CRM Leads table
CREATE TABLE leads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,

  name             TEXT,
  phone            TEXT,
  requirement      TEXT,
  budget           TEXT,
  intent_level     TEXT NOT NULL DEFAULT 'low'
                     CHECK (intent_level IN ('low', 'medium', 'high')),
  stage            TEXT NOT NULL DEFAULT 'new'
                     CHECK (stage IN ('new', 'contacted', 'converted', 'lost')),
  source           TEXT,
  notes            TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leads_tenant ON leads(tenant_id);
CREATE INDEX idx_leads_tenant_stage ON leads(tenant_id, stage);

-- One active lead per customer per tenant.
-- "Active" means NOT converted and NOT lost.
CREATE UNIQUE INDEX uniq_active_lead_per_customer
  ON leads(tenant_id, customer_id)
  WHERE stage NOT IN ('converted', 'lost');

CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
