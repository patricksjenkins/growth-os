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
const crypto = require('crypto');
const router = express.Router();

const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { extractInternalExpenseFromInvoice } = require('../../core/internal-expense-extractor');
const { buildDedupeKey, validateForApproval } = require('../../core/internal-expense-validation');

const log = createLogger('admin-expenses');

const BUCKET = process.env.INTERNAL_EXPENSES_BUCKET || 'internal-expenses';
const MAX_BYTES = 15 * 1024 * 1024; // 15MB

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp',
]);
const EXT_BY_MIME = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp',
};

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

function pickEditable(body) {
  const out = {};
  for (const k of EDITABLE) {
    if (body[k] !== undefined) out[k] = body[k];
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

    // Idempotency: if we've already created a row for this key, return it.
    if (idemKey) {
      const { data: existing } = await db
        .from('internal_expenses')
        .select('*')
        .eq('idempotency_key', idemKey)
        .maybeSingle();
      if (existing) return res.json({ success: true, data: existing, idempotent_replay: true });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded (field "file").' });
    }
    const { mimetype, size, originalname, buffer } = req.file;
    if (!ALLOWED_MIME.has(mimetype)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported file type "${mimetype}". Upload a PDF, JPG, PNG, HEIC, or WEBP.`,
      });
    }
    if (size > MAX_BYTES) {
      return res.status(413).json({ success: false, error: 'File too large. Max 15MB.' });
    }

    // 1) Store the original in the PRIVATE bucket.
    const id = crypto.randomUUID();
    const ext = EXT_BY_MIME[mimetype] || 'bin';
    const objectPath = `expenses/${id}.${ext}`;
    const { error: upErr } = await db.storage
      .from(BUCKET)
      .upload(objectPath, buffer, { contentType: mimetype, upsert: false });
    if (upErr) {
      log.error(`storage upload failed: ${upErr.message}`);
      return res.status(500).json({ success: false, error: 'Could not store the file. Check the internal-expenses bucket exists.' });
    }

    // 2) OCR/AI extraction (never throws — failure => manual-entry draft).
    const extraction = await extractInternalExpenseFromInvoice({ buffer, mimetype, filename: originalname });
    const d = extraction.draft || {};

    // 3) Build the pending draft row.
    const row = {
      id,
      vendor_name: d.vendor_name ?? null,
      document_type: d.document_type ?? 'unknown',
      document_number: d.document_number ?? null,
      expense_date: d.expense_date ?? null,
      due_date: d.due_date ?? null,
      currency: d.currency ?? 'USD',
      category: d.category ?? null,
      expense_type: d.expense_type ?? null,
      subtotal_amount: d.subtotal_amount ?? null,
      tax_amount: d.tax_amount ?? null,
      total_amount: d.total_amount ?? null,
      payment_status: d.payment_status ?? 'unknown',
      recurring: d.recurring ?? false,
      recurrence_frequency: d.recurrence_frequency ?? 'unknown',
      line_items: d.line_items ?? [],
      notes: d.notes ?? null,
      source_type: req.body?.source_type === 'mobile_capture' ? 'mobile_capture' : 'upload',
      file_path: objectPath,
      file_mime: mimetype,
      file_size_bytes: size,
      ocr_text: extraction.raw_text ? String(extraction.raw_text).slice(0, 20000) : null,
      ai_confidence: typeof extraction.confidence === 'number' ? extraction.confidence : (d.confidence ?? null),
      extraction_status: extraction.extraction_status || (extraction.ok ? 'extracted' : 'failed'),
      review_status: 'pending',
      idempotency_key: idemKey,
      created_by: req.user?.id || null,
    };
    row.dedupe_key = buildDedupeKey(row);

    // 4) Duplicate detection (warn, don't block).
    let duplicateOf = null;
    if (row.dedupe_key) {
      const { data: dupes } = await db
        .from('internal_expenses')
        .select('id, vendor_name, total_amount, expense_date, review_status')
        .eq('dedupe_key', row.dedupe_key)
        .limit(1);
      if (dupes && dupes.length) duplicateOf = dupes[0];
    }

    const { data: inserted, error: insErr } = await db
      .from('internal_expenses')
      .insert(row)
      .select('*')
      .single();
    if (insErr) {
      // Unique idempotency collision (race) — return the existing row.
      if (idemKey && /duplicate key|unique/i.test(insErr.message)) {
        const { data: existing } = await db
          .from('internal_expenses').select('*').eq('idempotency_key', idemKey).maybeSingle();
        if (existing) return res.json({ success: true, data: existing, idempotent_replay: true });
      }
      log.error(`insert failed: ${insErr.message}`);
      return res.status(500).json({ success: false, error: 'Could not save the expense draft.' });
    }

    log.info(`Draft created ${inserted.id} (${inserted.vendor_name || 'unknown'}, ${inserted.extraction_status})`);
    res.status(201).json({
      success: true,
      data: inserted,
      extraction: { ok: extraction.ok, status: extraction.extraction_status, error: extraction.error || null },
      duplicate_of: duplicateOf,
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
// GET /api/admin/expenses/summary — dashboard cards + simple reports
// ---------------------------------------------------------------------------
router.get('/summary', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: all, error } = await db
      .from('internal_expenses')
      .select('total_amount, category, vendor_name, expense_date, recurring, recurrence_frequency, review_status');
    if (error) throw error;

    const approved = all.filter((e) => e.review_status === 'approved');
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
        pending_review_count: all.filter((e) => e.review_status === 'pending').length,
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
    log.info(`Approved ${data.id} (${data.vendor_name}, $${data.total_amount})`);
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
    const patch = {
      review_status: 'rejected',
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
    const { data: exp } = await db.from('internal_expenses').select('file_path').eq('id', req.params.id).maybeSingle();
    if (exp?.file_path) {
      await db.storage.from(BUCKET).remove([exp.file_path]).catch(() => {});
    }
    const { error } = await db.from('internal_expenses').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
