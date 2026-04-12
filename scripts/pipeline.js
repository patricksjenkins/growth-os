#!/usr/bin/env node

/**
 * Pipeline CLI — FGA Sales Pipeline Tracker
 *
 * Usage:
 *   node scripts/pipeline.js list                         Show all active prospects grouped by stage
 *   node scripts/pipeline.js add --name "..." [options]   Add a new prospect
 *   node scripts/pipeline.js move <id-prefix> <stage>     Move prospect to a stage
 *   node scripts/pipeline.js view <id-prefix>             View prospect details
 *   node scripts/pipeline.js summary                      Pipeline summary with counts and value
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { getServiceClient } = require('../db/client');

const STAGES = ['inbound', 'demo_booked', 'demo_done', 'proposal_sent', 'closed_won', 'closed_lost'];
const STAGE_LABELS = {
  inbound: 'Inbound',
  demo_booked: 'Demo Booked',
  demo_done: 'Demo Done',
  proposal_sent: 'Proposal Sent',
  closed_won: 'Closed Won',
  closed_lost: 'Closed Lost',
};
const SOURCES = ['website', 'referral', 'ad', 'network', 'other'];
const TIERS = ['growth', 'scale'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {};
  let positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      flags[key] = val;
      if (val !== true) i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}

async function findByPrefix(db, prefix) {
  const { data, error } = await db
    .from('pipeline_prospects')
    .select('*')
    .ilike('id', `${prefix}%`);
  if (error) die(error.message);
  if (!data || data.length === 0) die(`No prospect found matching prefix "${prefix}"`);
  if (data.length > 1) {
    console.error(`Multiple matches for "${prefix}":`);
    data.forEach((p) => console.error(`  ${p.id}  ${p.name}`));
    die('Use a longer prefix to narrow it down.');
  }
  return data[0];
}

function formatCurrency(val) {
  if (val == null) return '-';
  return `$${Number(val).toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
}

function formatDate(val) {
  if (!val) return '-';
  return new Date(val).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function shortId(id) {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList() {
  const db = getServiceClient();
  const { data, error } = await db
    .from('pipeline_prospects')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) die(error.message);

  if (!data || data.length === 0) {
    console.log('No prospects in the pipeline.');
    return;
  }

  // Group by stage in defined order
  const grouped = {};
  STAGES.forEach((s) => (grouped[s] = []));
  data.forEach((p) => {
    if (grouped[p.stage]) grouped[p.stage].push(p);
  });

  for (const stage of STAGES) {
    const prospects = grouped[stage];
    if (prospects.length === 0) continue;

    console.log(`\n--- ${STAGE_LABELS[stage]} (${prospects.length}) ---`);
    for (const p of prospects) {
      const company = p.company ? ` @ ${p.company}` : '';
      const value = p.deal_value ? `  ${formatCurrency(p.deal_value)}` : '';
      const tier = p.tier ? `  [${p.tier}]` : '';
      console.log(`  ${shortId(p.id)}  ${p.name}${company}${tier}${value}`);
    }
  }
  console.log('');
}

async function cmdAdd(flags) {
  if (!flags.name) die('--name is required. Usage: node scripts/pipeline.js add --name "John" [--company "..."] [--vertical "..."] [--email "..."] [--phone "..."] [--source referral] [--tier growth] [--deal-value 497] [--notes "..."]');

  const source = flags.source || null;
  if (source && !SOURCES.includes(source)) die(`Invalid source "${source}". Valid: ${SOURCES.join(', ')}`);

  const tier = flags.tier || null;
  if (tier && !TIERS.includes(tier)) die(`Invalid tier "${tier}". Valid: ${TIERS.join(', ')}`);

  const record = {
    name: flags.name,
    company: flags.company || null,
    vertical: flags.vertical || null,
    email: flags.email || null,
    phone: flags.phone || null,
    source,
    tier,
    deal_value: flags['deal-value'] || null,
    notes: flags.notes || null,
    stage: 'inbound',
  };

  const db = getServiceClient();
  const { data, error } = await db
    .from('pipeline_prospects')
    .insert(record)
    .select()
    .single();
  if (error) die(error.message);

  console.log(`Added prospect: ${data.name} (${shortId(data.id)})`);
  if (data.company) console.log(`  Company:  ${data.company}`);
  if (data.vertical) console.log(`  Vertical: ${data.vertical}`);
  if (data.source) console.log(`  Source:   ${data.source}`);
  console.log(`  Stage:    ${STAGE_LABELS[data.stage]}`);
}

async function cmdMove(positional) {
  const prefix = positional[0];
  const stage = positional[1];
  if (!prefix || !stage) die('Usage: node scripts/pipeline.js move <id-prefix> <stage>');
  if (!STAGES.includes(stage)) die(`Invalid stage "${stage}". Valid: ${STAGES.join(', ')}`);

  const db = getServiceClient();
  const prospect = await findByPrefix(db, prefix);

  const updates = { stage };

  // Auto-set timestamp fields based on stage transition
  if (stage === 'demo_booked' && !prospect.demo_scheduled_at) {
    updates.demo_scheduled_at = new Date().toISOString();
  }
  if (stage === 'proposal_sent' && !prospect.proposal_sent_at) {
    updates.proposal_sent_at = new Date().toISOString();
  }
  if ((stage === 'closed_won' || stage === 'closed_lost') && !prospect.closed_at) {
    updates.closed_at = new Date().toISOString();
  }

  const { error } = await db
    .from('pipeline_prospects')
    .update(updates)
    .eq('id', prospect.id);
  if (error) die(error.message);

  console.log(`Moved ${prospect.name} (${shortId(prospect.id)}): ${STAGE_LABELS[prospect.stage]} -> ${STAGE_LABELS[stage]}`);
}

async function cmdView(positional) {
  const prefix = positional[0];
  if (!prefix) die('Usage: node scripts/pipeline.js view <id-prefix>');

  const db = getServiceClient();
  const p = await findByPrefix(db, prefix);

  console.log(`\n  Prospect: ${p.name}`);
  console.log(`  ID:       ${p.id}`);
  console.log(`  Company:  ${p.company || '-'}`);
  console.log(`  Vertical: ${p.vertical || '-'}`);
  console.log(`  Email:    ${p.email || '-'}`);
  console.log(`  Phone:    ${p.phone || '-'}`);
  console.log(`  Stage:    ${STAGE_LABELS[p.stage]}`);
  console.log(`  Tier:     ${p.tier || '-'}`);
  console.log(`  Source:   ${p.source || '-'}`);
  console.log(`  Value:    ${formatCurrency(p.deal_value)}`);
  console.log(`  Notes:    ${p.notes || '-'}`);
  console.log(`  ---`);
  console.log(`  Demo scheduled: ${formatDate(p.demo_scheduled_at)}`);
  console.log(`  Proposal sent:  ${formatDate(p.proposal_sent_at)}`);
  console.log(`  Closed:         ${formatDate(p.closed_at)}`);
  console.log(`  Created:        ${formatDate(p.created_at)}`);
  console.log(`  Updated:        ${formatDate(p.updated_at)}`);
  console.log('');
}

async function cmdSummary() {
  const db = getServiceClient();
  const { data, error } = await db
    .from('pipeline_prospects')
    .select('*');
  if (error) die(error.message);

  if (!data || data.length === 0) {
    console.log('No prospects in the pipeline.');
    return;
  }

  const counts = {};
  STAGES.forEach((s) => (counts[s] = 0));
  let totalValue = 0;
  let activeValue = 0;
  let wonValue = 0;
  let wonCount = 0;

  data.forEach((p) => {
    counts[p.stage] = (counts[p.stage] || 0) + 1;
    const val = Number(p.deal_value) || 0;
    totalValue += val;
    if (p.stage === 'closed_won') {
      wonValue += val;
      wonCount++;
    }
    if (p.stage !== 'closed_won' && p.stage !== 'closed_lost') {
      activeValue += val;
    }
  });

  console.log('\n  Pipeline Summary');
  console.log('  ================');
  for (const stage of STAGES) {
    const count = counts[stage];
    const bar = '#'.repeat(count);
    console.log(`  ${STAGE_LABELS[stage].padEnd(16)} ${String(count).padStart(3)}  ${bar}`);
  }
  console.log('  ----------------');
  console.log(`  Total prospects: ${data.length}`);
  console.log(`  Active pipeline: ${data.length - (counts.closed_won + counts.closed_lost)} prospects, ${formatCurrency(activeValue)} value`);
  console.log(`  Closed won:      ${wonCount} deals, ${formatCurrency(wonValue)} value`);
  console.log(`  Total pipeline:  ${formatCurrency(totalValue)}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
Pipeline CLI — FGA Sales Pipeline Tracker

Commands:
  list                             Show all active prospects grouped by stage
  add --name "..." [options]       Add a new prospect
  move <id-prefix> <stage>         Move prospect to a stage
  view <id-prefix>                 View prospect details
  summary                          Pipeline summary with counts and value

Add options:
  --name "..."          Required. Prospect name.
  --company "..."       Business name
  --vertical "..."      Industry vertical
  --email "..."         Email address
  --phone "..."         Phone number
  --source <source>     One of: website, referral, ad, network, other
  --tier <tier>         One of: growth, scale
  --deal-value <num>    Expected deal value
  --notes "..."         Free-text notes

Stages: ${STAGES.join(', ')}
`);
    return;
  }

  const command = args[0];
  const { flags, positional } = parseArgs(args.slice(1));

  switch (command) {
    case 'list':
      await cmdList();
      break;
    case 'add':
      await cmdAdd(flags);
      break;
    case 'move':
      await cmdMove(positional);
      break;
    case 'view':
      await cmdView(positional);
      break;
    case 'summary':
      await cmdSummary();
      break;
    default:
      die(`Unknown command "${command}". Run without arguments for help.`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
