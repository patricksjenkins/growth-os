-- 2026-06-09 — Approved Fact Library for the Marketing Studio
--
-- Owner-managed library of VERIFIED statistics the voiceover generator is
-- allowed to cite. The script engine will NEVER invent a statistic; a
-- percentage can only appear in a script if it comes from an active row
-- here, with a real source, and hasn't been used too recently.
--
-- FGA-internal only (single tenant: the FGA platform tenant). No RLS games
-- needed beyond owning the table — these routes are admin-gated.

CREATE TABLE IF NOT EXISTS marketing_approved_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statistic_text TEXT NOT NULL,            -- human-readable statement
  exact_value TEXT,                        -- e.g. "62%" or "$2,000"
  approved_wording TEXT,                   -- the exact phrasing allowed in a script
  source_name TEXT NOT NULL,               -- e.g. "BrightLocal 2024 Consumer Review Survey"
  source_url TEXT,                         -- citation link/reference
  publication_date DATE,                   -- when the source was published
  applicable_modules TEXT[] DEFAULT '{}',  -- module keys this fact fits
  applicable_industries TEXT[] DEFAULT '{}',
  applicable_niches TEXT[] DEFAULT '{}',
  approved_context TEXT,                    -- notes on when it's appropriate
  review_date DATE,                        -- next review-by date
  active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_facts_active ON marketing_approved_facts (active);
CREATE INDEX IF NOT EXISTS idx_marketing_facts_last_used ON marketing_approved_facts (last_used_at);
