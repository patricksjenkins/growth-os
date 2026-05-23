/**
 * Growth OS — Audit Dry-Run Agent
 *
 * Stretch Enhancement #8 of the BI & Financial Sync plan
 * (~/Desktop/FGA/dashboards/bi-sync-strategy.html §8 Tier B).
 *
 * Quarterly agent that simulates what an IRS auditor would flag if they
 * walked in TODAY. Surfaces concerns through the attention_queue so the
 * issues are fixed BEFORE an actual audit — not after.
 *
 * Findings (each becomes an attention_queue item):
 *
 *   - HIGH-PERCENTAGE DEDUCTIONS — categories that exceed Schedule C
 *     industry norms (e.g. Meals & Entertainment >5% of expenses)
 *   - MISSING-RECEIPT COUNT — expenses >$75 with no receipt URL in metadata
 *   - LARGE ROUND-NUMBER EXPENSES — $100, $500, $1000 exact amounts are
 *     more likely to be estimated/forgotten than actual receipts
 *   - PERSONAL-LOOKING VENDORS — Amazon / Apple Store / Walmart purchases
 *     with no explanatory note
 *   - 1099 GAP — contractor paid $600+ in the calendar year but missing
 *     tax_id or address on crew_members
 *   - UNCATEGORIZED EXPENSES — anything still missing a category
 *   - LATE PERIOD CLOSE — any month older than 60 days that hasn't been
 *     formally closed
 *
 * Output: each finding is written as an attention_queue row at severity
 * 'amber' (default) or 'red' (for compliance-fatal items like 1099 gaps).
 *
 * Schedule: 0 7 1 4,7,10,1 * (the 1st of each quarter, 7am ET) —
 * defined in worker/scheduler/cron.js.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');

// Schedule C industry norms (rough — based on SBA + IRS data for service businesses).
// These are caps, not floors — exceeding them invites scrutiny.
const SCHEDULE_C_PCT_CAPS = {
  'Meals & Entertainment': 0.05,
  'Vehicle & Fuel': 0.10,
  'Travel & Conferences': 0.08,
  'Office & Equipment': 0.15,
};

// Vendors that often have personal mixed in
const PERSONAL_LOOKING_VENDORS = [
  /amazon/i, /apple store/i, /walmart/i, /target/i, /costco/i,
  /best buy/i, /home depot/i, /lowe['']?s/i,
];

const MISSING_RECEIPT_THRESHOLD = 75;
const LARGE_ROUND_AMOUNTS = new Set([100, 200, 500, 1000, 2000, 5000]);

async function findHighPctDeductions(tenantId, yearStart, yearEnd) {
  const { data } = await db
    .from('finance_entries')
    .select('amount, category')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'expense')
    .gte('date', yearStart)
    .lte('date', yearEnd);

  if (!data?.length) return [];

  const total = data.reduce((s, r) => s + Number(r.amount || 0), 0);
  const byCat = {};
  for (const r of data) {
    const c = r.category || 'Uncategorized';
    byCat[c] = (byCat[c] || 0) + Number(r.amount || 0);
  }

  const findings = [];
  for (const [cat, cap] of Object.entries(SCHEDULE_C_PCT_CAPS)) {
    const spent = byCat[cat] || 0;
    const pct = total > 0 ? spent / total : 0;
    if (pct > cap) {
      findings.push({
        category: cat,
        spent,
        pct: Number((pct * 100).toFixed(1)),
        cap_pct: cap * 100,
        message: `${cat} is ${(pct * 100).toFixed(1)}% of expenses (cap: ${cap * 100}%) — common audit flag for service businesses.`,
      });
    }
  }
  return findings;
}

async function findMissingReceipts(tenantId, yearStart, yearEnd) {
  const { data } = await db
    .from('finance_entries')
    .select('id, amount, description, date, metadata')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'expense')
    .gte('date', yearStart)
    .lte('date', yearEnd)
    .gte('amount', MISSING_RECEIPT_THRESHOLD);

  return (data || []).filter(r => !r.metadata?.receipt_url);
}

async function findLargeRoundNumbers(tenantId, yearStart, yearEnd) {
  const { data } = await db
    .from('finance_entries')
    .select('id, amount, description, date')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'expense')
    .gte('date', yearStart)
    .lte('date', yearEnd);

  return (data || []).filter(r => LARGE_ROUND_AMOUNTS.has(Number(r.amount)));
}

async function findPersonalLookingVendors(tenantId, yearStart, yearEnd) {
  const { data } = await db
    .from('finance_entries')
    .select('id, amount, description, date, metadata')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'expense')
    .gte('date', yearStart)
    .lte('date', yearEnd);

  return (data || []).filter(r => {
    const desc = (r.description || '').toLowerCase();
    if (!PERSONAL_LOOKING_VENDORS.some(re => re.test(desc))) return false;
    const note = (r.metadata?.business_purpose || '').trim();
    return !note;  // flagged if there's no business-purpose note
  });
}

async function find1099Gaps(tenantId, year) {
  const { data: contractors } = await db
    .from('crew_members')
    .select('id, name, tax_id, address_line1, postal_code')
    .eq('tenant_id', tenantId)
    .eq('is_1099_contractor', true);

  if (!contractors?.length) return [];

  const { data: logs } = await db
    .from('crew_daily_log')
    .select('crew_member_id, total_paid')
    .eq('tenant_id', tenantId)
    .gte('date', `${year}-01-01`)
    .lte('date', `${year}-12-31`);

  const paidById = {};
  for (const l of logs || []) {
    paidById[l.crew_member_id] = (paidById[l.crew_member_id] || 0) + Number(l.total_paid || 0);
  }

  const gaps = [];
  for (const c of contractors) {
    const paid = paidById[c.id] || 0;
    if (paid < 600) continue;
    const missing = [];
    if (!c.tax_id) missing.push('TIN');
    if (!c.address_line1) missing.push('address');
    if (!c.postal_code) missing.push('postal code');
    if (missing.length > 0) {
      gaps.push({ contractor: c.name, paid, missing });
    }
  }
  return gaps;
}

async function findUncategorized(tenantId, yearStart, yearEnd) {
  const { data } = await db
    .from('finance_entries')
    .select('id, amount, description, date', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'expense')
    .gte('date', yearStart)
    .lte('date', yearEnd)
    .or('category.is.null,category.eq.');
  return data || [];
}

async function findLatePeriodCloses(tenantId) {
  // Any month older than 60 days that isn't locked
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);

  const { data: entries } = await db
    .from('finance_entries')
    .select('date')
    .eq('tenant_id', tenantId)
    .lte('date', cutoff.toISOString().slice(0, 10))
    .order('date', { ascending: true })
    .limit(1);

  if (!entries?.length) return [];

  const months = new Set();
  const today = new Date();
  for (let d = new Date(entries[0].date); d <= cutoff; d.setMonth(d.getMonth() + 1)) {
    months.add(d.toISOString().slice(0, 7));
  }

  const { data: locks } = await db
    .from('finance_period_locks')
    .select('period_month, locked_at, reopened_at')
    .eq('tenant_id', tenantId);

  const lockedMonths = new Set();
  for (const l of locks || []) {
    if (l.locked_at && !l.reopened_at) lockedMonths.add(String(l.period_month).slice(0, 7));
  }

  return Array.from(months).filter(m => !lockedMonths.has(m));
}

async function writeFindingToQueue(tenantId, finding) {
  const { error } = await db.from('attention_queue').insert({
    tenant_id: tenantId,
    type: 'audit_dry_run_finding',
    severity: finding.severity || 'amber',
    title: finding.title,
    summary: finding.summary,
    entity_type: finding.entity_type || 'audit_finding',
    entity_id: finding.entity_id || null,
    payload: finding.payload || {},
    produced_by: 'audit-dry-run-agent',
  });
  return !error;
}

/**
 * Main entry. Called by the cron schedule each quarter.
 */
