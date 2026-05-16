/**
 * Growth OS — Regenerate Outreach Drafts with New Pricing
 *
 * One-shot cleanup script. Run after a pricing change to flush
 * pending outreach drafts that quote stale numbers and let the
 * outreach agent re-write them with the current pricing.
 *
 * Behavior:
 *   1. Find all outreach_sequences rows with sequence_status='draft'
 *      whose message_subject or message_body contains stale pricing
 *      strings (configurable below).
 *   2. Find their associated conversations rows (where
 *      direction='outbound' and metadata.draft_status='awaiting_approval').
 *   3. Reset each lead's lifecycle_stage back to 'enriched' so the
 *      outreach cron treats it as un-drafted again.
 *   4. Delete the stale sequence rows and conversation rows so the
 *      mobile approval queue + admin pipeline are clean.
 *   5. Optionally fire the outreach agent immediately so Patrick
 *      doesn't have to wait for the next cron tick.
 *
 * Usage:
 *   node scripts/regenerate-outreach-pricing.js              # dry-run (default)
 *   node scripts/regenerate-outreach-pricing.js --apply      # actually delete + reset
 *   node scripts/regenerate-outreach-pricing.js --apply --fire-now   # also run outreach agent
 *   node scripts/regenerate-outreach-pricing.js --tenant <slug>      # scope to one tenant
 */

require('dotenv').config();
const { db, getServiceClient } = require('../db/client');
const { createLogger } = require('../core/logger');

const log = createLogger('regen-outreach-pricing');

// Strings that indicate the OLD pricing. If any of these appear in a
// draft, the draft is treated as stale and needs regenerating.
const STALE_PRICING_STRINGS = [
  '$497',
  '$997',
  '$2,000',
  '$2k',
  '497/mo',
  '997/mo',
  '$2000',
];

function parseArgs() {
  const args = { apply: false, fireNow: false, tenantSlug: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--fire-now') args.fireNow = true;
    else if (a === '--tenant' && process.argv[i + 1]) args.tenantSlug = process.argv[++i];
  }
  return args;
}

function looksStale(text) {
  if (!text) return false;
  const t = String(text);
  return STALE_PRICING_STRINGS.some((s) => t.includes(s));
}

