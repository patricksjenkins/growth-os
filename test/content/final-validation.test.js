/**
 * Final validation — static guarantees of the content-planner redesign that
 * can be checked without DB/Claude/Playwright. Maps to the goal's acceptance
 * criteria: schedule preserved, rotation removed, planner gated, migration
 * additive, screenshots safe, no double-production.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

test('migration 048 creates all 8 planner tables + the additive draft FK', () => {
  const sql = read('db/migrations/048_content_planner.sql');
  for (const t of ['content_plans', 'content_plan_concepts', 'content_feedback', 'content_fingerprints', 'content_sources', 'content_statistics', 'content_visual_assets', 'content_quality_scores']) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`), `missing table ${t}`);
  }
  assert.ok(/ALTER TABLE content_drafts\s+ADD COLUMN IF NOT EXISTS parent_concept_id/.test(sql));
  assert.ok(sql.includes('ENABLE ROW LEVEL SECURITY'));
});

test('cron preserves Mon/Thu cadence, gates legacy to planner-OFF, adds planner runs', () => {
  const cron = read('worker/scheduler/cron.js');
  // legacy content-generation now gated to planner-disabled tenants
  assert.ok(cron.includes("when: (t) => !isPlannerEnabled(t)"));
  // strategy planner + finalize on the same Mon/Thu cadence
  assert.ok(/agent: 'content-plan',\s+cron: '40 18 \* \* 0'/.test(cron));
  assert.ok(cron.includes("agent: 'content-concept-finalize'"));
  assert.ok(cron.includes("cron: '5 11 * * 1'") && cron.includes("cron: '5 11 * * 4'"));
});

test('rigid 1-9 round-robin pillar map is no longer the planner mechanism', () => {
  // FORMAT_PILLAR_MAP still exists for the legacy path but the planner uses a
  // loose library chosen AFTER the concept — assert the planner does not import it.
  const planner = read('core/content/strategy-planner.js');
  assert.ok(!planner.includes('FORMAT_PILLAR_MAP'));
  assert.ok(planner.includes('FORMAT_LIBRARY'));
});

test('new agents are registered in the runtime registry', () => {
  const server = read('api/server.js');
  for (const a of ['content-plan', 'content-concept-finalize', 'content-screenshot', 'content-visual-regenerate']) {
    assert.ok(server.includes(`'${a}'`), `agent ${a} not registered`);
  }
  assert.ok(server.includes("/api/admin/content-plans"));
});

test('content-generation gained a concept mode that links parent_concept_id', () => {
  const cg = read('worker/agents/content-generation.js');
  assert.ok(cg.includes('conceptMode'));
  assert.ok(cg.includes('parent_concept_id'));
  assert.ok(cg.includes('buildConceptBrief'));
});

test('Dockerfile installs Playwright Chromium for screenshots', () => {
  const docker = read('Dockerfile');
  assert.ok(/playwright install --with-deps chromium/.test(docker));
});

test('concept planning never calls image generation (planner agent has no image-gen import)', () => {
  const planAgent = read('worker/agents/content-plan.js');
  assert.ok(!planAgent.includes('image-generation'));
});
