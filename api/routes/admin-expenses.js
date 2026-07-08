/**
 * Growth OS — Internal Expense Tracker (admin-only routes)
 *
 * Mounted at /api/admin/expenses behind authMiddleware + adminMiddleware, so
 * only FGA founder/admin users can reach any of this. NOT a customer feature.
 *
 * Flow: upload receipt/invoice -> store original in PRIVATE bucket -> OCR/AI
 * extract -> create a PENDING draft -> admin reviews/edits -> approve | reject.
 * Nothing is ever auto-approved.
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();

const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const { createExpenseDraftFromBuffer, BUCKET, MAX_BYTES } = require('../../core/internal-expense-draft');
const {
  buildDedupeKey,
  validateForApproval,
  toNullableDate,
  toNullableAmount,
} = require('../../core/internal-expense-validation');

const log = createLogger('admin-expenses');

// Approved expenses live in the shared finance_entries ledger (FGA tenant) so
// the Expense Tracker and the Reports/P&L always show the same numbers. The
// internal_expenses table is the OCR/review *inbox*; on approval a row is
// written into finance_entries and linked back via finance_entry_id.

/** Map a finance_entries expense row -> the Expense Tracker list shape. */
function ledgerToListItem(r) {
  const md = r.metadata || {};
  return {
    id: r.id,
    source: 'ledger',
    vendor_name: r.description || null,
    document_type: 'unknown',
    document_number: md.document_number || null,
    expense_date: r.date || null,
    due_date: null,
    currency: 'USD',
    category: r.category || null,
    expense_type: md.expense_type || null,
    subtotal_amount: null,
    tax_amount: null,
    total_amount: r.amount != null ? Number(r.amount) : null,
    payment_status: md.payment_status || 'paid',
    recurring: !!r.recurring,
    recurrence_frequency: md.recurrence_frequency || (r.recurring ? 'monthly' : null),
    related_customer_id: md.related_customer_id || null,
    related_project_id: null,
    notes: r.description || null,
    line_items: [],
    file_mime: null,
    ai_confidence: null,
    extraction_status: 'ledger',
    review_status: 'approved',
    created_at: r.created_at,
  };
}

/** Build the finance_entries payload from an internal_expenses row. */
function expenseToFinanceEntry(exp) {
  return {
    tenant_id: FGA_TENANT_ID,
    entry_type: 'expense',
    category: exp.category || 'Other',
    amount: exp.total_amount != null ? Number(exp.total_amount) : 0,
    date: exp.expense_date,
    description: exp.vendor_name || exp.document_number || 'Expense',
    recurring: !!exp.recurring,
    metadata: {
      source: 'expense_tracker',
      internal_expense_id: exp.id,
      document_number: exp.document_number || null,
      expense_type: exp.expense_type || null,
      payment_status: exp.payment_status || null,
      recurrence_frequency: exp.recurrence_frequency || null,
      related_customer_id: exp.related_customer_id || null,
      file_path: exp.file_path || null,
    },
  };
}

// BUCKET / MAX_BYTES / the allowed-mime set are owned by
// core/internal-expense-draft.js — the shared path used by both this upload
// route and the weekly Gmail invoice scanner.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

// Columns a client is allowed to set/patch (whitelist — never trust the body wholesale).
const EDITABLE = [
  'vendor_name', 'document_type', 'document_number', 'expense_date', 'due_date',
  'currency', 'category', 'expense_type', 'subtotal_amount', 'tax_amount',
  'total_amount', 'payment_status', 'recurring', 'recurrence_frequency',
  'related_customer_id', 'related_project_id', 'notes', 'line_items',
];

const DATE_FIELDS = new Set(['expense_date', 'due_date']);
const AMOUNT_FIELDS = new Set(['subtotal_amount', 'tax_amount', 'total_amount']);