async function loadTenants(supabase, slug) {
  let q = supabase.from('tenants').select('id, slug, name');
  if (slug) q = q.eq('slug', slug);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function findStaleDrafts(supabase, tenantId) {
  // Fetch all draft sequences for this tenant; filter in JS because
  // PostgREST doesn't easily support multi-substring OR.
  const { data: drafts, error } = await supabase
    .from('outreach_sequences')
    .select('id, lead_id, contact_id, sequence_type, message_subject, message_body, created_at')
    .eq('tenant_id', tenantId)
    .eq('sequence_status', 'draft');
  if (error) throw error;
  return (drafts || []).filter(
    (d) => looksStale(d.message_subject) || looksStale(d.message_body),
  );
}

async function findRelatedConversations(supabase, tenantId, sequenceIds) {
  if (!sequenceIds.length) return [];
  const { data, error } = await supabase
    .from('conversations')
    .select('id, lead_id, sequence_id')
    .eq('tenant_id', tenantId)
    .in('sequence_id', sequenceIds);
  if (error) throw error;
  return data || [];
}

async function processTenant(supabase, tenant, args) {
  log.info(`Tenant: ${tenant.name} (${tenant.slug})`);
  const drafts = await findStaleDrafts(supabase, tenant.id);
  if (!drafts.length) {
    log.info('  → no stale drafts');
    return { tenant: tenant.slug, drafts: 0, conversations: 0, leads_reset: 0 };
  }

  const sequenceIds = drafts.map((d) => d.id);
  const leadIds = [...new Set(drafts.map((d) => d.lead_id).filter(Boolean))];
  const convs = await findRelatedConversations(supabase, tenant.id, sequenceIds);

  log.info(`  → found ${drafts.length} stale draft sequence(s), ${convs.length} conversation row(s), ${leadIds.length} lead(s) to reset`);
  drafts.slice(0, 5).forEach((d) => {
    log.info(`     - "${(d.message_subject || '(no subject)').slice(0, 60)}" (${d.sequence_type})`);
  });
  if (drafts.length > 5) log.info(`     ... and ${drafts.length - 5} more`);

  if (!args.apply) {
    log.info('  → DRY RUN — pass --apply to actually delete + reset');
    return { tenant: tenant.slug, drafts: drafts.length, conversations: convs.length, leads_reset: leadIds.length, dry_run: true };
  }

  // Apply: delete conversations → delete sequences → reset leads
  if (convs.length) {
    const { error } = await supabase.from('conversations').delete().in('id', convs.map((c) => c.id));
    if (error) log.warn(`  ! conversation delete error: ${error.message}`);
  }

  const { error: seqDelErr } = await supabase
    .from('outreach_sequences').delete().in('id', sequenceIds);
  if (seqDelErr) throw seqDelErr;

  if (leadIds.length) {
    const { error: leadErr } = await supabase
      .from('leads')
      .update({ lifecycle_stage: 'enriched' })
      .in('id', leadIds)
      .eq('lifecycle_stage', 'sequenced'); // only flip ones that were sequenced
    if (leadErr) log.warn(`  ! lead reset error: ${leadErr.message}`);
  }

  log.success(`  ✓ deleted ${drafts.length} sequences + ${convs.length} conversations + reset ${leadIds.length} leads`);

  if (args.fireNow) {
    log.info('  → firing outreach agent immediately…');
    try {
      const outreach = require('../worker/agents/outreach');
      const result = await outreach(tenant, {});
      log.success(`  ✓ outreach run complete: ${JSON.stringify(result).slice(0, 200)}`);
    } catch (err) {
      log.error(`  ! outreach run failed: ${err.message}`);
    }
  }

  return { tenant: tenant.slug, drafts: drafts.length, conversations: convs.length, leads_reset: leadIds.length };
}

async function main() {
  const args = parseArgs();
  const supabase = getServiceClient();

  log.info(args.apply
    ? '=== APPLY MODE — will delete drafts + reset leads ==='
    : '=== DRY RUN — pass --apply to make changes ===');
  if (args.fireNow && !args.apply) {
    log.warn('--fire-now ignored without --apply');
  }

  const tenants = await loadTenants(supabase, args.tenantSlug);
  if (!tenants.length) {
    log.warn(`No tenants found${args.tenantSlug ? ` matching slug "${args.tenantSlug}"` : ''}`);
    process.exit(1);
  }

  log.info(`Scoping to ${tenants.length} tenant(s)`);

  const results = [];
  for (const tenant of tenants) {
    try {
      const r = await processTenant(supabase, tenant, args);
      results.push(r);
    } catch (err) {
      log.error(`Tenant ${tenant.slug} failed: ${err.message}`);
      results.push({ tenant: tenant.slug, error: err.message });
    }
  }

  const totalDrafts = results.reduce((s, r) => s + (r.drafts || 0), 0);
  const totalLeads = results.reduce((s, r) => s + (r.leads_reset || 0), 0);
  log.info('');
  log.info('=== Summary ===');
  log.info(`Tenants processed: ${results.length}`);
  log.info(`Stale drafts ${args.apply ? 'deleted' : 'found'}: ${totalDrafts}`);
  log.info(`Leads ${args.apply ? 'reset to enriched' : 'that would be reset'}: ${totalLeads}`);
  if (args.apply && args.fireNow) {
    log.info('Outreach agent fired for each tenant — check pipeline for fresh drafts.');
  } else if (args.apply) {
    log.info('Leads are back at enriched stage. Next outreach cron tick (9am ET weekdays) will draft them with new pricing.');
    log.info('To run immediately: re-run with --fire-now');
  }
}

main().catch((err) => {
  log.error(`Failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