async function run(tenant /*, payload = {} */) {
  const log = createLogger('audit-dry-run', tenant.slug);
  const year = new Date().getUTCFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  log.info(`Audit dry-run for tax year ${year}`);

  let findingsCreated = 0;
  const summary = {
    high_pct_deductions: 0,
    missing_receipts: 0,
    large_round_numbers: 0,
    personal_looking_vendors: 0,
    contractor_1099_gaps: 0,
    uncategorized: 0,
    late_period_closes: 0,
  };

  // 1. High-percentage deductions
  const highPct = await findHighPctDeductions(tenant.id, yearStart, yearEnd);
  for (const f of highPct) {
    if (await writeFindingToQueue(tenant.id, {
      title: `Schedule C flag: ${f.category} is ${f.pct}% of expenses`,
      summary: f.message,
      severity: 'amber',
      payload: f,
    })) findingsCreated++;
  }
  summary.high_pct_deductions = highPct.length;

  // 2. Missing receipts
  const noReceipts = await findMissingReceipts(tenant.id, yearStart, yearEnd);
  if (noReceipts.length > 0) {
    if (await writeFindingToQueue(tenant.id, {
      title: `${noReceipts.length} expenses ≥ $${MISSING_RECEIPT_THRESHOLD} missing receipts`,
      summary: `IRS requires documentation for any expense $75+. Attach receipts via the mobile camera capture flow before year-end.`,
      severity: 'amber',
      payload: { count: noReceipts.length, threshold: MISSING_RECEIPT_THRESHOLD, sample: noReceipts.slice(0, 5).map(r => ({ id: r.id, amount: r.amount, date: r.date })) },
    })) findingsCreated++;
  }
  summary.missing_receipts = noReceipts.length;

  // 3. Large round-number expenses
  const round = await findLargeRoundNumbers(tenant.id, yearStart, yearEnd);
  if (round.length > 0) {
    if (await writeFindingToQueue(tenant.id, {
      title: `${round.length} suspiciously round-number expenses`,
      summary: `Exact $100/$500/$1000 amounts often look estimated rather than receipted. Add the precise amount + receipt to defend against an auditor's "estimate" assumption.`,
      severity: 'amber',
      payload: { sample: round.slice(0, 10).map(r => ({ id: r.id, amount: r.amount, date: r.date, description: r.description })) },
    })) findingsCreated++;
  }
  summary.large_round_numbers = round.length;

  // 4. Personal-looking vendors
  const personal = await findPersonalLookingVendors(tenant.id, yearStart, yearEnd);
  if (personal.length > 0) {
    if (await writeFindingToQueue(tenant.id, {
      title: `${personal.length} Amazon/Apple/Walmart-type purchases without a business-purpose note`,
      summary: `Mixed-use vendors are #1 audit trigger. Add a one-line business purpose to each (in metadata.business_purpose) to defend.`,
      severity: 'amber',
      payload: { sample: personal.slice(0, 10).map(r => ({ id: r.id, amount: r.amount, date: r.date, description: r.description })) },
    })) findingsCreated++;
  }
  summary.personal_looking_vendors = personal.length;

  // 5. 1099 gaps — RED severity (compliance fatal at year-end)
  const gaps = await find1099Gaps(tenant.id, year);
  for (const g of gaps) {
    if (await writeFindingToQueue(tenant.id, {
      title: `1099 gap: ${g.contractor} paid $${Math.round(g.paid)}, missing ${g.missing.join(', ')}`,
      summary: `${g.contractor} crossed the $600 1099-NEC threshold. Collect a W-9 (TIN + address) before January 31, ${year + 1}.`,
      severity: 'red',
      payload: g,
    })) findingsCreated++;
  }
  summary.contractor_1099_gaps = gaps.length;

  // 6. Uncategorized expenses
  const uncat = await findUncategorized(tenant.id, yearStart, yearEnd);
  if (uncat.length > 0) {
    if (await writeFindingToQueue(tenant.id, {
      title: `${uncat.length} uncategorized expenses in tax year ${year}`,
      summary: `Each one is a Schedule C deduction you might lose. Run the categorize action or sweep manually before year-end.`,
      severity: uncat.length > 25 ? 'red' : 'amber',
      payload: { count: uncat.length },
    })) findingsCreated++;
  }
  summary.uncategorized = uncat.length;

  // 7. Late period closes
  const lateMonths = await findLatePeriodCloses(tenant.id);
  if (lateMonths.length > 0) {
    if (await writeFindingToQueue(tenant.id, {
      title: `${lateMonths.length} month${lateMonths.length === 1 ? '' : 's'} older than 60 days not formally closed`,
      summary: `Closing months locks the ledger and protects against retroactive edits. Close: ${lateMonths.slice(0, 6).join(', ')}${lateMonths.length > 6 ? '...' : ''}`,
      severity: 'amber',
      payload: { months: lateMonths },
    })) findingsCreated++;
  }
  summary.late_period_closes = lateMonths.length;

  const totalFindings = Object.values(summary).reduce((a, b) => a + b, 0);
  log.success(`Audit dry-run complete: ${totalFindings} findings, ${findingsCreated} written to attention_queue`, summary);

  return {
    success: true,
    year,
    findings_total: totalFindings,
    findings_written_to_queue: findingsCreated,
    breakdown: summary,
  };
}

module.exports = run;
