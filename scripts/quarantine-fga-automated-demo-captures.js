'use strict';

/**
 * Quarantine the reproduced FGA demo-form automation burst.
 *
 * Dry-run by default. Apply requires both APPLY=true and the exact FGA tenant
 * id in CONFIRM_FGA_TENANT_ID. It never deletes history, messages, or jobs and
 * cannot select another tenant. Deployed agent guards prevent any pending job
 * for a quarantined row from communicating.
 */

const { getServiceClient } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');

const APPLY = process.env.APPLY === 'true';
const CONFIRMED = process.env.CONFIRM_FGA_TENANT_ID === FGA_TENANT_ID;
const SINCE = process.env.SINCE || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

function isReproducedAutomationPattern(row) {
  if (row.lead_source !== 'website_demo_request') return false;
  const match = String(row.notes || '').match(/(?:^| · )Message: ([^·]+)$/);
  const freeText = String(match?.[1] || '').trim().replace(/[\s().+-]/g, '');
  return /^\d{7,18}$/.test(freeText);
}

async function main() {
  if (APPLY && !CONFIRMED) throw new Error('Exact FGA tenant confirmation is required');
  const db = getServiceClient();
  const { data, error } = await db.from('leads')
    .select('id, lead_source, notes, metadata, status, lifecycle_stage')
    .eq('tenant_id', FGA_TENANT_ID)
    .gte('created_at', SINCE)
    .limit(500);
  if (error) throw error;

  const candidates = (data || []).filter(isReproducedAutomationPattern);
  let changed = 0;
  if (APPLY) {
    for (const row of candidates) {
      const metadata = {
        ...(row.metadata || {}),
        intake_safety: {
          contact_allowed: false,
          reasons: ['numeric_only_free_text', 'reproduced_automation_burst'],
          assessed_at: new Date().toISOString(),
          evidence_source: 'quarantine-fga-automated-demo-captures',
        },
      };
      const { error: updateError } = await db.from('leads').update({
        status: 'disqualified',
        lifecycle_stage: 'disqualified',
        outreach_ready: false,
        metadata,
        updated_at: new Date().toISOString(),
      }).eq('tenant_id', FGA_TENANT_ID).eq('id', row.id);
      if (updateError) throw updateError;
      changed++;
    }
  }

  console.log(JSON.stringify({
    mode: APPLY ? 'apply' : 'dry_run',
    tenant_scope: 'fga_only',
    since: SINCE,
    matched: candidates.length,
    changed,
    deleted: 0,
    provider_calls: 0,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { isReproducedAutomationPattern, main };