function pickEditable(body) {
  const out = {};
  for (const k of EDITABLE) {
    if (body[k] === undefined) continue;
    if (DATE_FIELDS.has(k)) out[k] = toNullableDate(body[k]);
    else if (AMOUNT_FIELDS.has(k)) out[k] = toNullableAmount(body[k]);
    else out[k] = body[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST /api/admin/expenses  (multipart: field "file") — upload + OCR + draft
// Optional header: Idempotency-Key  (prevents double-tap duplicate creates)
// ---------------------------------------------------------------------------
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const db = getServiceClient();
    const idemKey = req.get('Idempotency-Key') || null;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded (field "file").' });
    }
    const { mimetype, size, originalname, buffer } = req.file;

    // Storage + extraction + NUL-strip + dedupe + idempotency all live in the
    // shared creator, which the weekly Gmail invoice scanner also calls, so an
    // emailed invoice and an uploaded receipt can never diverge.
    const result = await createExpenseDraftFromBuffer({
      db,
      buffer,
      mimetype,
      size,
      filename: originalname,
      sourceType: req.body?.source_type === 'mobile_capture' ? 'mobile_capture' : 'upload',
      idempotencyKey: idemKey,
      createdBy: req.user?.id || null,
    });

    if (!result.ok) {
      const status = result.code === 'unsupported_mime' ? 400
        : result.code === 'too_large' ? 413
          : 500;
      // Admin-only internal tool — surface the real reason to speed up triage.
      return res.status(status).json({ success: false, error: result.error });
    }
    if (result.idempotentReplay) {
      return res.json({ success: true, data: result.data, idempotent_replay: true });
    }

    const extraction = result.extraction || {};
    res.status(201).json({
      success: true,
      data: result.data,
      extraction: { ok: extraction.ok, status: extraction.extraction_status, error: extraction.error || null },
      duplicate_of: result.duplicateOf,
    });
  } catch (err) {
    log.error(`POST / failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/expenses/manual — create an empty/manual draft (no file)
// ---------------------------------------------------------------------------
router.post('/manual', async (req, res) => {
  try {
    const db = getServiceClient();
    const fields = pickEditable(req.body || {});
    const row = {
      ...fields,
      currency: fields.currency || 'USD',
      review_status: 'pending',
      extraction_status: 'manual',
      source_type: 'manual',
      ai_confidence: null,
      created_by: req.user?.id || null,
    };
    row.dedupe_key = buildDedupeKey(row);
    const { data, error } = await db.from('internal_expenses').insert(row).select('*').single();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    log.error(`POST /manual failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/expenses — list with filters
//   ?status=pending|approved|rejected  &recurring=true
//   &category= &vendor= &from=YYYY-MM-DD &to=YYYY-MM-DD &limit=
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const db = getServiceClient();
    let q = db.from('internal_expenses').select('*').order('created_at', { ascending: false });

    const { status, recurring, category, vendor, from, to, expense_type, payment_status } = req.query;
    if (status && ['pending', 'approved', 'rejected'].includes(status)) q = q.eq('review_status', status);
    if (recurring === 'true') q = q.eq('recurring', true);
    if (category) q = q.eq('category', category);
    if (expense_type) q = q.eq('expense_type', expense_type);
    if (payment_status) q = q.eq('payment_status', payment_status);
    if (vendor) q = q.ilike('vendor_name', `%${vendor}%`);
    if (from) q = q.gte('expense_date', from);
    if (to) q = q.lte('expense_date', to);
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    q = q.limit(limit);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    log.error(`GET / failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/expenses/ledger — APPROVED expenses, read from the shared
// finance_entries ledger (FGA tenant). This is what the Approved / All /
// Recurring tabs render so they match Reports exactly.
//   ?recurring=true &category= &vendor= &from= &to=
// ---------------------------------------------------------------------------
router.get('/ledger', async (req, res) => {
  try {
    const db = getServiceClient();
    let q = db.from('finance_entries').select('*')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('entry_type', 'expense')
      .order('date', { ascending: false });

    const { recurring, category, vendor, from, to } = req.query;
    if (recurring === 'true') q = q.eq('recurring', true);
    if (category) q = q.eq('category', category);
    if (vendor) q = q.ilike('description', `%${vendor}%`);
    if (from) q = q.gte('date', from);
    if (to) q = q.lte('date', to);
    q = q.limit(Math.min(Number(req.query.limit) || 500, 1000));

    const { data, error } = await q;
    if (error) throw error;
    const items = (data || []).map(ledgerToListItem);
    res.json({ success: true, count: items.length, data: items });
  } catch (err) {
    log.error(`GET /ledger failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/expenses/ledger/:id/recurring — flip the recurring flag
// on an already-approved expense in the finance_entries ledger.
//
// Why this exists (2026-06-08): Patrick had Canva on the Recurring list
// because he subscribed for two months, then moved to a different design
// tool. The only way to clear it was direct DB. Now the Recurring tab has
// a "Stop recurring" action that hits this endpoint.
//
// Body: { recurring: boolean }
// ---------------------------------------------------------------------------
router.patch('/ledger/:id/recurring', async (req, res) => {
  try {
    const db = getServiceClient();
    const recurring = !!req.body?.recurring;
    const { data, error } = await db
      .from('finance_entries')
      .update({ recurring })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('entry_type', 'expense')
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: ledgerToListItem(data) });
  } catch (err) {
    log.error(`PATCH /ledger/:id/recurring failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/expenses/summary — dashboard cards.
// Money figures come from the finance_entries ledger (the real books) so
// "This Month" matches Reports; pending count comes from the OCR inbox.
// ---------------------------------------------------------------------------
router.get('/summary', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: ledger, error } = await db
      .from('finance_entries')
      .select('amount, category, description, date, recurring, metadata')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('entry_type', 'expense');
    if (error) throw error;

    // Pending review count is still the OCR inbox (internal_expenses).
    const { count: pendingCount } = await db
      .from('internal_expenses')
      .select('id', { count: 'exact', head: true })
      .eq('review_status', 'pending');

    // Normalize ledger rows to the same shape the rest of this handler expects.
    const approved = ledger.map((e) => ({
      total_amount: e.amount,
      category: e.category,
      vendor_name: e.description,
      expense_date: e.date,
      recurring: e.recurring,
      recurrence_frequency: e.metadata?.recurrence_frequency || (e.recurring ? 'monthly' : null),
    }));
    const now = new Date();
    const ymNow = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const yNow = String(now.getUTCFullYear());

    const inMonth = (e) => (e.expense_date || '').startsWith(ymNow);
    const inYear = (e) => (e.expense_date || '').startsWith(yNow);
    const sum = (arr) => arr.reduce((s, e) => s + (Number(e.total_amount) || 0), 0);

    // recurring monthly-equivalent estimate
    const monthlyEquiv = approved
      .filter((e) => e.recurring)
      .reduce((s, e) => {
        const amt = Number(e.total_amount) || 0;
        const f = e.recurrence_frequency;
        if (f === 'annual') return s + amt / 12;
        if (f === 'quarterly') return s + amt / 3;
        if (f === 'monthly') return s + amt;
        return s; // one-time / unknown excluded
      }, 0);

    // top vendor / category this month
    const tally = (arr, key) => {
      const m = {};
      for (const e of arr) {
        const k = e[key] || 'Uncategorized';
        m[k] = (m[k] || 0) + (Number(e.total_amount) || 0);
      }
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    const monthApproved = approved.filter(inMonth);
    const topVendor = tally(monthApproved, 'vendor_name')[0] || null;
    const topCategory = tally(monthApproved, 'category')[0] || null;

    res.json({
      success: true,
      data: {
        total_this_month: sum(monthApproved),
        total_ytd: sum(approved.filter(inYear)),
        pending_review_count: pendingCount || 0,
        recurring_monthly_estimate: Math.round(monthlyEquiv * 100) / 100,
        top_vendor_this_month: topVendor ? { name: topVendor[0], amount: topVendor[1] } : null,
        top_category_this_month: topCategory ? { name: topCategory[0], amount: topCategory[1] } : null,
        by_category: tally(approved, 'category').map(([name, amount]) => ({ name, amount })),
        by_vendor: tally(approved, 'vendor_name').slice(0, 10).map(([name, amount]) => ({ name, amount })),
      },
    });
  } catch (err) {
    log.error(`GET /summary failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});
// NOTE: every /mailboxes* + /scan-* route MUST stay above the /:id routes
// below — Express matches in registration order, so GET /:id would happily
// swallow GET /mailboxes and treat "mailboxes" as an expense id.

// ===========================================================================
// Connected mailboxes — weekly Gmail invoice scanning (2026-07-08)
//
// Read-only (gmail.readonly). The scanner only ever CREATES pending drafts;
// it never approves, never books, and never modifies the mailbox.
// ===========================================================================

/** GET /api/admin/expenses/mailboxes — connected inboxes + scan status. */
router.get('/mailboxes', async (req, res) => {
  try {
    const db = getServiceClient();
    const { getGmailConnections, configuredOauthClients } = require('../../core/drip-gmail');
    const connections = await getGmailConnections(db);
    const clients = configuredOauthClients();

    // Recent scan activity, for the "last run found N" line in the UI.
    const { data: recent } = await db
      .from('gmail_invoice_scans')
      .select('mailbox, outcome, created_at')
      .eq('tenant_id', FGA_TENANT_ID)
      .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString())
      .limit(500);

    const importedByMailbox = {};
    for (const r of recent || []) {
      if (r.outcome !== 'imported') continue;
      importedByMailbox[r.mailbox] = (importedByMailbox[r.mailbox] || 0) + 1;
    }

    res.json({
      success: true,
      data: connections.map((c) => ({
        id: c.id,
        email_address: c.email_address,
        label: c.label,
        is_primary: c.is_primary,
        scan_invoices: c.scan_invoices,
        last_invoice_scan_at: c.last_invoice_scan_at,
        imported_last_30d: importedByMailbox[c.email_address] || 0,
        oauth_client: c.oauth_client || 'internal',
        // A mailbox with no refresh token cannot survive an access-token expiry.
        needs_reconnect: !c.refresh_token,
      })),
      // Which sign-in paths the server can offer. 'internal' = Workspace-only
      // project; 'external' = the published project that personal Gmail needs.
      configured: clients.includes('internal'),
      oauth_clients: clients,
    });
  } catch (err) {
    log.error(`GET /mailboxes failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/expenses/mailboxes/connect-url — mint the Google consent URL.
 * Admin-authenticated: the signed state this returns is the only thing the
 * public callback will accept, so an attacker can't bind their own inbox.
 */
router.get('/mailboxes/connect-url', async (req, res) => {
  try {
    const { buildGmailConnectUrl } = require('../../core/drip-gmail');
    // ?client=external for a personal @gmail.com (the Workspace-only project
    // rejects those with `403 org_internal`); default 'internal' for
    // @firstgenautomate.com addresses.
    const client = req.query.client === 'external' ? 'external' : 'internal';
    res.json({ success: true, url: buildGmailConnectUrl('mailbox', client), client });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/** PATCH /api/admin/expenses/mailboxes/:id — toggle scanning / rename. */
router.patch('/mailboxes/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const updates = { updated_at: new Date().toISOString() };
    if (typeof req.body?.scan_invoices === 'boolean') updates.scan_invoices = req.body.scan_invoices;
    if (typeof req.body?.label === 'string') updates.label = req.body.label.slice(0, 80) || null;

    const { data, error } = await db
      .from('email_connections')
      .update(updates)
      .eq('id', req.params.id)
      .eq('tenant_id', FGA_TENANT_ID)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/admin/expenses/mailboxes/:id — disconnect a mailbox.
 * The PRIMARY inbox is protected: it is what the outreach reply-sync polls,
 * and removing it here would silently break drip reply handling.
 */
router.delete('/mailboxes/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: conn } = await db
      .from('email_connections')
      .select('id, is_primary, email_address')
      .eq('id', req.params.id)
      .eq('tenant_id', FGA_TENANT_ID)
      .maybeSingle();
    if (!conn) return res.status(404).json({ success: false, error: 'not_found' });
    if (conn.is_primary) {
      return res.status(400).json({
        success: false,
        error: `${conn.email_address} is the primary inbox used for outreach reply monitoring. Turn off invoice scanning instead of disconnecting it.`,
      });
    }
    const { error } = await db.from('email_connections').delete().eq('id', conn.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/expenses/scan-now — queue an immediate invoice scan.
 * Enqueued rather than run inline: a scan can make one Claude Vision call per
 * attachment, which would hold the HTTP request open for minutes.
 */
router.post('/scan-now', async (req, res) => {
  try {
    const { enqueueJob } = require('../../db/queries/jobs');
    const days = Number(req.body?.newer_than_days) > 0 ? Number(req.body.newer_than_days) : 14;
    const job = await enqueueJob(FGA_TENANT_ID, 'invoice-scan', { newer_than_days: Math.min(days, 365) }, { priority: 5 });
    res.status(202).json({
      success: true,
      job_id: job?.id || null,
      message: 'Scanning your email for invoices. New drafts appear in Needs Review within a couple of minutes.',
    });
  } catch (err) {
    log.error(`POST /scan-now failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/admin/expenses/scan-log — recent scan activity (audit trail). */
router.get('/scan-log', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data, error } = await db
      .from('gmail_invoice_scans')
      .select('*')
      .eq('tenant_id', FGA_TENANT_ID)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(req.query.limit) || 50, 200));
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});



// ---------------------------------------------------------------------------
// GET /api/admin/expenses/:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data, error } = await db.from('internal_expenses').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Expense not found' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/expenses/:id/file — short-lived signed URL to the original
// ---------------------------------------------------------------------------
router.get('/:id/file', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: exp } = await db.from('internal_expenses').select('file_path, file_mime').eq('id', req.params.id).maybeSingle();
    if (!exp || !exp.file_path) return res.status(404).json({ success: false, error: 'No file attached' });
    const { data: signed, error } = await db.storage.from(BUCKET).createSignedUrl(exp.file_path, 120); // 2 min
    if (error) throw error;
    res.json({ success: true, url: signed.signedUrl, mime: exp.file_mime, expires_in: 120 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/expenses/:id — edit fields (stays pending unless approved)
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const updates = pickEditable(req.body || {});
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields supplied.' });
    }
    // Recompute dedupe fingerprint if any of its inputs changed.
    const { data: current } = await db.from('internal_expenses').select('*').eq('id', req.params.id).maybeSingle();
    if (!current) return res.status(404).json({ success: false, error: 'Expense not found' });
    const merged = { ...current, ...updates };
    updates.dedupe_key = buildDedupeKey(merged);
    updates.updated_at = new Date().toISOString();

    const { data, error } = await db
      .from('internal_expenses').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    log.error(`PATCH /:id failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/expenses/:id/approve — validate then approve
// ---------------------------------------------------------------------------
router.post('/:id/approve', async (req, res) => {
  try {
    const db = getServiceClient();
    // Allow approving with last-minute edits in the same call.
    const updates = pickEditable(req.body || {});
    const { data: current } = await db.from('internal_expenses').select('*').eq('id', req.params.id).maybeSingle();
    if (!current) return res.status(404).json({ success: false, error: 'Expense not found' });
    const merged = { ...current, ...updates };

    const { ok, errors } = validateForApproval(merged);
    if (!ok) return res.status(400).json({ success: false, error: 'Validation failed', errors });

    const patch = {
      ...updates,
      review_status: 'approved',
      reviewed_by: req.user?.id || null,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      dedupe_key: buildDedupeKey(merged),
    };
    const { data, error } = await db.from('internal_expenses').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;

    // Sync into the shared finance_entries ledger (FGA tenant) so it shows in
    // Reports / P&L. Update the linked row on re-approval; insert otherwise.
    const fePayload = expenseToFinanceEntry(data);
    try {
      if (data.finance_entry_id) {
        await db.from('finance_entries').update(fePayload).eq('id', data.finance_entry_id);
      } else {
        const { data: fe, error: feErr } = await db
          .from('finance_entries').insert(fePayload).select('id').single();
        if (feErr) throw feErr;
        await db.from('internal_expenses').update({ finance_entry_id: fe.id }).eq('id', data.id);
        data.finance_entry_id = fe.id;
      }
    } catch (feErr) {
      log.error(`finance_entries sync failed for ${data.id}: ${feErr.message}`);
      // Roll the approval back so the inbox/books never disagree.
      await db.from('internal_expenses').update({ review_status: 'pending' }).eq('id', data.id);
      return res.status(500).json({ success: false, error: 'Approved, but failed to add to your books. Try again.' });
    }

    log.info(`Approved ${data.id} (${data.vendor_name}, $${data.total_amount}) -> finance_entry ${data.finance_entry_id}`);
    res.json({ success: true, data });
  } catch (err) {
    log.error(`approve failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/expenses/:id/reject
// ---------------------------------------------------------------------------
router.post('/:id/reject', async (req, res) => {
  try {
    const db = getServiceClient();
    // If it was previously approved, pull it back out of the books.
    const { data: cur } = await db.from('internal_expenses').select('finance_entry_id').eq('id', req.params.id).maybeSingle();
    if (cur?.finance_entry_id) {
      await db.from('finance_entries').delete().eq('id', cur.finance_entry_id).catch(() => {});
    }
    const patch = {
      review_status: 'rejected',
      finance_entry_id: null,
      reviewed_by: req.user?.id || null,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (typeof req.body?.notes === 'string') patch.notes = req.body.notes.slice(0, 1000);
    const { data, error } = await db.from('internal_expenses').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/expenses/:id — remove draft + its stored file
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: exp } = await db.from('internal_expenses').select('file_path, finance_entry_id').eq('id', req.params.id).maybeSingle();
    if (exp?.file_path) {
      await db.storage.from(BUCKET).remove([exp.file_path]).catch(() => {});
    }
    // Remove the linked books row too, so deleting here removes it everywhere.
    if (exp?.finance_entry_id) {
      await db.from('finance_entries').delete().eq('id', exp.finance_entry_id).catch(() => {});
    }
    const { error } = await db.from('internal_expenses').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
