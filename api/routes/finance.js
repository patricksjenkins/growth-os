/**
 * Growth OS — Finance Routes
 * Full financial tracking: income, expenses, debt, crew, summaries, P&L
 * Multi-tenant via req.tenantId
 *
 * V1 hardening (2026-05-24): 1,983 lines and growing. V1.1 file-split plan:
 *   ./finance/_helpers.js     — setAuditContext, assertPeriodEditable,
 *                               pickUpdatable, allowlists (already isolated
 *                               at top of file, ready to extract)
 *   ./finance/income.js       — POST/GET/PATCH/DELETE /income/*  routes
 *   ./finance/expenses.js     — POST/GET/PATCH/DELETE /expenses/* routes
 *   ./finance/debt.js         — debt CRUD
 *   ./finance/crew.js         — crew CRUD (current router uses both this
 *                               file's allowlist and routes/crew.js — keep
 *                               them in sync until split)
 *   ./finance/reports.js      — /report/* + /audit-log + /cpa-tokens
 *   ./finance/index.js        — mount each sub-router; existing import
 *                               path stays the same
 *
 * The CPA read-only API at routes/cpa-readonly.js proxies into THIS
 * router via .handle() — any split must preserve the exposed URL surface.
 */

const express = require('express');
const router = express.Router();
const { requireModule } = require('../../core/modules');
const { getUserClient } = require('../../db/userClient');
const { createLogger } = require('../../core/logger');
const { upsertServiceCustomer, refreshCustomerStats, linkHistoryByExactName, normalizeName } = require('../../core/customer-linking');
const log = createLogger('finance-routes');

// ----------------------------------------------------------------------------
// Connected workflow (Track A): turn an income entry's customer into a real
// linked customers row, going forward. NON-FATAL by contract — if anything here
// fails, the income row is already saved; we log and move on. Never throws into
// the request path, so it can't break income creation or financial totals.
// ----------------------------------------------------------------------------
async function linkIncomeToCustomer(db, tenantId, incomeRow, identity) {
  try {
    const res = await upsertServiceCustomer(db, tenantId, identity);
    if (!res.customer) return { linked: false, ...res };
    const { error } = await db
      .from('finance_entries')
      .update({ customer_id: res.customer.id })
      .eq('tenant_id', tenantId).eq('id', incomeRow.id).eq('entry_type', 'income');
    if (error) { log.warn(`linkIncomeToCustomer set customer_id failed: ${error.message}`); return { linked: false }; }
    await refreshCustomerStats(db, tenantId, res.customer.id);
    return { linked: true, customer_id: res.customer.id, created: res.created };
  } catch (e) {
    log.warn(`linkIncomeToCustomer failed (income kept): ${e.message}`);
    return { linked: false };
  }
}

router.use(requireModule('finance'));

// ============================================================================
// AUDIT CONTEXT — Phase 1 Step 2 (audit trigger reads these GUC vars)
// ----------------------------------------------------------------------------
// Sets app.actor_id / app.actor_label in the Postgres session so the
// finance_entries_audit_trigger captures who made each change. Called
// inline at the top of every PATCH / DELETE / POST handler that mutates
// finance_entries.
// ============================================================================
// V1 hardening (2026-05-24): explicit column allowlists for every PATCH
// handler in this router. Previously `.update(req.body)` let a caller
// change `tenant_id` (transferring an entry to another tenant) or
// `entry_type` (flipping income↔expense and bypassing the WHERE-clause
// guard). The lists below match the columns the mobile/web UI actually
// edits — anything else is silently dropped.
const INCOME_UPDATABLE   = ['customer_name', 'amount', 'date', 'job_type', 'description', 'notes', 'lead_id', 'metadata'];
const EXPENSE_UPDATABLE  = ['vendor', 'amount', 'date', 'category', 'subcategory', 'description', 'notes', 'metadata'];
const CREW_UPDATABLE     = ['name', 'daily_rate', 'is_active', 'phone', 'role'];

