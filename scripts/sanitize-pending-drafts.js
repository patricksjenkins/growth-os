/**
 * One-shot: strip em/en dashes, curly quotes, and ellipsis from the copy in
 * UNSENT / pending drafts already sitting in the DB, so the current approval
 * queues read human (matching the going-forward generation fix in
 * core/text-style.js).
 *
 * Safe by design:
 *   - Only rows whose copy actually CONTAINS a target character are touched
 *     (no-op on already-clean rows).
 *   - Scoped to draft/pending/unsent rows only — never rewrites sent history.
 *   - Dry-run by default: prints what WOULD change. Pass --apply to write.
 *
 * Usage:
 *   node scripts/sanitize-pending-drafts.js            # dry run
 *   node scripts/sanitize-pending-drafts.js --apply    # write changes
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { stripAiTells } = require('../core/text-style');

const APPLY = process.argv.includes('--apply');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TARGET_CHARS = /[–—“”„‟″‘’‚‛′…]/;
const hasTells = (s) => typeof s === 'string' && TARGET_CHARS.test(s);

// table configs: which copy columns to clean and how to scope to "unsent".
const TABLES = [
  {
    table: 'outreach_sequences',
    cols: ['message_subject', 'message_body'],
    jsonCol: 'metadata',
    jsonKeys: ['body_html'],
    scope: (q) => q.in('sequence_status', ['draft', 'pending', 'pending_approval']),
  },
  {
    table: 'outreach_messages', // AKA Outreach Center
    cols: ['subject', 'body'],
    scope: (q) => q.in('status', ['draft', 'pending']),
  },
  {
    table: 'outreach_templates', // AKA static templates (drive future sends)
    cols: ['subject', 'body'],
    scope: (q) => q, // all rows
  },
  {
    table: 'content_drafts',
    cols: ['headline', 'body'],
    scope: (q) => q.in('status', ['draft', 'pending', 'pending_approval', 'pending_review']),
  },
  {
    table: 'conversations', // ONLY unsent outreach drafts in the approval queue
    cols: ['message_subject', 'message_body'],
    jsonCol: 'metadata',
    jsonKeys: ['body_html'],
    // draft_status='awaiting_approval' is set only on pending outreach drafts
    // (outreach.js) — this avoids rewriting delivered chat/SMS transcripts.
    scope: (q) => q.eq('metadata->>draft_status', 'awaiting_approval'),
  },
];

function sanitizeJson(obj, keys) {
  if (!obj || typeof obj !== 'object') return { changed: false, value: obj };
  let changed = false;
  const copy = { ...obj };
  for (const k of keys) {
    if (hasTells(copy[k])) {
      copy[k] = stripAiTells(copy[k]);
      changed = true;
    }
  }
  return { changed, value: copy };
}

async function run() {
  console.log(`\n=== sanitize-pending-drafts (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  let grandTotal = 0;

  for (const cfg of TABLES) {
    const selectCols = ['id', ...cfg.cols, cfg.jsonCol].filter(Boolean).join(', ');
    let query = db.from(cfg.table).select(selectCols).limit(5000);
    query = cfg.scope(query);
    const { data, error } = await query;
    if (error) {
      console.log(`  ${cfg.table}: SKIP (${error.message})`);
      continue;
    }

    const changes = [];
    for (const row of data || []) {
      const update = {};
      for (const c of cfg.cols) {
        if (hasTells(row[c])) update[c] = stripAiTells(row[c]);
      }
      if (cfg.jsonCol && cfg.jsonKeys) {
        const { changed, value } = sanitizeJson(row[cfg.jsonCol], cfg.jsonKeys);
        if (changed) update[cfg.jsonCol] = value;
      }
      if (Object.keys(update).length) changes.push({ id: row.id, update, before: row });
    }

    console.log(`  ${cfg.table}: ${data ? data.length : 0} in-scope rows, ${changes.length} need cleaning`);
    if (changes.length) {
      const s = changes[0];
      const col = cfg.cols.find((c) => s.update[c] != null);
      if (col) {
        console.log(`     e.g. row ${s.id} [${col}]:`);
        console.log(`       before: ${JSON.stringify(String(s.before[col]).slice(0, 90))}`);
        console.log(`       after:  ${JSON.stringify(String(s.update[col]).slice(0, 90))}`);
      }
    }

    if (APPLY) {
      for (const { id, update } of changes) {
        const { error: uErr } = await db.from(cfg.table).update(update).eq('id', id);
        if (uErr) console.log(`     ! update failed for ${id}: ${uErr.message}`);
      }
      if (changes.length) console.log(`     ✓ updated ${changes.length} rows`);
    }
    grandTotal += changes.length;
  }

  console.log(`\n${APPLY ? 'Updated' : 'Would update'} ${grandTotal} rows total.`);
  if (!APPLY && grandTotal) console.log('Re-run with --apply to write.\n');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
