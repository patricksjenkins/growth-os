#!/usr/bin/env node
'use strict';

/**
 * Prepare or activate FGA's seven-total-touch campaign.
 *
 * Default is a zero-write validation. --apply-draft creates one versioned,
 * pending-approval campaign and six draft steps. --activate approves the six
 * canonical steps and activates only that version. It never archives an older
 * active campaign because existing enrollments must keep their immutable
 * campaign version. Neither mode enrolls a prospect or sends an email.
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
const ACTIVATE = process.argv.includes('--activate');
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
    writes_requested: APPLY || ACTIVATE,
    activates_campaign: ACTIVATE,
    enrolls_prospects: false,
    sends_email: false,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!validation.valid) throw new Error(`Invalid plan: ${validation.errors.join(', ')}`);
  if (!APPLY && !ACTIVATE) return;
  if (confirmation !== FGA_TENANT_ID) throw new Error('Exact FGA tenant confirmation is required');

  const db = getServiceClient();
  const { data: existing, error: existingError } = await db
    .from('drip_campaigns')
    .select('id, status, version')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('plan_key', plan.PLAN_KEY)
    .in('status', ['draft', 'pending_approval', 'active'])
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    if (ACTIVATE) {
      const { data: steps, error: stepsReadError } = await db.from('drip_campaign_steps')
        .select('id, day_offset, purpose, subject_template, body_html_template, status')
        .eq('tenant_id', FGA_TENANT_ID).eq('campaign_id', existing.id)
        .order('day_offset', { ascending: true });
      if (stepsReadError) throw stepsReadError;
      const expected = new Map(plan.FOLLOW_UPS.map((step) => [step.day, step]));
      if ((steps || []).length !== plan.FOLLOW_UPS.length) throw new Error('Campaign step count does not match the canonical plan');
      for (const step of steps || []) {
        const canonical = expected.get(Number(step.day_offset));
        if (!canonical
          || step.purpose !== canonical.purpose
          || step.subject_template !== canonical.subject
          || step.body_html_template !== canonical.body) {
          throw new Error(`Campaign step ${step.day_offset} differs from the canonical plan`);
        }
      }
      const approvedAt = new Date().toISOString();
      const { error: approvalError } = await db.from('drip_campaign_steps').update({
        status: 'approved', approved_at: approvedAt, approved_by: 'codex:growth-engine-overhaul',
      }).eq('tenant_id', FGA_TENANT_ID).eq('campaign_id', existing.id);
      if (approvalError) throw approvalError;
      const { count: approvedCount, error: approvedReadError } = await db.from('drip_campaign_steps')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).eq('campaign_id', existing.id).eq('status', 'approved');
      if (approvedReadError) throw approvedReadError;
      if (approvedCount !== plan.FOLLOW_UPS.length) throw new Error('Approved campaign step verification failed');
      if (existing.status !== 'active') {
        const { error: activateError } = await db.from('drip_campaigns').update({
          status: 'active', activated_at: approvedAt, updated_at: approvedAt,
        }).eq('tenant_id', FGA_TENANT_ID).eq('id', existing.id)
          .in('status', ['draft', 'pending_approval']);
        if (activateError) throw activateError;
      }
      const { data: verified, error: verifyError } = await db.from('drip_campaigns')
        .select('id, version, status, plan_key, total_touches')
        .eq('tenant_id', FGA_TENANT_ID).eq('id', existing.id).maybeSingle();
      if (verifyError || verified?.status !== 'active'
        || verified.plan_key !== plan.PLAN_KEY
        || Number(verified.total_touches) !== plan.TOTAL_TOUCHES) {
        throw new Error(`Campaign activation verification failed${verifyError ? `: ${verifyError.message}` : ''}`);
      }
      console.log(JSON.stringify({
        created: false,
        activated: true,
        campaign_version: verified.version,
        status: verified.status,
        approved_steps: approvedCount,
        older_campaigns_archived: 0,
        sends_email: false,
      }));
      return;
    }
    console.log(JSON.stringify({ created: false, reason: 'plan_already_exists', status: existing.status }));
    return;
  }

  if (ACTIVATE) throw new Error('Canonical campaign draft does not exist; run --apply-draft first');

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

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
