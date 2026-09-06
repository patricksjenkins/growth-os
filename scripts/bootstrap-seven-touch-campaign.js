#!/usr/bin/env node
'use strict';

/**
 * Prepare FGA's seven-total-touch campaign without activating it.
 *
 * Default is a zero-write validation. --apply-draft creates one versioned,
 * pending-approval campaign and six draft steps. It never archives the active
 * campaign, enrolls a prospect, or sends an email.
 *
 * Usage:
 *   node scripts/bootstrap-seven-touch-campaign.js
 *   node scripts/bootstrap-seven-touch-campaign.js --apply-draft \
 *     --confirm-tenant=30566ed6-026a-45e1-9502-029e6219df31
 */
require('dotenv').config();

const { getServiceClient } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');
const plan = require('../core/growth/seven-touch-plan');

const APPLY = process.argv.includes('--apply-draft');
const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-tenant='))?.split('=')[1];

async function main() {
  const validation = plan.validatePlan();
  const summary = {
    tenant_scope: 'FGA_ONLY',
    plan_key: plan.PLAN_KEY,
    total_touches: plan.TOTAL_TOUCHES,
    followup_days: plan.FOLLOW_UPS.map((step) => step.day),
    valid: validation.valid,
    errors: validation.errors,
    writes_requested: APPLY,
    activates_campaign: false,
    enrolls_prospects: false,
    sends_email: false,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!validation.valid) throw new Error(`Invalid plan: ${validation.errors.join(', ')}`);
  if (!APPLY) return;
  if (confirmation !== FGA_TENANT_ID) throw new Error('Exact FGA tenant confirmation is required');

  const db = getServiceClient();
  const { data: existing, error: existingError } = await db
    .from('drip_campaigns')
    .select('id, status, version')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('plan_key', plan.PLAN_KEY)
    .in('status', ['draft', 'pending_approval', 'active'])
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    console.log(JSON.stringify({ created: false, reason: 'plan_already_exists', status: existing.status }));
    return;
  }

  const { data: latest, error: versionError } = await db
    .from('drip_campaigns')
    .select('version')
    .eq('tenant_id', FGA_TENANT_ID)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (versionError) throw versionError;
  const version = Number(latest?.version || 0) + 1;

  const { data: campaign, error: campaignError } = await db
    .from('drip_campaigns')
    .insert({
      tenant_id: FGA_TENANT_ID,
      name: `FGA Wide-Net Seven-Touch v${version}`,
      status: 'pending_approval',
      version,
      plan_key: plan.PLAN_KEY,
      total_touches: plan.TOTAL_TOUCHES,
      includes_initial_touch: true,
      created_by: 'codex:growth-engine-overhaul',
    })
    .select('id, version, status')
    .single();
  if (campaignError) throw campaignError;

  const rows = plan.FOLLOW_UPS.map((step) => ({
    tenant_id: FGA_TENANT_ID,
    campaign_id: campaign.id,
    day_offset: step.day,
    purpose: step.purpose,
    subject_template: step.subject,
    body_html_template: step.body,
    status: 'draft',
    generation_metadata: {
      source: 'canonical-seven-touch-plan',
      plan_key: plan.PLAN_KEY,
      generated_at: new Date().toISOString(),
    },
  }));
  const { error: stepsError } = await db.from('drip_campaign_steps').insert(rows);
  if (stepsError) throw stepsError;

  console.log(JSON.stringify({ created: true, campaign_version: campaign.version, status: campaign.status, step_count: rows.length }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