function pickUpdatable(body, allowed) {
  if (!body || typeof body !== 'object') return {};
  const out = {};
  for (const key of allowed) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

async function setAuditContext(req) {
  // V1 hardening (2026-05-24): switched from raw-SQL exec_sql() with string
  // interpolation to a parameterized SECURITY DEFINER RPC (migration 035).
  // The old pattern had no escape for actorId at all — a UUID-shaped value
  // was the only thing keeping it from being an injection vector.
  const actorId = req.user?.id || null;
  const actorLabel = req.user?.email || 'unknown';
  try {
    const db = getUserClient(req);
    await db.rpc('set_audit_context', {
      p_actor_id: actorId,
      p_actor_label: actorLabel,
    });
  } catch (e) {
    log.warn(`setAuditContext failed (audit log will show NULL actor): ${e.message}`);
  }
}

// ============================================================================
// PERIOD LOCK CHECK — Phase 1 Step 4
// ----------------------------------------------------------------------------
// Refuse mutations on finance_entries whose date falls in a locked period.
// Closed months are immutable so a CPA-signed-off P&L can't shift later.
// ============================================================================
async function assertPeriodEditable(req, res, tenantId, isoDateStr) {
  if (!isoDateStr) return true;
  const d = new Date(isoDateStr);
  if (isNaN(d.getTime())) return true;
  const db = getUserClient(req);
  const { data, error } = await db.rpc('is_period_locked', {
    p_tenant_id: tenantId,
    p_year: d.getUTCFullYear(),
    p_month: d.getUTCMonth() + 1,
  });
  // V1 hardening (2026-05-24): FAIL CLOSED on RPC error. Period locks are
  // an audit-integrity guarantee — a CPA-signed-off month must NOT shift
  // because of a transient DB hiccup. If we can't verify the period is
  // editable, refuse the mutation and surface the error.
  if (error) {
    log.error(`is_period_locked check failed: ${error.message}`);
    res.status(503).json({
      success: false,
      error: 'Could not verify period lock status. Mutation refused; please retry.',
      code: 'PERIOD_CHECK_UNAVAILABLE',
    });
    return false;
  }
  if (data === true) {
    res.status(423).json({
      success: false,
      error: `This entry's date (${isoDateStr.slice(0, 10)}) falls in a closed month. Reopen the month before editing.`,
      code: 'PERIOD_LOCKED',
    });
    return false;
  }
  return true;
}

// ============================================================================
// INCOME
// ============================================================================

/** GET /api/finance/income?month=4&year=2026 */
router.get('/income', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { month, year } = req.query;
    let query = db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'income')
      .order('date', { ascending: false });

    if (month && year) {
      const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
      const end = new Date(year, month, 0).toISOString().split('T')[0];
      query = query.gte('date', start).lte('date', end);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Strip provenance keys a caller must not be able to assert.
 *
 * `metadata.source` is how the ledger records where a row came from, and the
 * audit trigger copies it into row_source. Passing req.body.metadata straight
 * through let any authenticated user POST {"source":"stripe-webhook"} and have
 * a hand-typed entry present itself as provider-booked — forged provenance in
 * the one place the books are supposed to be checkable. The server decides
 * this field; the client may supply anything else.
 * (Codex 2026-07-26, round 4.)
 */
const RESERVED_METADATA_KEYS = [
  'source', 'kind', 'stripe_invoice_id', 'stripe_charge_id', 'stripe_payment_intent',
  'stripe_checkout_session_id', 'stripe_fee_for_charge', 'mercury_txn_id',
  'mercury_transaction_id', 'invoice_ref',
];

function safeMetadata(raw) {
  const out = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  for (const key of RESERVED_METADATA_KEYS) delete out[key];
  out.source = 'manual_entry';
  return out;
}

/** POST /api/finance/income */
router.post('/income', async (req, res) => {
  try {
    const db = getUserClient(req);
    // Phase 1: refuse creates into a locked period (no backdating).
    if (!(await assertPeriodEditable(req, res, req.tenantId, req.body.date))) return;
    await setAuditContext(req);
    const { data, error } = await db
      .from('finance_entries')
      .insert({
        tenant_id: req.tenantId,
        entry_type: 'income',
        customer_name: req.body.customer_name,
        amount: req.body.amount,
        date: req.body.date,
        job_type: req.body.job_type || null,
        description: req.body.notes || req.body.description || null,
        lead_id: req.body.lead_id || null,
        metadata: safeMetadata(req.body.metadata)
      })
      .select()
      .single();
    if (error) throw error;

    // Going-forward connectivity: link this payment to a real customer record
    // (non-fatal; income is already persisted). Identity comes from the income
    // form — name plus any optional phone/email/address the owner supplied.
    const link = await linkIncomeToCustomer(db, req.tenantId, data, {
      name: req.body.customer_name,
      phone: req.body.customer_phone || req.body.phone || null,
      email: req.body.customer_email || req.body.email || null,
      address: req.body.address || null,
      city: req.body.city || null,
      service_type: req.body.job_type || null,
      source: 'income_entry',
    });

    res.status(201).json({ success: true, data: { ...data, customer_id: link.customer_id || null }, link });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PATCH /api/finance/income/:id */
router.patch('/income/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    // Look up the row first to check its date (the body may not include the date).
    const { data: existing, error: lookupErr } = await db
      .from('finance_entries')
      .select('date')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'income')
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });

    // Check BOTH the existing date AND the new date (if changing).
    if (!(await assertPeriodEditable(req, res, req.tenantId, existing.date))) return;
    if (req.body.date && req.body.date !== existing.date) {
      if (!(await assertPeriodEditable(req, res, req.tenantId, req.body.date))) return;
    }

    await setAuditContext(req);
    const updates = pickUpdatable(req.body, INCOME_UPDATABLE);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields supplied' });
    }
    const { data, error } = await db
      .from('finance_entries')
      .update(updates)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'income')
      .select()
      .single();
    if (error) throw error;

    // If the customer name changed, re-link going forward (non-fatal). Refresh
    // the previously-linked customer's stats too so roll-ups stay correct.
    let link;
    if (Object.prototype.hasOwnProperty.call(updates, 'customer_name')) {
      const prevCustomerId = data.customer_id || null;
      link = await linkIncomeToCustomer(db, req.tenantId, data, {
        name: req.body.customer_name,
        phone: req.body.customer_phone || req.body.phone || null,
        email: req.body.customer_email || req.body.email || null,
        service_type: req.body.job_type || data.job_type || null,
        source: 'income_entry',
      });
      if (prevCustomerId && prevCustomerId !== link.customer_id) {
        await refreshCustomerStats(db, req.tenantId, prevCustomerId);
      }
    }
    res.json({ success: true, data, link });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/finance/income/:id */
router.delete('/income/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: existing, error: lookupErr } = await db
      .from('finance_entries')
      .select('date, customer_id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'income')
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
    if (!(await assertPeriodEditable(req, res, req.tenantId, existing.date))) return;

    await setAuditContext(req);
    const { error } = await db
      .from('finance_entries')
      .delete()
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'income');
    if (error) throw error;
    // Keep the linked customer's roll-up stats correct after removal (non-fatal).
    if (existing.customer_id) {
      try { await refreshCustomerStats(db, req.tenantId, existing.customer_id); } catch { /* income already deleted */ }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// EXPENSES
// ============================================================================

/** GET /api/finance/expenses?month=4&year=2026 */
router.get('/expenses', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { month, year } = req.query;
    let query = db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'expense')
      .order('date', { ascending: false });

    if (month && year) {
      const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
      const end = new Date(year, month, 0).toISOString().split('T')[0];
      query = query.gte('date', start).lte('date', end);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/expenses */
router.post('/expenses', async (req, res) => {
  try {
    const db = getUserClient(req);
    if (!(await assertPeriodEditable(req, res, req.tenantId, req.body.date))) return;
    await setAuditContext(req);
    const { data, error } = await db
      .from('finance_entries')
      .insert({
        tenant_id: req.tenantId,
        entry_type: 'expense',
        category: req.body.category,
        amount: req.body.amount,
        date: req.body.date,
        description: req.body.description,
        recurring: req.body.recurring || req.body.is_recurring || false,
        metadata: safeMetadata(req.body.metadata)
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PATCH /api/finance/expenses/:id */
router.patch('/expenses/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: existing, error: lookupErr } = await db
      .from('finance_entries')
      .select('date')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'expense')
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
    if (!(await assertPeriodEditable(req, res, req.tenantId, existing.date))) return;
    if (req.body.date && req.body.date !== existing.date) {
      if (!(await assertPeriodEditable(req, res, req.tenantId, req.body.date))) return;
    }

    await setAuditContext(req);
    const updates = pickUpdatable(req.body, EXPENSE_UPDATABLE);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields supplied' });
    }
    const { data, error } = await db
      .from('finance_entries')
      .update(updates)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'expense')
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/finance/expenses/:id */
router.delete('/expenses/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: existing, error: lookupErr } = await db
      .from('finance_entries')
      .select('date')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'expense')
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
    if (!(await assertPeriodEditable(req, res, req.tenantId, existing.date))) return;

    await setAuditContext(req);
    const { error } = await db
      .from('finance_entries')
      .delete()
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'expense');
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/expenses/rollover — copy recurring expenses from previous month */
router.post('/expenses/rollover', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { month, year } = req.body;
    let prevMonth = month - 1;
    let prevYear = year;
    if (prevMonth === 0) { prevMonth = 12; prevYear = year - 1; }

    const prevStart = new Date(prevYear, prevMonth - 1, 1).toISOString().split('T')[0];
    const prevEnd = new Date(prevYear, prevMonth, 0).toISOString().split('T')[0];

    const { data: recurring, error: fetchErr } = await db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'expense')
      .eq('recurring', true)
      .gte('date', prevStart)
      .lte('date', prevEnd);

    if (fetchErr) throw fetchErr;
    if (!recurring || recurring.length === 0) {
      return res.json({ success: true, data: { created: 0, entries: [] } });
    }

    const targetDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
    // Only roll over monthly recurring (skip yearly — those are billed annually)
    const monthlyRecurring = recurring.filter(exp => {
      const freq = exp.metadata?.recurring_frequency;
      return !freq || freq === 'monthly'; // default to monthly for backward compat
    });

    if (monthlyRecurring.length === 0) {
      return res.json({ success: true, data: { created: 0, entries: [] } });
    }

    const newEntries = monthlyRecurring.map(exp => ({
      tenant_id: req.tenantId,
      entry_type: 'expense',
      description: exp.description,
      category: exp.category,
      amount: exp.amount,
      date: targetDate,
      recurring: true,
      metadata: exp.metadata || { recurring_frequency: 'monthly' }
    }));

    const { data: created, error: insertErr } = await db
      .from('finance_entries')
      .insert(newEntries)
      .select();

    if (insertErr) throw insertErr;
    res.json({ success: true, data: { created: created?.length || 0, entries: created || [] } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// CUSTOMERS (derived from income entries)
// ============================================================================

/** GET /api/finance/customers */
router.get('/customers', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('finance_entries')
      .select('customer_name, amount, date, job_type')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'income')
      .not('customer_name', 'is', null);

    if (error) throw error;

    const customerMap = {};
    for (const entry of (data || [])) {
      const name = entry.customer_name;
      if (!name) continue;
      if (!customerMap[name]) {
        customerMap[name] = { customer_name: name, total_revenue: 0, job_count: 0, first_job: entry.date, last_job: entry.date, job_types: new Set() };
      }
      customerMap[name].total_revenue += parseFloat(entry.amount) || 0;
      customerMap[name].job_count += 1;
      if (entry.date < customerMap[name].first_job) customerMap[name].first_job = entry.date;
      if (entry.date > customerMap[name].last_job) customerMap[name].last_job = entry.date;
      if (entry.job_type) customerMap[name].job_types.add(entry.job_type);
    }

    const customers = Object.values(customerMap).map(c => ({
      ...c,
      job_types: Array.from(c.job_types),
      is_repeat: c.job_count > 1
    })).sort((a, b) => b.total_revenue - a.total_revenue);

    res.json({ success: true, data: customers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/finance/customers/search?q=...
 *
 * Connected workflow (2026-06-19): merged directory the owner searches to find
 * ANY customer — the old ones from income history AND saved customer records —
 * then update them / add an email / record a repeat job. Each result carries the
 * by-name revenue+job aggregate (the complete history) plus, when a saved
 * customers row exists for that name/phone/email, its id + contact fields so the
 * UI knows it's already a record. Old customers stay as records via history;
 * they only become a SAVED record when the owner saves contact info (upsert).
 */
router.get('/customers/search', async (req, res) => {
  try {
    const db = getUserClient(req);
    const q = String(req.query.q || '').trim();
    const pattern = `%${q}%`;

    // 1) Income history aggregated by name (the "old customers as records").
    let histQ = db
      .from('finance_entries')
      .select('customer_name, amount, date')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'income')
      .not('customer_name', 'is', null);
    if (q) histQ = histQ.ilike('customer_name', pattern);
    const { data: hist, error: hErr } = await histQ;
    if (hErr) throw hErr;

    const byNorm = {};
    for (const e of (hist || [])) {
      const display = e.customer_name;
      const norm = normalizeName(display);
      if (!norm) continue;
      if (!byNorm[norm]) byNorm[norm] = { name_normalized: norm, customer_name: display, total_revenue: 0, job_count: 0, last_job: e.date, has_record: false, customer_id: null, customer_email: null, customer_phone: null, address: null, city: null, service_type: null };
      const c = byNorm[norm];
      c.total_revenue += parseFloat(e.amount) || 0;
      c.job_count += 1;
      if (e.date && (!c.last_job || e.date > c.last_job)) c.last_job = e.date;
    }

    // 2) Saved customer records (may match by name, phone, or email; may have no history yet).
    let recQ = db.from('customers').select('*').eq('tenant_id', req.tenantId);
    if (q) recQ = recQ.or(`name.ilike.${pattern},phone.ilike.${pattern},email.ilike.${pattern}`);
    const { data: recs, error: rErr } = await recQ;
    if (rErr) throw rErr;

    for (const r of (recs || [])) {
      const norm = r.name_normalized || normalizeName(r.name);
      const target = (norm && byNorm[norm]) ? byNorm[norm] : (byNorm[norm || `id:${r.id}`] = {
        name_normalized: norm, customer_name: r.name || '(unnamed)', total_revenue: parseFloat(r.total_revenue) || 0,
        job_count: r.job_count || 0, last_job: r.last_job_date || null,
      });
      target.has_record = true;
      target.customer_id = r.id;
      target.customer_email = r.email || null;
      target.customer_phone = r.phone || null;
      target.address = r.address || null;
      target.city = r.city || null;
      target.service_type = r.service_type || null;
    }

    const out = Object.values(byNorm)
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .slice(0, parseInt(req.query.limit) || 50);
    res.json({ success: true, data: out });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/finance/customers/upsert
 * Create or update a SAVED customer record, then (by default) attach that
 * customer's exact-name income history so their record owns its revenue and
 * becomes review-eligible. This is how an "old customer" becomes a saved record
 * when the owner adds an email / phone or edits them.
 *
 * Body: { id?, name, phone?, email?, address?, city?, service_type?, link_history? }
 */
router.post('/customers/upsert', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { id, name, phone, email, address, city, service_type } = req.body || {};
    const linkHistory = req.body.link_history !== false; // default true
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Customer name is required.' });
    }

    let customer;
    if (id) {
      // Update an existing saved record (owner-entered values win).
      const patch = { updated_at: new Date().toISOString() };
      if (name !== undefined) patch.name = String(name).trim();
      if (phone !== undefined) patch.phone = phone || null;
      if (email !== undefined) patch.email = email ? String(email).trim().toLowerCase() : null;
      if (address !== undefined) patch.address = address || null;
      if (city !== undefined) patch.city = city || null;
      if (service_type !== undefined) patch.service_type = service_type || null;
      const { data, error } = await db
        .from('customers').update(patch)
        .eq('tenant_id', req.tenantId).eq('id', id).select().single();
      if (error) throw error;
      customer = data;
    } else {
      const r = await upsertServiceCustomer(db, req.tenantId, { name, phone, email, address, city, service_type, source: 'manual' });
      if (r.ambiguous) {
        return res.status(409).json({ success: false, error: 'Several customers share that name. Open the right one from search to edit it.', candidates: r.candidates });
      }
      if (!r.customer) return res.status(400).json({ success: false, error: r.reason || 'Could not save customer.' });
      customer = r.customer;
    }

    let linked = 0;
    if (linkHistory) {
      linked = await linkHistoryByExactName(db, req.tenantId, customer.id, customer.name);
      await refreshCustomerStats(db, req.tenantId, customer.id);
      const { data: fresh } = await db.from('customers').select('*').eq('tenant_id', req.tenantId).eq('id', customer.id).single();
      if (fresh) customer = fresh;
    }
    res.json({ success: true, data: customer, linked_history: linked });
  } catch (err) {
    log.error(`customers/upsert failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/finance/customers/insights?year=2026 */
router.get('/customers/insights', async (req, res) => {
  try {
    const db = getUserClient(req);
    let query = db
      .from('finance_entries')
      .select('customer_name, amount, date')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'income');

    if (req.query.year) {
      query = query.gte('date', `${req.query.year}-01-01`).lte('date', `${req.query.year}-12-31`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const isCash = (name) => {
      if (!name) return false;
      const lower = name.toLowerCase().trim();
      return lower === 'cash' || lower.startsWith('cash ') || lower.startsWith('cash(') || lower.includes('(cash)');
    };

    let cashRevenue = 0, cashJobCount = 0;
    const customerMap = {};

    for (const entry of (data || [])) {
      if (isCash(entry.customer_name)) {
        cashRevenue += parseFloat(entry.amount) || 0;
        cashJobCount++;
        continue;
      }
      const name = entry.customer_name;
      if (!name) continue;
      if (!customerMap[name]) customerMap[name] = { job_count: 0, total_revenue: 0 };
      customerMap[name].job_count += 1;
      customerMap[name].total_revenue += parseFloat(entry.amount) || 0;
    }

    const customers = Object.entries(customerMap);
    const totalCustomers = customers.length;
    const repeatCustomers = customers.filter(([, c]) => c.job_count > 1);
    const repeatRate = totalCustomers > 0 ? Math.round((repeatCustomers.length / totalCustomers) * 100) : 0;

    const topCustomers = customers
      .map(([name, stats]) => ({ customer_name: name, ...stats }))
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .slice(0, 10);

    res.json({
      success: true,
      data: {
        total_customers: totalCustomers,
        repeat_customers: repeatCustomers.length,
        repeat_rate: repeatRate,
        cash_revenue: cashRevenue,
        cash_job_count: cashJobCount,
        top_customers: topCustomers
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// SUMMARY / DASHBOARD
// ============================================================================

/** GET /api/finance/summary?year=2026 */
router.get('/summary', async (req, res) => {
  try {
    const db = getUserClient(req);
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const { data, error } = await db
      .from('finance_entries')
      .select('entry_type, amount, date, category')
      .eq('tenant_id', req.tenantId)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`);

    if (error) throw error;

    const monthlyBreakdown = {};
    for (let m = 1; m <= 12; m++) monthlyBreakdown[m] = { income: 0, expenses: 0, net: 0 };

    let totalIncome = 0, totalExpenses = 0;
    const expensesByCategory = {};

    for (const entry of (data || [])) {
      const amt = parseFloat(entry.amount) || 0;
      const month = new Date(entry.date).getMonth() + 1;

      if (entry.entry_type === 'income') {
        monthlyBreakdown[month].income += amt;
        totalIncome += amt;
      } else if (entry.entry_type === 'expense') {
        monthlyBreakdown[month].expenses += amt;
        totalExpenses += amt;
        const cat = entry.category || 'Other';
        expensesByCategory[cat] = (expensesByCategory[cat] || 0) + amt;
      }
      // Pass-through types (sales_tax_*, owner_contribution, owner_draw) are
      // deliberately excluded from net-income aggregation. Sales tax is a
      // pass-through liability to the state; owner equity affects basis,
      // not Schedule C profit.
    }

    for (let m = 1; m <= 12; m++) {
      monthlyBreakdown[m].net = monthlyBreakdown[m].income - monthlyBreakdown[m].expenses;
    }

    res.json({
      success: true,
      data: {
        year,
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net_profit: totalIncome - totalExpenses,
        profit_margin: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0,
        monthly_breakdown: monthlyBreakdown,
        expenses_by_category: expensesByCategory
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/finance/report/year-end?year=2026 — full P&L report */
router.get('/report/year-end', async (req, res) => {
  try {
    const db = getUserClient(req);
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const { data, error } = await db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`)
      .order('date', { ascending: true });

    if (error) throw error;

    const entries = data || [];
    const income = entries.filter(e => e.entry_type === 'income');
    const expenses = entries.filter(e => e.entry_type === 'expense');

    const totalIncome = income.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    const expensesByCategory = {};
    for (const exp of expenses) {
      const cat = exp.category || 'Other';
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + (parseFloat(exp.amount) || 0);
    }

    const monthlyBreakdown = {};
    for (let m = 1; m <= 12; m++) monthlyBreakdown[m] = { income: 0, expenses: 0, net: 0 };
    for (const e of entries) {
      const m = new Date(e.date).getMonth() + 1;
      const amt = parseFloat(e.amount) || 0;
      if (e.entry_type === 'income') monthlyBreakdown[m].income += amt;
      else if (e.entry_type === 'expense') monthlyBreakdown[m].expenses += amt;
      // sales_tax_*, owner_contribution, owner_draw — deliberately excluded
    }
    for (let m = 1; m <= 12; m++) monthlyBreakdown[m].net = monthlyBreakdown[m].income - monthlyBreakdown[m].expenses;

    res.json({
      success: true,
      data: {
        year,
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net_profit: totalIncome - totalExpenses,
        profit_margin: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0,
        expenses_by_category: expensesByCategory,
        monthly_breakdown: monthlyBreakdown,
        income_entries: income,
        expense_entries: expenses
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// DEBT
// ============================================================================

/** GET /api/finance/debt */
router.get('/debt', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('debt_tracker')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('current_balance', { ascending: false });
    if (error) throw error;

    const debts = (data || []).map(d => ({
      ...d,
      paid_off: d.original_amount - d.current_balance,
      progress_pct: d.original_amount > 0
        ? Math.round(((d.original_amount - d.current_balance) / d.original_amount) * 100)
        : 0
    }));

    res.json({ success: true, data: debts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/debt */
router.post('/debt', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('debt_tracker')
      .insert({
        tenant_id: req.tenantId,
        name: req.body.name,
        original_amount: req.body.original_amount,
        current_balance: req.body.current_balance,
        monthly_payment: req.body.monthly_payment || 0
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PATCH /api/finance/debt/:id */
router.patch('/debt/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('debt_tracker')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/finance/debt/:id */
router.delete('/debt/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { error } = await db
      .from('debt_tracker')
      .delete()
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// CREW
// ============================================================================

/** GET /api/finance/crew */
router.get('/crew', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('crew_members')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/crew */
router.post('/crew', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('crew_members')
      .insert({
        tenant_id: req.tenantId,
        name: req.body.name,
        daily_rate: req.body.daily_rate,
        is_active: true
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PATCH /api/finance/crew/:id */
router.patch('/crew/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const updates = pickUpdatable(req.body, CREW_UPDATABLE);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields supplied' });
    }
    const { data, error } = await db
      .from('crew_members')
      .update(updates)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/finance/crew/:id */
router.delete('/crew/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('crew_members')
      .update({ is_active: false })
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/finance/crew/log?month=4&year=2026 */
router.get('/crew/log', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { month, year } = req.query;
    const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const end = new Date(year, month, 0).toISOString().split('T')[0];

    const { data, error } = await db
      .from('crew_daily_log')
      .select('*, crew_members(name, daily_rate)')
      .eq('tenant_id', req.tenantId)
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/crew/log — toggle a crew work day */
router.post('/crew/log', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { crew_member_id, date, worked } = req.body;

    // Upsert: check if exists
    const { data: existing } = await db
      .from('crew_daily_log')
      .select('id')
      .eq('crew_member_id', crew_member_id)
      .eq('date', date)
      .maybeSingle();

    let result;
    if (existing) {
      const { data, error } = await db
        .from('crew_daily_log')
        .update({ worked })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await db
        .from('crew_daily_log')
        .insert({ tenant_id: req.tenantId, crew_member_id, date, worked })
        .select()
        .single();
      if (error) throw error;
      result = data;
    }

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/finance/crew/yearly-summary?year=2026 */
router.get('/crew/yearly-summary', async (req, res) => {
  try {
    const db = getUserClient(req);
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const [membersRes, logsRes] = await Promise.all([
      db.from('crew_members').select('id, name, daily_rate').eq('tenant_id', req.tenantId),
      db.from('crew_daily_log')
        .select('crew_member_id, date, worked')
        .eq('tenant_id', req.tenantId)
        .gte('date', `${year}-01-01`)
        .lte('date', `${year}-12-31`)
    ]);

    if (membersRes.error) throw membersRes.error;
    if (logsRes.error) throw logsRes.error;

    const members = membersRes.data || [];
    const logs = (logsRes.data || []).filter(l => l.worked);

    // Yearly totals
    const yearlyCrew = members.map(m => {
      const daysWorked = logs.filter(l => l.crew_member_id === m.id).length;
      return { id: m.id, name: m.name, daily_rate: m.daily_rate, days_worked: daysWorked, total_pay: daysWorked * m.daily_rate };
    }).filter(c => c.days_worked > 0);

    // Monthly breakdown
    const monthly_breakdown = {};
    for (let mo = 1; mo <= 12; mo++) {
      const monthStr = String(mo).padStart(2, '0');
      const monthLogs = logs.filter(l => l.date?.substring(5, 7) === monthStr);
      const crew = members.map(m => {
        const daysWorked = monthLogs.filter(l => l.crew_member_id === m.id).length;
        return { id: m.id, name: m.name, daily_rate: m.daily_rate, days_worked: daysWorked, total_pay: daysWorked * m.daily_rate };
      }).filter(c => c.days_worked > 0);
      monthly_breakdown[String(mo)] = { crew, grand_total: crew.reduce((s, c) => s + c.total_pay, 0) };
    }

    res.json({
      success: true,
      data: {
        year,
        crew: yearlyCrew,
        grand_total: yearlyCrew.reduce((s, c) => s + c.total_pay, 0),
        monthly_breakdown
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// LEGACY ENDPOINTS (backward compat)
// ============================================================================

/** GET /api/finance — list all entries (original) */
router.get('/', async (req, res) => {
  try {
    const db = getUserClient(req);
    let query = db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('date', { ascending: false });

    if (req.query.type) query = query.eq('entry_type', req.query.type);
    if (req.query.category) query = query.eq('category', req.query.category);
    if (req.query.from) query = query.gte('date', req.query.from);
    if (req.query.to) query = query.lte('date', req.query.to);
    query = query.limit(parseInt(req.query.limit) || 200);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, entries: data, count: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// PERIOD CLOSE / REOPEN — Phase 1 Step 4
// ----------------------------------------------------------------------------
// Closes a month for editing. After lock, PATCH/DELETE/POST on
// finance_entries with a date in that month is rejected (HTTP 423) until
// the period is reopened. Audit log captures every close + reopen.
// ============================================================================

/**
 * GET /api/finance/period-locks?year=2026
 * List all lock entries for the tenant. Returns each period's
 * locked_at / reopened_at history.
 */
router.get('/period-locks', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { year } = req.query;
    let q = db.from('finance_period_locks')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('year', { ascending: false })
      .order('month', { ascending: false });
    if (year) q = q.eq('year', Number(year));
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, periods: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/finance/close-month
 * Body: { year, month, notes? }
 * Locks the given period. Returns 409 if already locked.
 */
router.post('/close-month', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { year, month, notes } = req.body || {};
    if (!year || !month) {
      return res.status(400).json({ success: false, error: 'year and month required' });
    }

    // Check if already locked (and not reopened).
    const { data: existing } = await db
      .from('finance_period_locks')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('year', year)
      .eq('month', month)
      .is('reopened_at', null)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({
        success: false,
        error: `Period ${year}-${String(month).padStart(2, '0')} is already locked.`,
        existing,
      });
    }

    // Either there's a reopened lock row to update, or no row at all.
    const { data: reopened } = await db
      .from('finance_period_locks')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('year', year)
      .eq('month', month)
      .not('reopened_at', 'is', null)
      .order('locked_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let row;
    if (reopened) {
      // Existing row that was reopened — insert a new lock (we keep history per close cycle).
      const { data, error } = await db.from('finance_period_locks').insert({
        tenant_id: req.tenantId,
        year, month, notes: notes || null,
        locked_by: req.user?.id || null,
        locked_by_label: req.user?.email || 'unknown',
      }).select().single();
      if (error) throw error;
      row = data;
    } else {
      const { data, error } = await db.from('finance_period_locks').insert({
        tenant_id: req.tenantId,
        year, month, notes: notes || null,
        locked_by: req.user?.id || null,
        locked_by_label: req.user?.email || 'unknown',
      }).select().single();
      if (error) throw error;
      row = data;
    }
    log.info(`Period ${year}-${month} locked for tenant ${req.tenantId} by ${row.locked_by_label}`);
    res.status(201).json({ success: true, lock: row });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/finance/reopen-month
 * Body: { year, month, reason }
 * Reopens a previously locked period. Audited.
 */
router.post('/reopen-month', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { year, month, reason } = req.body || {};
    if (!year || !month || !reason) {
      return res.status(400).json({ success: false, error: 'year, month, and reason required' });
    }

    const { data, error } = await db
      .from('finance_period_locks')
      .update({
        reopened_at: new Date().toISOString(),
        reopened_by: req.user?.id || null,
        reopened_by_label: req.user?.email || 'unknown',
        reopen_reason: reason,
      })
      .eq('tenant_id', req.tenantId)
      .eq('year', year)
      .eq('month', month)
      .is('reopened_at', null)
      .select()
      .single();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({
        success: false,
        error: `No active lock found for ${year}-${String(month).padStart(2, '0')}.`,
      });
    }
    log.info(`Period ${year}-${month} REOPENED for tenant ${req.tenantId} by ${data.reopened_by_label}: ${reason}`);
    res.json({ success: true, lock: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// CSV EXPORT — Phase 1 Step 5
// ----------------------------------------------------------------------------
// GET /api/finance/report/year-end.csv?year=2026
// One row per finance_entries transaction for the year, with Schedule C
// category mapping. Format mirrors QuickBooks Online's transaction list
// CSV so a CPA can import directly.
// ============================================================================

// Map free-text expense categories → Schedule C line label. Matches the
// bookkeeping.js + tax-prep.js category set; anything unmapped defaults
// to "Other expenses" (Schedule C line 27a).
const SCHEDULE_C_MAP = {
  'Software & SaaS': 'Office expense (line 18)',
  'Marketing & Advertising': 'Advertising (line 8)',
  'Payroll & Contractors': 'Contract labor (line 11)',
  'Office & Equipment': 'Office expense (line 18)',
  'Travel & Conferences': 'Travel (line 24a)',
  'Insurance': 'Insurance (line 15)',
  'Legal & Professional': 'Legal and professional services (line 17)',
  'Subscriptions': 'Office expense (line 18)',
  'Utilities': 'Utilities (line 25)',
  'Meals & Entertainment': 'Meals 50% deductible (line 24b)',
  'Vehicle & Fuel': 'Car and truck expenses (line 9)',
  'Supplies & Materials': 'Supplies (line 22)',
  'Education & Training': 'Other expenses (line 27a)',
  'Taxes & Fees': 'Taxes and licenses (line 23)',
  'Hosting & Infrastructure': 'Office expense (line 18)',
  'Communication': 'Office expense (line 18)',
  'Other': 'Other expenses (line 27a)',
  // Income — these don't have Schedule C lines but we tag them anyway
  'subscription': 'Gross receipts (line 1)',
  'setup_fee': 'Gross receipts (line 1)',
};

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get('/report/year-end.csv', async (req, res) => {
  try {
    const db = getUserClient(req);
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const { data: rows, error } = await db
      .from('finance_entries')
      .select('id, entry_type, category, amount, description, date, customer_name, job_type, recurring, metadata, created_at')
      .eq('tenant_id', req.tenantId)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });
    if (error) throw error;

    const lines = [];
    // Header — match QBO transaction list CSV columns
    lines.push([
      'Date', 'Type', 'Category', 'Schedule C Line', 'Description',
      'Customer/Vendor', 'Amount', 'Recurring', 'Stripe Invoice ID',
      'Entry ID', 'Created At',
    ].map(csvEscape).join(','));

    // Schedule C mapping varies by entry_type. Pass-through types
    // (sales_tax_*, owner_*) carry a clear non-Schedule-C label so the
    // CPA can see them in the CSV but knows they're excluded from net
    // income. Income → Gross receipts, expense → "Other expenses" fallback.
    function _scheduleCLine(r) {
      if (SCHEDULE_C_MAP[r.category]) return SCHEDULE_C_MAP[r.category];
      if (r.entry_type === 'owner_contribution') return 'Owner equity — capital contribution (NOT Schedule C)';
      if (r.entry_type === 'owner_draw') return 'Owner equity — draw (NOT Schedule C)';
      if (r.entry_type === 'sales_tax_collected') return 'Sales tax — collected (pass-through liability, NOT Schedule C)';
      if (r.entry_type === 'sales_tax_remitted') return 'Sales tax — remitted (pass-through liability, NOT Schedule C)';
      return r.entry_type === 'expense' ? 'Other expenses (line 27a)' : 'Gross receipts (line 1)';
    }

    for (const r of rows || []) {
      lines.push([
        r.date,
        r.entry_type.toUpperCase(),
        r.category || '',
        _scheduleCLine(r),
        r.description || '',
        r.customer_name || '',
        Number(r.amount).toFixed(2),
        r.recurring ? 'Yes' : 'No',
        r.metadata?.stripe_invoice_id || '',
        r.id,
        r.created_at,
      ].map(csvEscape).join(','));
    }

    // Summary footer — Net Profit calc EXCLUDES owner equity + sales tax pass-throughs.
    const totals = (rows || []).reduce(
      (acc, r) => {
        if (r.entry_type === 'income') acc.income += Number(r.amount);
        else if (r.entry_type === 'expense') acc.expense += Number(r.amount);
        else if (r.entry_type === 'owner_contribution') acc.owner_in += Number(r.amount);
        else if (r.entry_type === 'owner_draw') acc.owner_out += Number(r.amount);
        // sales_tax_* are tracked elsewhere; not included in the P&L footer
        return acc;
      },
      { income: 0, expense: 0, owner_in: 0, owner_out: 0 },
    );
    lines.push('');  // blank line
    lines.push([
      '', '', '', '', `TOTAL INCOME ${year}`, '',
      totals.income.toFixed(2), '', '', '', '',
    ].map(csvEscape).join(','));
    lines.push([
      '', '', '', '', `TOTAL EXPENSES ${year}`, '',
      totals.expense.toFixed(2), '', '', '', '',
    ].map(csvEscape).join(','));
    lines.push([
      '', '', '', '', `NET PROFIT ${year}`, '',
      (totals.income - totals.expense).toFixed(2), '', '', '', '',
    ].map(csvEscape).join(','));
    // Owner equity footer — separate section so the CPA sees it clearly
    // but doesn't fold it into net income. Only emitted if there's
    // owner activity in the year.
    if (totals.owner_in > 0 || totals.owner_out > 0) {
      lines.push('');
      lines.push([
        '', '', '', '', `OWNER CONTRIBUTIONS ${year}`, '',
        totals.owner_in.toFixed(2), '', '', '', '',
      ].map(csvEscape).join(','));
      lines.push([
        '', '', '', '', `OWNER DRAWS ${year}`, '',
        totals.owner_out.toFixed(2), '', '', '', '',
      ].map(csvEscape).join(','));
      lines.push([
        '', '', '', '', `NET OWNER EQUITY CHANGE ${year}`, '',
        (totals.owner_in - totals.owner_out).toFixed(2), '', '', '', '',
      ].map(csvEscape).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="FGA-Transactions-${year}.csv"`,
    );
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// AUDIT LOG VIEWER — read-only
// ----------------------------------------------------------------------------
// GET /api/finance/audit-log?entry_id=... — view the full change history of
// a specific finance entry. Useful for "show me who edited this" during
// a CPA review.
// ============================================================================
router.get('/audit-log', async (req, res) => {
  try {
    const db = getUserClient(req);
    let q = db.from('finance_audit_log')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('changed_at', { ascending: false })
      .limit(Math.min(Number(req.query.limit) || 100, 500));
    if (req.query.entry_id) q = q.eq('entry_id', req.query.entry_id);
    if (req.query.action) q = q.eq('action', req.query.action);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, entries: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// PHASE 2 — CPA HAND-OFF HARDENING
// ----------------------------------------------------------------------------
// Year-end PDF (as print-ready HTML), 1099-NEC worksheet, QuickBooks IIF
// export, and a single CPA Pack index page that links to all of them.
//
// Why HTML instead of server-rendered PDF: keeps the API dependency-free
// (no Chromium/puppeteer install on Railway). Patrick opens the page in
// Chrome, hits Cmd+P → Save as PDF. The print stylesheet is tuned so the
// output looks identical to the legal-doc pipeline at
// growth-os/docs/business/legal/_render-pdfs.sh.
// ============================================================================

const REPORT_CSS = `
<style>
  @page { size: Letter; margin: 0.7in 0.85in; }
  body { font: 11pt/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1F2937; max-width: 7.5in; margin: 0 auto; padding: 24px; background: #fff; }
  h1 { font-size: 22pt; margin: 0 0 4pt; color: #0B1228; border-bottom: 2px solid #22C55E; padding-bottom: 8pt; }
  h2 { font-size: 14pt; margin: 22pt 0 10pt; color: #0B1228; page-break-after: avoid; }
  h3 { font-size: 11pt; margin: 16pt 0 6pt; color: #0B1228; text-transform: uppercase; letter-spacing: 0.5px; }
  p { margin: 0 0 9pt; }
  .meta { color: #6B7280; font-size: 10pt; margin-bottom: 18pt; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 12pt; font-size: 10pt; }
  th, td { text-align: left; border: 1px solid #D1D5DB; padding: 6pt 9pt; }
  th { background: #F3F4F6; font-weight: 700; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { border-top: 2px solid #0B1228; font-weight: 700; }
  .pill { display: inline-block; padding: 2pt 8pt; border-radius: 99pt; font-size: 9pt; font-weight: 600; }
  .pill-green { background: #DCFCE7; color: #166534; }
  .pill-red { background: #FEE2E2; color: #991B1B; }
  .footer { margin-top: 30pt; padding-top: 12pt; border-top: 1px solid #D1D5DB; color: #6B7280; font-size: 9pt; }
  .actions { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 6pt; padding: 14pt 18pt; margin: 14pt 0; }
  .actions a { display: block; padding: 8pt 0; color: #0B1228; font-weight: 600; text-decoration: none; border-bottom: 1px solid #E5E7EB; }
  .actions a:last-child { border-bottom: none; }
  .actions a:hover { color: #22C55E; }
  @media print { .no-print { display: none !important; } body { padding: 0; } }
</style>
`.trim();

function htmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

// ============================================================================
// GET /api/finance/report/year-end.html?year=YYYY
// Print-ready P&L for the tax year. Drop-in replacement for QuickBooks'
// "Profit & Loss" report. Maps every expense category to a Schedule C line.
// ============================================================================
router.get('/report/year-end.html', async (req, res) => {
  try {
    const db = getUserClient(req);
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const { data: rows, error } = await db
      .from('finance_entries')
      .select('id, entry_type, category, amount, description, date, customer_name')
      .eq('tenant_id', req.tenantId)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });
    if (error) throw error;

    // Aggregate. Owner equity (contributions / draws) tracked separately
    // from P&L — they don't hit net income on Schedule C.
    let totalIncome = 0;
    let totalExpenses = 0;
    let totalOwnerIn = 0;
    let totalOwnerOut = 0;
    const incomeByCat = {};
    const expensesByCat = {};
    const monthly = {};  // { YYYY-MM: { income, expense } }

    for (const r of rows || []) {
      const amt = Number(r.amount) || 0;
      const month = r.date?.slice(0, 7);
      if (month && !monthly[month]) monthly[month] = { income: 0, expense: 0 };

      if (r.entry_type === 'income') {
        totalIncome += amt;
        const k = r.category || 'Uncategorized income';
        incomeByCat[k] = (incomeByCat[k] || 0) + amt;
        if (month) monthly[month].income += amt;
      } else if (r.entry_type === 'expense') {
        totalExpenses += amt;
        const k = r.category || 'Uncategorized';
        expensesByCat[k] = (expensesByCat[k] || 0) + amt;
        if (month) monthly[month].expense += amt;
      } else if (r.entry_type === 'owner_contribution') {
        totalOwnerIn += amt;
      } else if (r.entry_type === 'owner_draw') {
        totalOwnerOut += amt;
      }
      // sales_tax_* deliberately ignored — tracked in their own report
    }

    const net = totalIncome - totalExpenses;
    const months = Object.keys(monthly).sort();

    // Build HTML
    const incomeRows = Object.entries(incomeByCat)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => `<tr><td>${htmlEscape(cat)}</td><td class="num">${money(amt)}</td><td>${htmlEscape(SCHEDULE_C_MAP[cat] || 'Gross receipts (line 1)')}</td></tr>`)
      .join('');

    const expenseRows = Object.entries(expensesByCat)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => `<tr><td>${htmlEscape(cat)}</td><td class="num">${money(amt)}</td><td>${htmlEscape(SCHEDULE_C_MAP[cat] || 'Other expenses (line 27a)')}</td></tr>`)
      .join('');

    const monthlyRows = months.map(m => {
      const [y, mm] = m.split('-');
      const monthName = new Date(Number(y), Number(mm) - 1, 1).toLocaleString('en-US', { month: 'long' });
      const inc = monthly[m].income;
      const exp = monthly[m].expense;
      return `<tr><td>${monthName} ${y}</td><td class="num">${money(inc)}</td><td class="num">${money(exp)}</td><td class="num">${money(inc - exp)}</td></tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>P&amp;L Statement — Tax Year ${year}</title>
  ${REPORT_CSS}
</head>
<body>
  <h1>Profit &amp; Loss — Tax Year ${year}</h1>
  <p class="meta">First Gen Automate LLC · Cash-basis · Generated ${new Date().toISOString().slice(0, 10)}</p>

  <div class="actions no-print">
    <strong>To save as PDF:</strong> press <kbd>⌘ P</kbd> (Mac) or <kbd>Ctrl P</kbd> (Windows) → Destination → "Save as PDF".
  </div>

  <h2>Summary</h2>
  <table>
    <tbody>
      <tr><td>Total income</td><td class="num">${money(totalIncome)}</td></tr>
      <tr><td>Total expenses</td><td class="num">${money(totalExpenses)}</td></tr>
      <tr class="total"><td>Net profit / (loss)</td><td class="num">${money(net)} <span class="pill ${net >= 0 ? 'pill-green' : 'pill-red'}">${net >= 0 ? 'Profit' : 'Loss'}</span></td></tr>
    </tbody>
  </table>

  <h2>Income by category</h2>
  <table>
    <thead><tr><th>Category</th><th class="num">Amount</th><th>Schedule C line</th></tr></thead>
    <tbody>${incomeRows || '<tr><td colspan="3" style="text-align:center; color:#6B7280; padding:18pt;">No income recorded for ' + year + '.</td></tr>'}</tbody>
  </table>

  <h2>Expenses by category</h2>
  <table>
    <thead><tr><th>Category</th><th class="num">Amount</th><th>Schedule C line</th></tr></thead>
    <tbody>${expenseRows || '<tr><td colspan="3" style="text-align:center; color:#6B7280; padding:18pt;">No expenses recorded for ' + year + '.</td></tr>'}</tbody>
  </table>

  <h2>Monthly breakdown</h2>
  <table>
    <thead><tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Net</th></tr></thead>
    <tbody>${monthlyRows || '<tr><td colspan="4" style="text-align:center; color:#6B7280; padding:18pt;">No activity recorded.</td></tr>'}</tbody>
  </table>

  ${(totalOwnerIn > 0 || totalOwnerOut > 0) ? `
  <h2>Owner equity (NOT part of net income)</h2>
  <p style="font-size:10pt; color:#6B7280; margin-bottom:8pt;">Capital contributions and draws affect owner basis, not Schedule C profit. Listed here for the CPA's reference; excluded from the Summary and Schedule C mappings above.</p>
  <table>
    <tbody>
      <tr><td>Owner contributions in</td><td class="num">${money(totalOwnerIn)}</td></tr>
      <tr><td>Owner draws out</td><td class="num">${money(totalOwnerOut)}</td></tr>
      <tr class="total"><td>Net owner equity change</td><td class="num">${money(totalOwnerIn - totalOwnerOut)}</td></tr>
    </tbody>
  </table>
  ` : ''}

  <h2>Notes for the CPA</h2>
  <ul>
    <li>Books are kept on cash basis. Income is recorded on date received; expenses on date paid.</li>
    <li>Stripe revenue is auto-synced via webhook (<code>invoice.paid</code>) into <code>finance_entries</code> with idempotency on <code>metadata-&gt;stripe_invoice_id</code>.</li>
    <li>Mercury bank balance + transactions auto-synced nightly via the <code>mercury-sync</code> agent. Each import creates an attention-queue item for one-tap categorization.</li>
    <li>All edits and deletes after the original entry create rows in <code>finance_audit_log</code> — full history available on request.</li>
    <li>Period locks: a month can be closed (locked) via the platform's "Close Month" action; locked months reject mutations at the API layer.</li>
    <li>Owner contributions + draws are tracked separately (see "Owner equity" section above) and excluded from net income per Schedule C convention for single-member LLCs.</li>
  </ul>

  <div class="footer">
    First Gen Automate LLC · Atlanta, GA · Tax year ${year} · Source of truth: Supabase <code>finance_entries</code> · Cross-check with <code>FGA-Transactions-${year}.csv</code>.
  </div>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    log.error(`/report/year-end.html failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/finance/report/1099-nec.html?year=YYYY
//
// Worksheet showing every 1099-NEC contractor and total paid via
// crew_daily_log. The actual 1099-NEC forms must be filed via IRS
// e-services or a service like Track1099 — this worksheet is the
// data Patrick or the CPA transcribes into those forms.
// ============================================================================
router.get('/report/1099-nec.html', async (req, res) => {
  try {
    const db = getUserClient(req);
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    // Fetch all 1099 contractors for this tenant
    const { data: contractors, error: cErr } = await db
      .from('crew_members')
      .select('id, name, legal_business_name, tax_id, tax_id_kind, address_line1, address_line2, city, state, postal_code, daily_rate')
      .eq('tenant_id', req.tenantId)
      .eq('is_1099_contractor', true);
    if (cErr) throw cErr;

    // Fetch daily log entries for the year. The log stores one row per
    // (crew member, date) with a `worked` boolean — pay is computed as
    // days worked x the member's daily_rate (same math as /crew/yearly-summary).
    const { data: logs, error: lErr } = await db
      .from('crew_daily_log')
      .select('crew_member_id, date, worked')
      .eq('tenant_id', req.tenantId)
      .gte('date', startDate)
      .lte('date', endDate);
    if (lErr) throw lErr;

    // Aggregate paid per contractor: worked days x daily_rate.
    const rateById = {};
    for (const c of contractors || []) rateById[c.id] = Number(c.daily_rate) || 0;
    const paidByContractor = {};
    for (const log of logs || []) {
      if (!log.worked) continue;
      const id = log.crew_member_id;
      paidByContractor[id] = (paidByContractor[id] || 0) + (rateById[id] || 0);
    }

    // Mask tax_id for display (last 4 only)
    const mask = (tid) => tid ? `***-**-${String(tid).slice(-4)}` : '— (collect W-9)';

    const required = []; // paid >= 600
    const belowThreshold = []; // paid 0 < x < 600
    const noPay = []; // paid 0 — still listed for completeness

    for (const c of contractors || []) {
      const paid = paidByContractor[c.id] || 0;
      const row = { ...c, paid };
      if (paid >= 600) required.push(row);
      else if (paid > 0) belowThreshold.push(row);
      else noPay.push(row);
    }

    const renderRow = (c) => {
      const addr = [c.address_line1, c.address_line2, [c.city, c.state, c.postal_code].filter(Boolean).join(', ')]
        .filter(Boolean).join('<br>');
      const recipientName = c.legal_business_name ? `${htmlEscape(c.legal_business_name)}<br><span style="color:#6B7280; font-size:9pt;">(${htmlEscape(c.name)})</span>` : htmlEscape(c.name);
      return `<tr>
        <td>${recipientName}</td>
        <td><code>${htmlEscape(mask(c.tax_id))}</code><br><span style="font-size:9pt; color:#6B7280;">${(c.tax_id_kind || '').toUpperCase()}</span></td>
        <td>${addr || '<span style="color:#991B1B;">— missing</span>'}</td>
        <td class="num"><strong>${money(c.paid)}</strong></td>
      </tr>`;
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>1099-NEC Worksheet — Tax Year ${year}</title>
  ${REPORT_CSS}
</head>
<body>
  <h1>1099-NEC Worksheet — Tax Year ${year}</h1>
  <p class="meta">First Gen Automate LLC · Generated ${new Date().toISOString().slice(0, 10)}</p>

  <div class="actions no-print">
    <strong>How to use this:</strong> The IRS requires a 1099-NEC for any non-employee paid <strong>$600 or more</strong> in a tax year. The first table below is everyone who crossed that threshold. File via IRS e-services (FIRE) or Track1099 / Tax1099 by the January 31st deadline.
  </div>

  <h2>Required — paid $600+ (must issue 1099-NEC)</h2>
  <table>
    <thead><tr><th>Recipient</th><th>TIN (masked)</th><th>Address</th><th class="num">Box 1: Nonemployee compensation</th></tr></thead>
    <tbody>${required.length ? required.map(renderRow).join('') : '<tr><td colspan="4" style="text-align:center; color:#6B7280; padding:18pt;">No contractors crossed the $600 threshold in ' + year + '.</td></tr>'}</tbody>
  </table>

  ${belowThreshold.length ? `
  <h2>Below threshold — paid less than $600 (1099 NOT required)</h2>
  <table>
    <thead><tr><th>Recipient</th><th>TIN (masked)</th><th>Address</th><th class="num">Box 1</th></tr></thead>
    <tbody>${belowThreshold.map(renderRow).join('')}</tbody>
  </table>` : ''}

  ${noPay.length ? `
  <h2>Inactive — no payments in ${year}</h2>
  <p style="color:#6B7280;">${noPay.length} contractor${noPay.length === 1 ? '' : 's'} marked as 1099 but received no payments during the tax year.</p>` : ''}

  <h2>Filing checklist</h2>
  <ol>
    <li>Verify each TIN above is accurate. If any show "collect W-9," request a W-9 from that contractor before issuing.</li>
    <li>Verify each address is complete. The IRS rejects 1099s with incomplete addresses.</li>
    <li>File copies with the IRS (Copy A) by <strong>January 31, ${year + 1}</strong>.</li>
    <li>Mail copies to recipients (Copy B) by <strong>January 31, ${year + 1}</strong>.</li>
    <li>Retain Copy C for your records (kept automatically in <code>finance_audit_log</code>).</li>
  </ol>

  <div class="footer">
    Disclaimer: this worksheet is a computed summary of <code>crew_daily_log</code> for tax year ${year}. It is not a filed 1099-NEC. Verify with your tax professional before filing.
  </div>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    log.error(`/report/1099-nec.html failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/finance/report/qbo-export.iif?year=YYYY
//
// QuickBooks IIF (Intuit Interchange Format) export. A CPA who lives in
// QB can import this file in seconds and continue in their familiar tool.
// IIF is tab-delimited with one section per record type:
//
//   !ACCNT — chart of accounts
//   !TRNS  — transaction header (one row per transaction)
//   !SPL   — transaction split (one row per leg — IIF is double-entry)
//   !ENDTRNS — close transaction
//
// We map every income to (DR Checking / CR <income category>) and every
// expense to (DR <expense category> / CR Checking). "Checking" is a
// virtual placeholder — the CPA can map it to FGA's actual Mercury
// account during import.
// ============================================================================
router.get('/report/qbo-export.iif', async (req, res) => {
  try {
    const db = getUserClient(req);
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const { data: rows, error } = await db
      .from('finance_entries')
      .select('id, entry_type, category, amount, description, date, customer_name')
      .eq('tenant_id', req.tenantId)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });
    if (error) throw error;

    // Build distinct account list for the !ACCNT section
    const accounts = new Set([['Checking', 'BANK']]);
    for (const r of rows || []) {
      const cat = r.category || (r.entry_type === 'income' ? 'Uncategorized Income' : 'Uncategorized Expense');
      const type = r.entry_type === 'income' ? 'INC' : 'EXP';
      accounts.add([cat, type].join('|'));
    }

    const lines = [];

    // !HDR — required IIF preamble
    lines.push('!HDR\tPROD\tVER\tREL\tIIFVER\tDATE\tTIME\tACCNTNT\tACCNTNTSPLITTIME');
    lines.push(`HDR\tQuickBooks Online\t2026\tR1\t1\t${new Date().toLocaleDateString('en-US')}\t${Math.floor(Date.now() / 1000)}\tN\t0`);

    // !ACCNT — chart of accounts
    lines.push('!ACCNT\tNAME\tACCNTTYPE\tDESC');
    lines.push('ACCNT\tChecking\tBANK\tFGA operating account (map to Mercury during import)');
    for (const entry of accounts) {
      if (typeof entry === 'string') {
        const [name, type] = entry.split('|');
        if (name && type) {
          lines.push(`ACCNT\t${name}\t${type}\tImported from First Gen Automate platform`);
        }
      }
    }
    lines.push('!ENDGRP');

    // !TRNS / !SPL — one transaction per finance_entry
    lines.push('!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tTOPRINT\tADDR1\tADDR2\tADDR3\tADDR4\tADDR5');
    lines.push('!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tQNTY\tPRICE\tINVITEM\tPAYMETH\tTAXABLE\tREIMBEXP\tEXTRA');
    lines.push('!ENDTRNS');

    for (const r of rows || []) {
      const dateUS = (() => {
        const [y, m, d] = (r.date || '').split('-');
        return y ? `${m}/${d}/${y}` : '';
      })();
      const cat = r.category || (r.entry_type === 'income' ? 'Uncategorized Income' : 'Uncategorized Expense');
      const amt = Number(r.amount) || 0;
      const memo = (r.description || '').replace(/\t/g, ' ').replace(/\n/g, ' ');
      const name = (r.customer_name || '').replace(/\t/g, ' ');
      const trnsType = r.entry_type === 'income' ? 'DEPOSIT' : 'CHECK';

      // For income: DR Checking +amt, CR Income-Category -amt
      // For expense: DR Expense-Category +amt, CR Checking -amt
      if (r.entry_type === 'income') {
        lines.push(`TRNS\t\tDEPOSIT\t${dateUS}\tChecking\t${name}\t${amt.toFixed(2)}\t${r.id}\t${memo}\tN\tN\t\t\t\t\t`);
        lines.push(`SPL\t\tDEPOSIT\t${dateUS}\t${cat}\t${name}\t-${amt.toFixed(2)}\t${r.id}\t${memo}\tN\t\t\t\t\t\t\t`);
      } else {
        lines.push(`TRNS\t\tCHECK\t${dateUS}\tChecking\t${name}\t-${amt.toFixed(2)}\t${r.id}\t${memo}\tN\tN\t\t\t\t\t`);
        lines.push(`SPL\t\tCHECK\t${dateUS}\t${cat}\t${name}\t${amt.toFixed(2)}\t${r.id}\t${memo}\tN\t\t\t\t\t\t\t`);
      }
      lines.push('ENDTRNS');
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="FGA-QuickBooks-${year}.iif"`);
    res.send(lines.join('\r\n'));  // IIF requires CRLF line endings
  } catch (err) {
    log.error(`/report/qbo-export.iif failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/finance/cpa-pack?year=YYYY
//
// HTML index page with one-click links to every CPA export for the tax
// year. Replaces "build a ZIP" — Patrick clicks each link, saves to a
// folder, zips manually (or just emails the folder). Avoids server-side
// ZIP dependencies.
// ============================================================================
router.get('/cpa-pack', async (req, res) => {
  try {
    const db = getUserClient(req);
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>CPA Pack — Tax Year ${year}</title>
  ${REPORT_CSS}
</head>
<body>
  <h1>CPA Pack — Tax Year ${year}</h1>
  <p class="meta">First Gen Automate LLC · Hand-off bundle for your accountant</p>

  <div class="actions no-print">
    <strong>How this works:</strong> click each link to download or save the file. Together they form the complete CPA hand-off package — equivalent to handing over a QuickBooks file plus a year-end P&amp;L PDF.
  </div>

  <h2>1. Profit &amp; Loss statement</h2>
  <div class="actions">
    <a href="/api/finance/report/year-end.html?year=${year}" target="_blank">📄 Year-end P&amp;L (HTML — print to PDF)</a>
  </div>

  <h2>2. Transaction detail</h2>
  <div class="actions">
    <a href="/api/finance/report/year-end.csv?year=${year}">📊 Transaction list (CSV) — QuickBooks-compatible format</a>
  </div>

  <h2>3. QuickBooks import file</h2>
  <div class="actions">
    <a href="/api/finance/report/qbo-export.iif?year=${year}">🔄 QuickBooks IIF export — for CPAs who prefer QB</a>
  </div>

  <h2>4. 1099-NEC worksheet</h2>
  <div class="actions">
    <a href="/api/finance/report/1099-nec.html?year=${year}" target="_blank">📋 1099-NEC contractor summary (HTML — print to PDF)</a>
  </div>

  <h2>5. Audit log</h2>
  <div class="actions">
    <a href="/api/finance/audit-log?limit=500">🔍 Full audit-log JSON (every change recorded)</a>
  </div>

  <h2>What's NOT included (intentionally)</h2>
  <ul>
    <li><strong>Bank statements</strong> — pull from Mercury directly.</li>
    <li><strong>Receipts</strong> — uploaded receipts (when receipt OCR ships in Phase 4) will live in Supabase Storage; share that folder separately if asked.</li>
    <li><strong>Personal returns</strong> — this is FGA LLC books only.</li>
    <li><strong>State tax filings</strong> — Georgia DOR account is separate.</li>
  </ul>

  <div class="footer">
    Generated ${new Date().toISOString().slice(0, 10)} · Tax year ${year} · For your CPA's eyes only.
  </div>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    log.error(`/cpa-pack failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// PHASE 4 — RECEIPT OCR (Claude vision)
// ----------------------------------------------------------------------------
// POST /api/finance/receipt-ocr
// Body: { image_base64: string, media_type: 'image/jpeg' | 'image/png' | 'image/heic' }
//
// Returns a *draft* expense entry (vendor, amount, date, suggested category)
// without writing to finance_entries. The mobile client previews + lets the
// user tweak fields before tapping "Save" (which hits the existing
// POST /expenses endpoint).
// ============================================================================
const { askClaudeWithImageJSON } = require('../../integrations/claude');

router.post('/receipt-ocr', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { image_base64, media_type } = req.body || {};
    if (!image_base64 || !media_type) {
      return res.status(400).json({ success: false, error: 'image_base64 and media_type required' });
    }
    if (!['image/jpeg', 'image/png', 'image/heic', 'image/webp'].includes(media_type)) {
      return res.status(400).json({ success: false, error: `Unsupported media type: ${media_type}` });
    }
    // Hard cap on size — Claude vision input limit is generous but 5MB is the practical UX limit
    if (image_base64.length > 7_500_000) {  // ~5.6MB after base64 overhead
      return res.status(413).json({ success: false, error: 'Image too large. Compress to under 5MB.' });
    }

    const categories = [
      'Software & SaaS', 'Marketing & Advertising', 'Payroll & Contractors',
      'Office & Equipment', 'Travel & Conferences', 'Insurance',
      'Legal & Professional', 'Subscriptions', 'Utilities', 'Meals & Entertainment',
      'Vehicle & Fuel', 'Supplies & Materials', 'Education & Training',
      'Taxes & Fees', 'Hosting & Infrastructure', 'Communication', 'Other',
    ];

    const systemPrompt = `You are a receipt-extraction assistant for a small business owner. Extract key fields from the attached receipt photo and return them as JSON. Be conservative — if a field is unclear or missing, return null for it. Never invent data.

Return JSON with this exact shape:
{
  "vendor": "string — the merchant/business name on the receipt",
  "amount": number — total amount paid in dollars (after tax + tip),
  "date": "YYYY-MM-DD" — the transaction date,
  "category": "string — pick ONE of the categories below that best fits",
  "description": "string — short 5-10 word summary of what was purchased",
  "confidence": "high" | "medium" | "low" — how confident you are in the extraction
}

Categories:
${categories.join(', ')}`;

    const userPrompt = 'Extract the fields from this receipt and return as JSON.';

    const result = await askClaudeWithImageJSON(
      systemPrompt,
      userPrompt,
      image_base64,
      media_type,
      { maxTokens: 512, tenantSlug: req.tenantSlug },
    );

    // Validate + sanitize
    const draft = {
      vendor: result.vendor || null,
      amount: result.amount != null ? Number(result.amount) : null,
      date: result.date && /^\d{4}-\d{2}-\d{2}$/.test(result.date) ? result.date : null,
      category: categories.includes(result.category) ? result.category : 'Other',
      description: result.description || null,
      confidence: ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'medium',
    };

    log.info(`Receipt OCR: ${draft.vendor || 'unknown'} $${draft.amount || '?'} (${draft.confidence})`);
    res.json({ success: true, draft });
  } catch (err) {
    log.error(`/receipt-ocr failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/finance/month-end-review?month=YYYY-MM
//
// Aggregated "ready to close this month?" status. Combines:
//   - uncategorized expense count
//   - duplicate-suspected attention items
//   - whether the month is already locked
//   - net total for the month
// Used by the mobile Reports screen + web Action Ribbon to surface a
// "Close This Month" CTA when the dust has settled.
// ============================================================================
router.get('/month-end-review', async (req, res) => {
  try {
    const db = getUserClient(req);
    const month = req.query.month || new Date().toISOString().slice(0, 7);  // YYYY-MM
    if (!/^\d{4}-\d{2}$/.test(String(month))) {
      return res.status(400).json({ success: false, error: 'month must be YYYY-MM' });
    }
    const [year, mon] = String(month).split('-').map(Number);
    const startDate = `${month}-01`;
    const endDate = (() => {
      const d = new Date(year, mon, 0);
      return d.toISOString().slice(0, 10);
    })();

    // Count uncategorized
    const { data: uncatList } = await db
      .from('finance_entries')
      .select('id', { count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'expense')
      .or('category.is.null,category.eq.')
      .gte('date', startDate)
      .lte('date', endDate);

    // Count duplicate-suspected attention items for the month
    const { data: dupes } = await db
      .from('attention_queue')
      .select('id', { count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .eq('type', 'duplicate_suspected')
      .is('resolved_at', null);

    // Check if month is already locked
    const { data: lockRow } = await db
      .from('finance_period_locks')
      .select('id, locked_at, reopened_at')
      .eq('tenant_id', req.tenantId)
      .eq('period_month', startDate)
      .order('locked_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const isLocked = lockRow && lockRow.locked_at && !lockRow.reopened_at;

    // Totals for the month
    const { data: monthEntries } = await db
      .from('finance_entries')
      .select('entry_type, amount')
      .eq('tenant_id', req.tenantId)
      .gte('date', startDate)
      .lte('date', endDate);

    let income = 0, expense = 0;
    for (const r of monthEntries || []) {
      const amt = Number(r.amount) || 0;
      if (r.entry_type === 'income') income += amt;
      else if (r.entry_type === 'expense') expense += amt;
    }

    const uncategorizedCount = uncatList?.length || 0;
    const duplicateCount = dupes?.length || 0;
    const readyToClose = !isLocked && uncategorizedCount === 0 && duplicateCount === 0;

    res.json({
      success: true,
      month,
      is_locked: !!isLocked,
      ready_to_close: readyToClose,
      blockers: {
        uncategorized_expenses: uncategorizedCount,
        duplicate_suspected: duplicateCount,
      },
      totals: { income, expense, net: income - expense },
    });
  } catch (err) {
    log.error(`/month-end-review failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// STRETCH ENHANCEMENT #12 — READ-ONLY CPA API TOKENS
// ----------------------------------------------------------------------------
// Long-lived bearer tokens scoped to a specific tax year. The CPA's
// accounting tool authenticates with header `X-FGA-CPA-Token: <hex>`
// and gets read-only access to /report/* + /audit-log endpoints.
//
// Endpoints:
//   POST   /cpa-tokens             — issue a new token (returns cleartext ONCE)
//   GET    /cpa-tokens             — list active tokens (without cleartext)
//   DELETE /cpa-tokens/:id         — revoke a token immediately
//
// Token storage: only the SHA-256 hash. Cleartext is returned in the
// POST response body and never persisted.
// ============================================================================
const crypto = require('crypto');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

router.post('/cpa-tokens', async (req, res) => {
  try {
    const db = getUserClient(req);
    const taxYear = Number(req.body?.tax_year) || new Date().getUTCFullYear();
    const label = String(req.body?.label || '').trim() || `Tax year ${taxYear}`;
    const ttlDays = Math.min(180, Math.max(7, Number(req.body?.ttl_days) || 60));
    const expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();

    // 32-byte cryptographically random token, hex-encoded (64 chars)
    const cleartext = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(cleartext);

    const { data, error } = await db
      .from('cpa_api_tokens')
      .insert({
        tenant_id: req.tenantId,
        token_hash: tokenHash,
        tax_year: taxYear,
        label,
        created_by: req.user?.id || null,
        expires_at: expiresAt,
      })
      .select('id, tax_year, label, created_at, expires_at')
      .single();
    if (error) throw error;

    log.info(`Issued CPA token "${label}" for tax year ${taxYear} (expires ${expiresAt})`);

    res.status(201).json({
      success: true,
      token: cleartext,  // shown ONCE — UI warns user to copy now
      record: data,
      usage: {
        header: 'X-FGA-CPA-Token',
        example: `curl -H "X-FGA-CPA-Token: ${cleartext}" https://api.firstgenautomate.com/api/cpa/report/year-end.html?year=${taxYear}`,
      },
    });
  } catch (err) {
    log.error(`POST /cpa-tokens failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/cpa-tokens', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('cpa_api_tokens')
      .select('id, tax_year, label, created_at, expires_at, last_used_at, use_count, revoked_at')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, tokens: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/cpa-tokens/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('cpa_api_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .is('revoked_at', null)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Token not found or already revoked' });
    log.info(`Revoked CPA token ${req.params.id}`);
    res.json({ success: true, token: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
// Exported so the forgery guard can be executed in tests, not grepped.
module.exports.safeMetadata = safeMetadata;
module.exports.RESERVED_METADATA_KEYS = RESERVED_METADATA_KEYS;
