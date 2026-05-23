/**
 * Growth OS — Mercury Sync Agent
 *
 * Phase 4 final step of the BI & Financial Sync plan
 * (~/Desktop/FGA/dashboards/bi-sync-strategy.html §3 Phase 4).
 *
 * Nightly agent that pulls FGA's Mercury account balance + new
 * transactions and:
 *   1. Updates today's tenant_metrics_snapshots.metadata.cash_balance
 *      → lights up the Cash Runway tile on Reports → Growth & Ops
 *   2. Pulls transactions since the last successful sync, creates
 *      DRAFT expense entries in finance_entries with metadata.source
 *      = 'mercury' + categorization_needed attention_queue items so
 *      Patrick approves them inline on Reports
 *
 * Idempotency: each Mercury transaction has a stable id. We use it as
 * the metadata.mercury_txn_id and skip any txn we've already imported.
 *
 * Tenant scope: this agent only runs for FGA itself (the platform-
 * owner tenant). Client tenants' bank accounts are NOT touched —
 * Mercury API is FGA's bookkeeping, not a per-client feature.
 *
 * Schedule: 0 5 * * * (daily, 5am ET — before bookkeeping agent's
 * 6am ET Mon run, so newly-imported draft expenses are categorized
 * automatically when bookkeeping next fires).
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');
const mercury = require('../../integrations/mercury');

// FGA-only — guard against accidentally pulling client banks
function _isFgaTenant(tenant) {
  return tenant?.slug === 'fga' || tenant?.slug === 'fga-marketing' || tenant?.is_platform_owner === true;
}

async function _writeCashBalanceSnapshot(tenantId, balance) {
  const today = new Date().toISOString().slice(0, 10);

  // Upsert today's snapshot — preserve any existing metadata (e.g. churn_score)
  const { data: existing } = await db
    .from('tenant_metrics_snapshots')
    .select('id, metadata')
    .eq('tenant_id', tenantId)
    .eq('snapshot_date', today)
    .maybeSingle();

  const metadata = {
    ...(existing?.metadata || {}),
    cash_balance: balance,
    cash_balance_source: 'mercury',
    cash_balance_synced_at: new Date().toISOString(),
  };

  if (existing) {
    await db.from('tenant_metrics_snapshots').update({ metadata }).eq('id', existing.id);
  } else {
    // Need a baseline mrr + status; pull from tenant_config
    const { data: cfg } = await db
      .from('tenant_config')
      .select('key, value')
      .eq('tenant_id', tenantId)
      .in('key', ['monthly_rate', 'tier', 'churned_at']);
    const cfgMap = {};
    for (const c of cfg || []) cfgMap[c.key] = c.value;
    await db.from('tenant_metrics_snapshots').insert({
      tenant_id: tenantId,
      snapshot_date: today,
      mrr: Number(cfgMap.monthly_rate) || 0,
      status: cfgMap.churned_at ? 'churned' : 'active',
      tier: cfgMap.tier || null,
      metadata,
    });
  }
}

async function _lastSyncCutoff(tenantId) {
  // Pull the most-recent imported transaction date — anything newer is in-scope
  const { data } = await db
    .from('finance_entries')
    .select('date')
    .eq('tenant_id', tenantId)
    .eq('metadata->>source', 'mercury')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  // Default to 60 days ago on first run so we backfill recent history
  if (!data?.date) {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return d.toISOString();
  }
  return new Date(data.date).toISOString();
}

async function _alreadyImported(tenantId, mercuryTxnId) {
  const { data } = await db
    .from('finance_entries')
    .select('id')
    .eq('tenant_id', tenantId)
    .filter('metadata->>mercury_txn_id', 'eq', mercuryTxnId)
    .maybeSingle();
  return !!data;
}

async function _createDraftFromMercuryTxn(tenantId, t) {
  // Mercury amounts are signed: negative = debit (expense), positive = credit (income/deposit)
  const amount = Math.abs(Number(t.amount) || 0);
  if (amount === 0) return null;
  const isExpense = Number(t.amount) < 0;
  const dateStr = (t.postedAt || t.createdAt || new Date().toISOString()).slice(0, 10);
  const description = (t.counterpartyName || t.externalMemo || t.note || 'Mercury transaction').slice(0, 200);

  const { data, error } = await db
    .from('finance_entries')
    .insert({
      tenant_id: tenantId,
      entry_type: isExpense ? 'expense' : 'income',
      amount,
      date: dateStr,
      description,
      category: null,  // bookkeeping agent will categorize on its next run
      metadata: {
        source: 'mercury',
        mercury_txn_id: t.id,
        mercury_account_id: t._account_id,
        mercury_account_name: t._account_name,
        counterparty_id: t.counterpartyId || null,
        kind: t.kind || null,
        raw_amount: t.amount,
      },
    })
    .select('id')
    .single();

  if (error) return null;
  return data.id;
}

async function _queueCategorizationItem(tenantId, entryId, txn) {
  await db.from('attention_queue').insert({
    tenant_id: tenantId,
    type: 'categorization_needed',
    severity: 'amber',
    title: `Categorize: ${(txn.counterpartyName || 'Mercury txn').slice(0, 80)} — $${Math.abs(Number(txn.amount)).toFixed(2)}`,
    summary: `Imported from Mercury on ${(txn.postedAt || txn.createdAt || '').slice(0, 10)}. Pick a category or dismiss if non-business.`,
    entity_type: 'finance_entry',
    entity_id: entryId,
    payload: {
      source: 'mercury',
      amount: Number(txn.amount),
      counterparty: txn.counterpartyName,
      account: txn._account_name,
    },
    produced_by: 'mercury-sync',
  });
}

async function run(tenant) {
  const log = createLogger('mercury-sync', tenant.slug);

  if (!_isFgaTenant(tenant)) {
    log.info(`Skipping ${tenant.slug} — Mercury sync is FGA-only`);
    return { success: true, skipped: true, reason: 'not_fga_tenant' };
  }

  if (!mercury.isMercuryConfigured()) {
    log.warn('MERCURY_API_TOKEN not set; skipping run');
    return { success: false, error: 'MERCURY_API_TOKEN missing' };
  }

  // 1. Cash balance → snapshot
  let balance = null;
  try {
    balance = await mercury.getTotalAvailableBalance();
    await _writeCashBalanceSnapshot(tenant.id, balance);
    log.success(`Cash balance synced: $${balance.toLocaleString()}`);
  } catch (err) {
    log.error(`Balance sync failed: ${err.message}`);
  }

  // 2. New transactions → draft expense entries + categorization queue items
  let imported = 0;
  let skipped = 0;
  try {
    const sinceIso = await _lastSyncCutoff(tenant.id);
    log.info(`Pulling transactions since ${sinceIso}`);
    const txns = await mercury.getAllTransactionsSince(sinceIso);

    for (const t of txns) {
      if (await _alreadyImported(tenant.id, t.id)) { skipped++; continue; }
      const entryId = await _createDraftFromMercuryTxn(tenant.id, t);
      if (entryId) {
        await _queueCategorizationItem(tenant.id, entryId, t);
        imported++;
      }
    }
    log.success(`Transactions: ${imported} imported, ${skipped} already on file`);
  } catch (err) {
    log.error(`Transaction sync failed: ${err.message}`);
  }

  return {
    success: true,
    cash_balance: balance,
    transactions_imported: imported,
    transactions_skipped_dup: skipped,
  };
}

module.exports = run;
