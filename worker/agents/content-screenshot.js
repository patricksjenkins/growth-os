/**
 * content-screenshot — capture a safe product/marketing screenshot for a
 * concept, then hand off to finalize.
 *
 * Runs only AFTER concept approval and only for concepts flagged
 * needs_screenshot. Capture is allowlisted + redacted + validated in
 * core/content/screenshot-capture.js. On ANY failure it still enqueues
 * finalize so the post degrades gracefully to a generated visual — screenshot
 * work never blocks copy.
 *
 * v1 targets PUBLIC FGA marketing pages (no auth, no PII). Authenticated admin-
 * portal capture can be layered on later via a short-lived screenshot token.
 */

const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const flags = require('../../core/content/planner-flags');
const capture = require('../../core/content/screenshot-capture');
const { guardedEnqueue } = require('../../core/ai-safety/guarded-enqueue');

const MARKETING_BASE = process.env.CONTENT_SCREENSHOT_BASE || 'https://firstgenautomate.com';

function pickTarget(concept) {
  const obj = String(concept.objective || '').toLowerCase();
  const angle = String(concept.angle || '').toLowerCase();
  if (obj.includes('promote') || obj.includes('discovery')) return { url: `${MARKETING_BASE}/pricing`, label: 'pricing' };
  if (obj.includes('workflow') || angle.includes('workflow') || obj.includes('educate')) return { url: `${MARKETING_BASE}/how-it-works`, label: 'how-it-works' };
  return { url: `${MARKETING_BASE}/`, label: 'home' };
}

async function enqueueFinalize(tenant, conceptId) {
  await guardedEnqueue({
    tenantId: tenant.id, agentName: 'content-concept-finalize',
    items: [{ concept_id: conceptId }], source: 'agent', reason: 'post_screenshot_finalize',
  });
}

async function run(tenant, payload = {}) {
  const log = createLogger('content-screenshot', tenant.slug);
  const conceptId = payload.concept_id;
  if (!conceptId) return { error: 'concept_id required' };

  const { data: concept } = await db.from('content_plan_concepts').select('*').eq('id', conceptId).single();
  if (!concept) return { error: 'concept_not_found' };

  if (!flags.screenshotsEnabled(tenant)) {
    await enqueueFinalize(tenant, conceptId);
    return { skipped: true, reason: 'screenshots_disabled', handed_off: true };
  }

  let shots = [];
  try {
    const target = payload.target || pickTarget(concept);
    shots = await capture.captureTargets(tenant, [{ ...target, fullPage: false }], {
      authHeader: payload.auth_header || null,
    });
  } catch (e) {
    log.warn(`capture failed: ${e.message}`);
  }

  if (shots.length) {
    const urls = shots.map((s) => s.public_url);
    const evidence = { ...(concept.evidence_ref || {}), screenshot_urls: urls };
    await db.from('content_plan_concepts').update({ evidence_ref: evidence }).eq('id', conceptId);
    log.success(`Captured ${urls.length} screenshot(s) for concept ${conceptId}`);
  } else {
    log.info('No screenshot captured; finalize will use a generated visual');
  }

  await enqueueFinalize(tenant, conceptId);
  return { concept_id: conceptId, screenshots: shots.length, handed_off: true };
}

module.exports = run;
