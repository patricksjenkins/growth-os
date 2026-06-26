-- ─────────────────────────────────────────────────────────────────────
-- 060_content_visual_upgrade.sql — content engagement + visual system upgrade
--
-- Strictly ADDITIVE, all columns nullable. Surfaces the new content concepts
-- (pillar, visual_type) and the per-draft visual scoring + safe-area status so
-- the planner, quality gate, and approval UI can read/write them cleanly
-- instead of stuffing everything into JSONB.
--
-- reason_code (content_feedback) and failure_reason (content_visual_assets)
-- are intentionally left as free TEXT (no CHECK), so the new visual/edge
-- rejection + failure codes need no further migration.
-- ─────────────────────────────────────────────────────────────────────

-- Concept-stage: the chosen pillar + the visual_type the planner committed to.
ALTER TABLE content_plan_concepts ADD COLUMN IF NOT EXISTS visual_type TEXT;
ALTER TABLE content_plan_concepts ADD COLUMN IF NOT EXISTS pillar TEXT;

-- Draft-stage: carried through finalize so the approval UI can show them and
-- the gate can block publish.
ALTER TABLE content_drafts ADD COLUMN IF NOT EXISTS visual_type TEXT;
ALTER TABLE content_drafts ADD COLUMN IF NOT EXISTS content_pillar TEXT;
ALTER TABLE content_drafts ADD COLUMN IF NOT EXISTS visual_score NUMERIC;
ALTER TABLE content_drafts ADD COLUMN IF NOT EXISTS hook_score NUMERIC;
ALTER TABLE content_drafts ADD COLUMN IF NOT EXISTS safe_area_status TEXT;  -- 'pass' | 'fail' | 'pending'
