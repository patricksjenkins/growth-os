#!/usr/bin/env node
'use strict';

/**
 * Retire FGA email drafts that were not generated under the current canonical
 * outreach plan. Default is read-only. The write mode is additive/reversible:
 * sequences become `superseded` and still-new prospects return to `scored` so
 * the current drafter can replace the copy. No row is deleted and no provider
 * is called.
 */
require('dotenv').config();

const { getServiceClient, fetchAllRows } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');
const { PLAN_KEY } = require('../core/growth/seven-touch-plan');

const APPLY = process.argv.includes('--apply');
const CONFIRMED = process.argv.includes('--confirm-fga-production');

async function main() {
  if (APPLY && !CONFIRMED) throw new Error('--confirm-fga-production is required');
  const db = getServiceClient();
  const result = await fetchAllRows((from, to) => db.from('outreach_sequences')
    .select('id, lead_id, metadata, created_at')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('sequence_type', 'email')
    .eq('sequence_status', 'draft')
    .order('id', { ascending: true })
    .range(from, to));
  if (result.error || result.truncated) throw result.error || new Error('Draft inventory truncated');
  const stale = result.data.filter((row) => row.metadata?.message_version !== PLAN_KEY);
  const leadIds = [...new Set(stale.map((row) => row.lead_id).filter(Boolean))];
  const summary = {
    tenant_scope: 'FGA_ONLY',
    required_plan_key: PLAN_KEY,
    draft_email_inventory: result.data.length,
    stale_drafts: stale.length,
    affected_leads: leadIds.length,
    deletes_rows: false,
    sends_email: false,
    applies: APPLY,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!APPLY || !stale.length) return;

  for (let index = 0; index < stale.length; index += 200) {
    const ids = stale.slice(index, index + 200).map((row) => row.id);
    const { error } = await db.from('outreach_sequences').update({ sequence_status: 'superseded' })
      .eq('tenant_id', FGA_TENANT_ID).eq('sequence_type', 'email')
      .eq('sequence_status', 'draft').in('id', ids);
    if (error) throw new Error(`Draft retirement failed: ${error.message}`);
  }
  for (let index = 0; index < leadIds.length; index += 200) {
    const ids = leadIds.slice(index, index + 200);
    const { error } = await db.from('leads').update({
      lifecycle_stage: 'scored',
      automation_status: 'ready_for_outreach',
    }).eq('tenant_id', FGA_TENANT_ID).eq('status', 'new_lead')
      .eq('lifecycle_stage', 'sequenced').in('id', ids);
    if (error) throw new Error(`Lead reset failed: ${error.message}`);
  }
  const { count, error: verificationError } = await db.from('outreach_sequences')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', FGA_TENANT_ID).eq('sequence_type', 'email')
    .eq('sequence_status', 'draft');
  if (verificationError) throw verificationError;
  const { error: auditError } = await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'codex:growth-activation',
    action: 'stale_outreach_drafts_retired',
    entity_type: 'outreach_sequence',
    level: 'info',
    metadata: { ...summary, remaining_drafts: count },
  });
  if (auditError) throw auditError;
  console.log(JSON.stringify({ retired: stale.length, leads_returned_to_pool: leadIds.length, remaining_drafts: count }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
