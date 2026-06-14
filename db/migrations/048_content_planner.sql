-- ─────────────────────────────────────────────────────────────────────
-- Migration 048 — Content Planner (strategy-first content pipeline)
--
-- Adds the two-stage (concept → final) content planning system. Strictly
-- additive: the only change to an existing table is one nullable FK column
-- on content_drafts (parent_concept_id). All existing content_drafts rows
-- and publishing history are preserved.
--
-- A weekly plan (content_plans) holds two concepts (content_plan_concepts,
-- one per Mon/Thu slot). The owner approves a concept BEFORE any paid image
-- generation. On approval the concept is finalized into a content_drafts row
-- (parent_concept_id set) which flows through the EXISTING approvals →
-- publisher → Buffer path unchanged.
--
-- Tenant isolation via the standard DO-loop RLS pattern (mirrors 047).
-- ─────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────
-- content_plans — one strategy plan per week (Mon + Thu).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',  -- planning|concepts_ready|partially_approved|approved|expired|archived
  objective_summary TEXT,
  mix_snapshot JSONB NOT NULL DEFAULT '{}',  -- rolling-12 type/theme counts at plan time
  planner_model TEXT,
  generation_meta JSONB NOT NULL DEFAULT '{}',
  idempotency_key TEXT,                      -- sha1(tenant_id|week_start_date)
  notified_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, week_start_date)
);
CREATE INDEX IF NOT EXISTS idx_content_plans_tenant_status ON content_plans(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_content_plans_tenant_week ON content_plans(tenant_id, week_start_date DESC);

-- ─────────────────────────────────────────────────────────────────────
-- content_plan_concepts — the 2 concepts per plan. The owner concept-
-- approval unit. Strategy fields are decided BEFORE any visual cost.
-- quality_score_id / fingerprint_id are loose UUID references (populated
-- after scoring/fingerprinting; left FK-less to avoid a circular dependency
-- with content_quality_scores / content_fingerprints).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_plan_concepts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES content_plans(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,                        -- 'monday' | 'thursday'
  publish_date DATE,
  status TEXT NOT NULL DEFAULT 'proposed',   -- proposed|concept_approved|concept_rejected|saved_for_later|generating|final_ready|published|failed
  -- strategy (planner decides these with NO visual cost):
  objective TEXT,
  audience TEXT,
  audience_problem TEXT,
  industry TEXT,
  fga_pov TEXT,
  module_theme TEXT,
  is_module_post BOOLEAN DEFAULT false,      -- true=module-specific, false=broader managed-AI
  angle TEXT,
  format_id INTEGER,
  format_name TEXT,
  evidence_kind TEXT,                        -- 'stat'|'founder_perspective'|'scenario'|'none'
  evidence_ref JSONB NOT NULL DEFAULT '{}',  -- {stat_id} | {perspective_id} | {scenario}
  concept_plan JSONB NOT NULL DEFAULT '{}',  -- hook, visual_direction, cta, slide_outline (NO final copy)
  hook TEXT,
  cta TEXT,
  cta_type TEXT,
  tone TEXT,
  emotional_framing TEXT,
  visual_strategy TEXT,
  needs_screenshot BOOLEAN DEFAULT false,
  similarity_score NUMERIC,
  similarity_warnings JSONB NOT NULL DEFAULT '[]',
  quality_overall NUMERIC,
  quality_score_id UUID,
  fingerprint_id UUID,
  selection_reason TEXT,
  owner_edits JSONB NOT NULL DEFAULT '{}',
  draft_id UUID REFERENCES content_drafts(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_content_concepts_tenant_status ON content_plan_concepts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_content_concepts_plan ON content_plan_concepts(plan_id);
CREATE INDEX IF NOT EXISTS idx_content_concepts_draft ON content_plan_concepts(draft_id);

-- ─────────────────────────────────────────────────────────────────────
-- content_feedback — structured owner approval/rejection signal. Fed back
-- into future planning as context.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  concept_id UUID REFERENCES content_plan_concepts(id) ON DELETE CASCADE,
  draft_id UUID REFERENCES content_drafts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'concept',     -- 'concept' | 'final'
  decision TEXT,                             -- 'approved'|'approved_with_edits'|'rejected'|'regenerated'|'deleted'|'replaced'
  reason_code TEXT,                          -- too_generic|repetitive|too_negative|too_salesy|weak_hook|wrong_industry|wrong_module|bad_statistic|bad_visual|too_much_text|doesnt_explain_fga|robotic|strong_concept|strong_visual|strong_founder|other
  reason_text TEXT,
  changed_fields TEXT[],
  actor TEXT DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_feedback_tenant ON content_feedback(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_feedback_concept ON content_feedback(concept_id);

-- ─────────────────────────────────────────────────────────────────────
-- content_fingerprints — repetition control across many dimensions.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_fingerprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  concept_id UUID REFERENCES content_plan_concepts(id) ON DELETE SET NULL,
  draft_id UUID REFERENCES content_drafts(id) ON DELETE SET NULL,
  objective TEXT,
  topic TEXT,
  industry TEXT,
  module TEXT,
  painpoint TEXT,
  hook_pattern TEXT,
  headline_pattern TEXT,
  statistic_key TEXT,
  scenario TEXT,
  format_id INTEGER,
  cta_type TEXT,
  opening_structure TEXT,
  emotional_framing TEXT,
  theme_tags TEXT[] NOT NULL DEFAULT '{}',   -- ['missed_call','speed','62pct',...]
  combined_hash TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_fingerprints_tenant ON content_fingerprints(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_fingerprints_stat ON content_fingerprints(tenant_id, statistic_key);
CREATE INDEX IF NOT EXISTS idx_content_fingerprints_themes ON content_fingerprints USING GIN (theme_tags);

-- ─────────────────────────────────────────────────────────────────────
-- content_sources — credible, attributable sources for statistics.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  publisher TEXT,
  url TEXT,
  year INTEGER,
  credibility TEXT NOT NULL DEFAULT 'verified',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, year)
);
CREATE INDEX IF NOT EXISTS idx_content_sources_tenant ON content_sources(tenant_id);

-- ─────────────────────────────────────────────────────────────────────
-- content_statistics — DB-backed stat library. Persisted usage tracking
-- powers the ≤10-15% stat-led policy + no-recent-reuse rule.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_statistics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id UUID REFERENCES content_sources(id) ON DELETE SET NULL,
  stat_text TEXT NOT NULL,
  value_label TEXT,
  industry TEXT,                             -- NULL = cross-industry
  match_tokens TEXT[] NOT NULL DEFAULT '{}', -- ['62%','invoca']
  theme_tag TEXT,                            -- 'missed_call'|'speed'|'reviews'...
  use_hints TEXT,
  source_year INTEGER,
  last_used_at TIMESTAMPTZ,
  use_count INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_statistics_tenant ON content_statistics(tenant_id, industry, active);
CREATE INDEX IF NOT EXISTS idx_content_statistics_theme ON content_statistics(tenant_id, theme_tag);
CREATE INDEX IF NOT EXISTS idx_content_statistics_lastused ON content_statistics(tenant_id, last_used_at);

-- ─────────────────────────────────────────────────────────────────────
-- content_visual_assets — per-visual validation + bounded retry tracking.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_visual_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  draft_id UUID NOT NULL REFERENCES content_drafts(id) ON DELETE CASCADE,
  slide_number INTEGER,
  role TEXT,
  asset_kind TEXT,                           -- 'gemini'|'solid'|'hybrid'|'screenshot'|'user_upload'
  storage_path TEXT,
  public_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending|valid|invalid|regenerating|failed
  validation JSONB NOT NULL DEFAULT '{}',     -- {width,height,bytes,aspect,is_black,is_blank,checks:{...}}
  failure_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 2,
  validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_visual_assets_draft ON content_visual_assets(draft_id);
CREATE INDEX IF NOT EXISTS idx_content_visual_assets_status ON content_visual_assets(tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────
-- content_quality_scores — concept quality gate before owner review.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_quality_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  concept_id UUID REFERENCES content_plan_concepts(id) ON DELETE CASCADE,
  overall NUMERIC NOT NULL DEFAULT 0,
  categories JSONB NOT NULL DEFAULT '{}',     -- {strategic_relevance, fga_differentiation, ...}
  passed BOOLEAN NOT NULL DEFAULT false,
  threshold NUMERIC,
  explanation TEXT,                           -- concise; NO chain-of-thought
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_quality_concept ON content_quality_scores(concept_id);
CREATE INDEX IF NOT EXISTS idx_content_quality_tenant ON content_quality_scores(tenant_id, passed);

-- ─────────────────────────────────────────────────────────────────────
-- content_drafts linkage — the ONE additive change to an existing table.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE content_drafts
  ADD COLUMN IF NOT EXISTS parent_concept_id UUID REFERENCES content_plan_concepts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_content_drafts_concept ON content_drafts(parent_concept_id);

-- ─────────────────────────────────────────────────────────────────────
-- RLS — tenant isolation on every new table (same pattern as 047).
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'content_plans','content_plan_concepts','content_feedback','content_fingerprints',
    'content_sources','content_statistics','content_visual_assets','content_quality_scores'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_iso_' || t
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        'tenant_iso_' || t, t
      );
    END IF;
  END LOOP;
END $$;
