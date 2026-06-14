/**
 * content-plan — weekly strategy planner (Sunday). Claude only; NO images,
 * NO drafts, NO visual cost. Produces two concepts (Mon + Thu), fingerprints
 * + quality-gates them, persists, and notifies the owner. Idempotent per week.
 *
 * Gated to planner-enabled tenants (FGA by default). A disabled tenant no-ops
 * so the cron is safe fleet-wide.
 */

const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const flags = require('../../core/content/planner-flags');
const planner = require('../../core/content/strategy-planner');
const fingerprint = require('../../core/content/fingerprint');
const scorer = require('../../core/content/quality-scorer');

function computeWeekStart(now = new Date()) {
  const d = new Date(now);
  const day = d.getUTCDay();              // 0=Sun..6=Sat
  const add = (1 - day + 7) % 7;          // days until Monday (0 if already Mon)
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add));
  return monday.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function recentFingerprints(tenantId) {
  const { data } = await db.from('content_fingerprints')
    .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(12);
  return data || [];
}

async function recentFeedback(tenantId) {
  const { data } = await db.from('content_feedback')
    .select('reason_code,reason_text,decision').eq('tenant_id', tenantId)
    .order('created_at', { ascending: false }).limit(8);
  return data || [];
}

// Persist one concept + its fingerprint + quality rows, linking them back.
async function persistConcept(tenant, planId, concept, fp, quality, similarity) {
  const insert = {
    tenant_id: tenant.id, plan_id: planId, slot: concept.slot,
    publish_date: concept.publish_date,
    status: 'proposed',
    objective: concept.objective, audience: concept.audience, audience_problem: concept.audience_problem,
    industry: concept.industry, fga_pov: concept.fga_pov, module_theme: concept.module_theme,
    is_module_post: !!concept.is_module_post, angle: concept.angle,
    format_id: concept.format_id, format_name: concept.format_name,
    evidence_kind: concept.evidence_kind || 'none', evidence_ref: concept.evidence_ref || {},
    concept_plan: concept.concept_plan || {}, hook: concept.hook || '', cta: concept.cta || '',
    cta_type: concept.cta_type, tone: concept.tone, emotional_framing: concept.emotional_framing,
    visual_strategy: (concept.concept_plan && concept.concept_plan.visual_direction) || null,
    needs_screenshot: !!concept.needs_screenshot,
    similarity_score: similarity.maxScore,
    similarity_warnings: similarity.warnings || [],
    quality_overall: quality.overall,
    selection_reason: concept.selection_reason || null,
  };
  const { data: conceptRow, error } = await db.from('content_plan_concepts').insert(insert).select('id').single();
  if (error) throw error;
  const conceptId = conceptRow.id;

  const { data: fpRow } = await db.from('content_fingerprints').insert({
    tenant_id: tenant.id, concept_id: conceptId, ...fp,
  }).select('id').single();

  const { data: qRow } = await db.from('content_quality_scores').insert({
    tenant_id: tenant.id, concept_id: conceptId,
    overall: quality.overall, categories: quality.categories || {}, passed: quality.passed,
    threshold: quality.threshold, explanation: quality.explanation, model: quality.model,
  }).select('id').single();

  await db.from('content_plan_concepts').update({
    fingerprint_id: fpRow ? fpRow.id : null,
    quality_score_id: qRow ? qRow.id : null,
  }).eq('id', conceptId);

  return conceptId;
}

async function run(tenant, payload = {}) {
  const log = createLogger('content-plan', tenant.slug);
  if (!flags.isPlannerEnabled(tenant)) return { skipped: true, reason: 'planner_disabled' };

  const weekStart = payload.week_start || computeWeekStart();

  // Idempotency: one plan per week unless forced.
  const { data: existing } = await db.from('content_plans')
    .select('id,status').eq('tenant_id', tenant.id).eq('week_start_date', weekStart).limit(1);
  if (existing && existing.length && !payload.force) {
    return { skipped: true, reason: 'plan_exists', plan_id: existing[0].id, status: existing[0].status };
  }

  const recentFp = await recentFingerprints(tenant.id);
  let feedback = await recentFeedback(tenant.id);
  const mixSnapshot = await planner.computeMixSnapshot(tenant.id);

  const regenMax = flags.conceptRegenMax(tenant);
  const simThreshold = flags.similarityThreshold(tenant);
  let best = null;

  for (let attempt = 0; attempt <= regenMax; attempt++) {
    const plan = await planner.buildWeeklyPlan(tenant, { weekStart, mixSnapshot, feedback });
    const evaluated = [];
    for (const c of (plan.concepts || [])) {
      c.publish_date = c.slot === 'thursday' ? addDays(weekStart, 3) : weekStart;
      const fp = fingerprint.computeFingerprint(c);
      const similarity = fingerprint.checkRepetition(fp, recentFp, { threshold: simThreshold });
      const quality = await scorer.scoreConcept(tenant, c);
      evaluated.push({ concept: c, fp, similarity, quality });
    }
    const failing = evaluated.filter((e) => e.similarity.reject || !e.quality.passed);
    best = { objective_summary: plan.objective_summary, evaluated };
    if (!failing.length) break;
    // Augment feedback with the failures so the next attempt avoids them.
    feedback = feedback.concat(failing.flatMap((e) => {
      const out = [];
      if (e.similarity.reject) out.push({ reason_code: 'repetitive', reason_text: e.similarity.warnings.join('; ') });
      if (!e.quality.passed) out.push({ reason_code: 'too_generic', reason_text: e.quality.explanation });
      return out;
    }));
    log.info(`Plan attempt ${attempt + 1} had ${failing.length} weak concept(s); regenerating`);
  }

  // Persist the plan + concepts (accept the last attempt even if a warning
  // remains — the owner sees the warning and can replace/regenerate).
  const { data: planRow, error: planErr } = await db.from('content_plans').insert({
    tenant_id: tenant.id, week_start_date: weekStart, status: 'planning',
    objective_summary: best.objective_summary, mix_snapshot: mixSnapshot,
    planner_model: 'claude-sonnet-4-6',
    idempotency_key: `${tenant.id}|${weekStart}`,
  }).select('id').single();
  if (planErr) throw planErr;
  const planId = planRow.id;

  const conceptIds = [];
  for (const e of best.evaluated) {
    conceptIds.push(await persistConcept(tenant, planId, e.concept, e.fp, e.quality, e.similarity));
  }

  await db.from('content_plans').update({ status: 'concepts_ready', notified_at: new Date().toISOString() }).eq('id', planId);

  // Notify the owner that concepts await review.
  try {
    await db.from('notifications').insert({
      tenant_id: tenant.id, channel: 'push', priority: 'high', status: 'pending',
      category: 'content_plan_ready', entity_type: 'content_plan', entity_id: planId,
      title: 'This week\'s content concepts are ready',
      message: `${best.evaluated.length} concepts await your review for the week of ${weekStart}.`,
      metadata: { plan_id: planId, week_start: weekStart, screen: 'ContentPlans' },
    });
  } catch (e) { log.warn(`notify skipped: ${e.message}`); }

  log.success(`Weekly plan ${planId} ready with ${conceptIds.length} concepts (week ${weekStart})`);
  return { plan_id: planId, week_start: weekStart, concepts: conceptIds.length };
}

module.exports = run;
module.exports.computeWeekStart = computeWeekStart;
