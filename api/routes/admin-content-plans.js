/**
 * First Gen Automate — Content Planner admin routes (platform owner only).
 * Mounted at /api/admin/content-plans behind authMiddleware + adminMiddleware.
 *
 * Two-stage content workflow:
 *   GET    /                          list recent weekly plans (+ concepts)
 *   GET    /:planId                   one plan with its concepts + quality
 *   POST   /generate                  enqueue content-plan (manual weekly plan)
 *   POST   /concepts/:id/approve      approve concept → screenshot/finalize
 *   POST   /concepts/:id/reject       { reason_code, reason_text, regenerate? }
 *   PATCH  /concepts/:id              owner edits (hook/cta/visual/owner_edits)
 *   POST   /concepts/:id/replace      reject + rebuild the week's plan
 *   POST   /concepts/:id/regenerate   alias of replace
 *   POST   /concepts/:id/save-for-later
 *   POST   /drafts/:id/regenerate-visual   { slide_number }
 *   POST   /drafts/:id/regenerate-copy      re-finalize the concept
 *   POST   /drafts/:id/return-to-concept    revert a final draft to its concept
 *
 * Concept planning NEVER triggers image generation; visuals only run after a
 * concept is approved. All job enqueues go through guardedEnqueue.
 */

const express = require('express');
const router = express.Router();

const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const { guardedEnqueue } = require('../../core/ai-safety/guarded-enqueue');

const log = createLogger('admin-content-plans');
const db = () => getServiceClient();
const TENANT = FGA_TENANT_ID;
const actorOf = (req) => (req.user && (req.user.email || req.user.sub)) || 'owner';

async function logFeedback({ conceptId = null, draftId = null, stage = 'concept', decision, reasonCode = null, reasonText = null, changedFields = null, actor }) {
  try {
    await db().from('content_feedback').insert({
      tenant_id: TENANT, concept_id: conceptId, draft_id: draftId, stage,
      decision, reason_code: reasonCode, reason_text: reasonText,
      changed_fields: changedFields, actor,
    });
  } catch (e) { log.warn(`feedback log skipped: ${e.message}`); }
}

