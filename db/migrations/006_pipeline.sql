-- 006_pipeline.sql
-- Pipeline prospects table for FGA sales tracking

CREATE TABLE IF NOT EXISTS pipeline_prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  company TEXT,
  vertical TEXT,
  email TEXT,
  phone TEXT,
  stage TEXT NOT NULL DEFAULT 'inbound'
    CHECK (stage IN ('inbound', 'demo_booked', 'demo_done', 'proposal_sent', 'closed_won', 'closed_lost')),
  notes TEXT,
  demo_scheduled_at TIMESTAMPTZ,
  proposal_sent_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  deal_value DECIMAL,
  tier TEXT CHECK (tier IN ('growth', 'scale') OR tier IS NULL),
  source TEXT CHECK (source IN ('website', 'referral', 'ad', 'network', 'other') OR source IS NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for stage-based queries (the most common access pattern)
CREATE INDEX IF NOT EXISTS idx_pipeline_prospects_stage ON pipeline_prospects(stage);

-- Auto-update updated_at on row changes
CREATE OR REPLACE FUNCTION update_pipeline_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pipeline_updated_at ON pipeline_prospects;
CREATE TRIGGER trg_pipeline_updated_at
  BEFORE UPDATE ON pipeline_prospects
  FOR EACH ROW
  EXECUTE FUNCTION update_pipeline_updated_at();