// ── List plans ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { data: plans, error } = await db().from('content_plans')
      .select('*').eq('tenant_id', TENANT).order('week_start_date', { ascending: false }).limit(12);
    if (error) throw error;
    const ids = (plans || []).map((p) => p.id);
    let concepts = [];
    if (ids.length) {
      const { data } = await db().from('content_plan_concepts')
        .select('*').in('plan_id', ids).order('slot', { ascending: true });
      concepts = data || [];
    }
    const byPlan = {};
    for (const c of concepts) (byPlan[c.plan_id] = byPlan[c.plan_id] || []).push(c);
    res.json({ success: true, data: (plans || []).map((p) => ({ ...p, concepts: byPlan[p.id] || [] })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── One plan ────────────────────────────────────────────────────────────────
router.get('/:planId', async (req, res) => {
  try {
    const { data: plan, error } = await db().from('content_plans')
      .select('*').eq('tenant_id', TENANT).eq('id', req.params.planId).single();
    if (error || !plan) return res.status(404).json({ success: false, error: 'plan_not_found' });
    const { data: concepts } = await db().from('content_plan_concepts')
      .select('*').eq('plan_id', plan.id).order('slot', { ascending: true });
    res.json({ success: true, data: { ...plan, concepts: concepts || [] } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Manual weekly plan generation ────────────────────────────────────────────
router.post('/generate', async (req, res) => {
  try {
    const force = !!(req.body && req.body.force);
    const r = await guardedEnqueue({
      tenantId: TENANT, agentName: 'content-plan',
      items: [{ force, week_start: req.body && req.body.week_start }],
      source: 'admin_route', reason: 'manual_weekly_plan', createdBy: actorOf(req),
    });
    res.json({ success: r.ok, enqueued: r.enqueued, batch_id: r.batchId });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

async function loadConcept(id) {
  const { data } = await db().from('content_plan_concepts').select('*').eq('tenant_id', TENANT).eq('id', id).single();
  return data || null;
}

// ── Approve a concept → capture screenshot (if needed) then finalize ─────────
router.post('/concepts/:id/approve', async (req, res) => {
  try {
    const concept = await loadConcept(req.params.id);
    if (!concept) return res.status(404).json({ success: false, error: 'concept_not_found' });
    await db().from('content_plan_concepts').update({ status: 'concept_approved', approved_at: new Date().toISOString() }).eq('id', concept.id);
    await logFeedback({ conceptId: concept.id, decision: 'approved', actor: actorOf(req) });

    const agentName = concept.needs_screenshot ? 'content-screenshot' : 'content-concept-finalize';
    const r = await guardedEnqueue({
      tenantId: TENANT, agentName, items: [{ concept_id: concept.id }],
      source: 'admin_route', reason: 'concept_approved', createdBy: actorOf(req),
    });
    res.json({ success: r.ok, next: agentName, enqueued: r.enqueued });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Reject a concept (structured feedback) ───────────────────────────────────
router.post('/concepts/:id/reject', async (req, res) => {
  try {
    const concept = await loadConcept(req.params.id);
    if (!concept) return res.status(404).json({ success: false, error: 'concept_not_found' });
    const { reason_code = 'other', reason_text = null, regenerate = false } = req.body || {};
    await db().from('content_plan_concepts').update({ status: 'concept_rejected', rejected_at: new Date().toISOString() }).eq('id', concept.id);
    await logFeedback({ conceptId: concept.id, decision: 'rejected', reasonCode: reason_code, reasonText: reason_text, actor: actorOf(req) });

    let enqueued = 0;
    if (regenerate) {
      const r = await guardedEnqueue({
        tenantId: TENANT, agentName: 'content-plan', items: [{ force: true, week_start: null }],
        source: 'admin_route', reason: 'concept_rejected_regenerate', createdBy: actorOf(req),
      });
      enqueued = r.enqueued;
    }
    res.json({ success: true, regenerated: !!regenerate, enqueued });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Owner edits to a concept ─────────────────────────────────────────────────
router.patch('/concepts/:id', async (req, res) => {
  try {
    const concept = await loadConcept(req.params.id);
    if (!concept) return res.status(404).json({ success: false, error: 'concept_not_found' });
    const body = req.body || {};
    const update = {};
    const changed = [];
    for (const f of ['hook', 'cta', 'cta_type', 'angle', 'objective', 'module_theme', 'audience_problem', 'fga_pov', 'tone', 'emotional_framing']) {
      if (body[f] != null) { update[f] = String(body[f]).slice(0, 1000); changed.push(f); }
    }
    if (body.concept_plan && typeof body.concept_plan === 'object') { update.concept_plan = body.concept_plan; changed.push('concept_plan'); }
    if (body.industry != null) { update.industry = String(body.industry); changed.push('industry'); }
    if (body.format_id != null) { update.format_id = Number(body.format_id); changed.push('format_id'); }
    update.owner_edits = { ...(concept.owner_edits || {}), ...(body.owner_edits || {}), last_edited_at: new Date().toISOString() };
    update.updated_at = new Date().toISOString();
    await db().from('content_plan_concepts').update(update).eq('id', concept.id);
    await logFeedback({ conceptId: concept.id, decision: 'approved_with_edits', changedFields: changed, actor: actorOf(req) });
    res.json({ success: true, changed });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

async function rebuildWeek(req, concept, decision) {
  await db().from('content_plan_concepts').update({ status: 'concept_rejected', rejected_at: new Date().toISOString() }).eq('id', concept.id);
  await logFeedback({ conceptId: concept.id, decision, actor: actorOf(req) });
  return guardedEnqueue({
    tenantId: TENANT, agentName: 'content-plan', items: [{ force: true }],
    source: 'admin_route', reason: decision, createdBy: actorOf(req),
  });
}

router.post('/concepts/:id/replace', async (req, res) => {
  try {
    const concept = await loadConcept(req.params.id);
    if (!concept) return res.status(404).json({ success: false, error: 'concept_not_found' });
    const r = await rebuildWeek(req, concept, 'replaced');
    res.json({ success: r.ok, enqueued: r.enqueued });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/concepts/:id/regenerate', async (req, res) => {
  try {
    const concept = await loadConcept(req.params.id);
    if (!concept) return res.status(404).json({ success: false, error: 'concept_not_found' });
    const r = await rebuildWeek(req, concept, 'regenerated');
    res.json({ success: r.ok, enqueued: r.enqueued });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/concepts/:id/save-for-later', async (req, res) => {
  try {
    const concept = await loadConcept(req.params.id);
    if (!concept) return res.status(404).json({ success: false, error: 'concept_not_found' });
    await db().from('content_plan_concepts').update({ status: 'saved_for_later' }).eq('id', concept.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Final-draft visual / copy controls ───────────────────────────────────────
router.post('/drafts/:id/regenerate-visual', async (req, res) => {
  try {
    const slide_number = Number((req.body && req.body.slide_number) || 1);
    const r = await guardedEnqueue({
      tenantId: TENANT, agentName: 'content-visual-regenerate',
      items: [{ draft_id: req.params.id, slide_number }],
      source: 'admin_route', reason: 'owner_regenerate_visual', createdBy: actorOf(req),
    });
    res.json({ success: r.ok, enqueued: r.enqueued });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/drafts/:id/regenerate-copy', async (req, res) => {
  try {
    const { data: draft } = await db().from('content_drafts').select('id,parent_concept_id').eq('id', req.params.id).single();
    if (!draft || !draft.parent_concept_id) return res.status(400).json({ success: false, error: 'no_parent_concept' });
    await db().from('content_plan_concepts').update({ status: 'concept_approved' }).eq('id', draft.parent_concept_id);
    const r = await guardedEnqueue({
      tenantId: TENANT, agentName: 'content-concept-finalize',
      items: [{ concept_id: draft.parent_concept_id }],
      source: 'admin_route', reason: 'owner_regenerate_copy', createdBy: actorOf(req),
    });
    res.json({ success: r.ok, enqueued: r.enqueued });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/drafts/:id/return-to-concept', async (req, res) => {
  try {
    const { data: draft } = await db().from('content_drafts').select('id,parent_concept_id,status').eq('id', req.params.id).single();
    if (!draft || !draft.parent_concept_id) return res.status(400).json({ success: false, error: 'no_parent_concept' });
    await db().from('content_plan_concepts').update({ status: 'concept_approved', draft_id: null }).eq('id', draft.parent_concept_id);
    await db().from('content_drafts').update({ status: 'rejected', updated_at: new Date().toISOString() }).eq('id', draft.id);
    await logFeedback({ conceptId: draft.parent_concept_id, draftId: draft.id, stage: 'final', decision: 'returned_to_concept', actor: actorOf(req) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
