/**
 * Growth OS — Internal Expense Extractor
 *
 * Extracts structured expense data from an uploaded receipt / invoice for the
 * FGA-internal Expense Tracker. Provider-abstracted so the OCR/AI backend can
 * change later without touching the routes.
 *
 *   extractInternalExpenseFromInvoice({ buffer, mimetype, filename })
 *     -> { ok, draft, raw_text, confidence, extraction_status, error }
 *
 * Strategy:
 *   - PDF with a real text layer  -> extract text, ask Claude (text) for JSON.
 *   - Image (jpg/png/heic/webp)   -> normalize via sharp, ask Claude vision.
 *   - Scanned PDF (no text layer) -> graceful manual-entry fallback (file still
 *                                    attached upstream).
 *
 * Always returns strict, defensively-parsed JSON. Never throws on bad AI output
 * — callers get { ok:false } and create a manual-entry draft instead.
 */

const { askClaudeJSON, askClaudeWithImageJSON } = require('../integrations/claude');
const { createLogger } = require('./logger');
const log = createLogger('expense-extractor');

const CATEGORIES = [
  'Software & Tools', 'AI/API Usage', 'SMS/Voice/Communication',
  'Hosting & Infrastructure', 'Domain & Website', 'Marketing',
  'Design/Creative', 'Customer Delivery Cost', 'Contractor/Freelancer',
  'Office/Admin', 'Travel', 'Meals', 'Legal/Professional Services',
  'Taxes/Fees', 'Other',
];

const EXPENSE_TYPES = [
  'Operating expense', 'Customer delivery expense', 'Software subscription',
  'One-time purchase', 'Setup cost', 'Reimbursable', 'Other',
];

const PAYMENT_STATUSES = ['paid', 'unpaid', 'reimbursable', 'pending', 'unknown'];
const RECURRENCE = ['monthly', 'annual', 'quarterly', 'one-time', 'unknown'];
const DOC_TYPES = ['receipt', 'invoice', 'screenshot', 'unknown'];

const VISION_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function buildSystemPrompt() {
  return `You are an expense-extraction assistant for a small business owner's INTERNAL bookkeeping. Extract key fields from the supplied receipt/invoice and return ONLY valid JSON — no prose, no markdown, no code fences. Be conservative: if a field is unclear or absent, use null. Never invent data.

Return JSON with EXACTLY this shape:
{
  "vendor_name": string|null,
  "document_type": "receipt"|"invoice"|"screenshot"|"unknown",
  "document_number": string|null,
  "expense_date": "YYYY-MM-DD"|null,
  "due_date": "YYYY-MM-DD"|null,
  "currency": string|null,
  "subtotal_amount": number|null,
  "tax_amount": number|null,
  "total_amount": number|null,
  "payment_status": "paid"|"unpaid"|"reimbursable"|"pending"|"unknown",
  "category": string|null,
  "expense_type": string|null,
  "recurring": boolean,
  "recurrence_frequency": "monthly"|"annual"|"quarterly"|"one-time"|"unknown",
  "line_items": [ { "description": string|null, "quantity": number|null, "unit_price": number|null, "amount": number|null } ],
  "notes": string|null,
  "confidence": number  // 0..1, your confidence in the overall extraction
}

Pick "category" from EXACTLY ONE of:
${CATEGORIES.join(', ')}

Pick "expense_type" from EXACTLY ONE of:
${EXPENSE_TYPES.join(', ')}

Guidance:
- "total_amount" is the final amount due/paid (after tax).
- If the document is a recurring subscription invoice (e.g. monthly/annual plan), set recurring=true and the matching recurrence_frequency.
- Keep line_items short; omit if not clearly itemized (return []).`;
}

/** Coerce an arbitrary AI value to a finite number or null. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Validate a real YYYY-MM-DD calendar date, else null. */
function isoDate(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, da] = m;
  const dt = new Date(`${y}-${mo}-${da}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  // Guard against JS roll-over (e.g. 2026-02-30 -> Mar 2): require exact round-trip.
  return dt.toISOString().slice(0, 10) === `${y}-${mo}-${da}` ? `${y}-${mo}-${da}` : null;
}

function oneOf(v, allowed, fallback = null) {
  return allowed.includes(v) ? v : fallback;
}

/** Sanitize the raw AI object into our canonical, trusted draft shape. */
function sanitizeDraft(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let lineItems = [];
  if (Array.isArray(r.line_items)) {
    lineItems = r.line_items.slice(0, 25).map((li) => ({
      description: li && typeof li.description === 'string' ? li.description.slice(0, 300) : null,
      quantity: num(li?.quantity),
      unit_price: num(li?.unit_price),
      amount: num(li?.amount),
    }));
  }
  let confidence = num(r.confidence);
  if (confidence === null) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    vendor_name: typeof r.vendor_name === 'string' ? r.vendor_name.slice(0, 200).trim() || null : null,
    document_type: oneOf(r.document_type, DOC_TYPES, 'unknown'),
    document_number: typeof r.document_number === 'string' ? r.document_number.slice(0, 100).trim() || null : null,
    expense_date: isoDate(r.expense_date),
    due_date: isoDate(r.due_date),
    currency: typeof r.currency === 'string' ? r.currency.slice(0, 8).toUpperCase().trim() || 'USD' : 'USD',
    subtotal_amount: num(r.subtotal_amount),
    tax_amount: num(r.tax_amount),
    total_amount: num(r.total_amount),
    payment_status: oneOf(r.payment_status, PAYMENT_STATUSES, 'unknown'),
    category: CATEGORIES.includes(r.category) ? r.category : 'Other',
    expense_type: EXPENSE_TYPES.includes(r.expense_type) ? r.expense_type : 'Operating expense',
    recurring: r.recurring === true,
    recurrence_frequency: oneOf(r.recurrence_frequency, RECURRENCE, 'unknown'),
    line_items: lineItems,
    notes: typeof r.notes === 'string' ? r.notes.slice(0, 1000) : null,
    confidence,
  };
}

/** A draft skeleton used when AI extraction is not possible (manual entry). */
function emptyDraft() {
  return sanitizeDraft({ document_type: 'unknown', confidence: 0 });
}

async function extractFromPdfText(buffer) {
  // Lazy-require so the dependency is only loaded when a PDF is processed.
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch (e) {
    log.warn('pdf-parse not installed — skipping PDF text extraction');
    return { text: '', draft: null };
  }
  let text = '';
  try {
    const parsed = await pdfParse(buffer);
    text = (parsed.text || '').trim();
  } catch (e) {
    log.warn(`pdf-parse failed: ${e.message}`);
    return { text: '', draft: null };
  }
  // Heuristic: a real text layer has meaningful content. Scanned PDFs return
  // little/no text -> caller falls back to manual entry.
  if (text.replace(/\s+/g, '').length < 40) {
    return { text, draft: null };
  }
  const raw = await askClaudeJSON(
    buildSystemPrompt(),
    `Extract the expense fields from this document text and return JSON only:\n\n"""\n${text.slice(0, 12000)}\n"""`,
    { maxTokens: 1200, tenantSlug: 'fga-internal' },
  );
  return { text, draft: sanitizeDraft(raw) };
}

async function extractFromImage(buffer, mimetype) {
  // Normalize to JPEG via sharp: fixes orientation, strips metadata (EXIF/GPS),
  // converts HEIC->JPEG where libvips supports it, and bounds the dimensions so
  // the vision payload stays small.
  let jpegB64;
  try {
    const sharp = require('sharp');
    const out = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    jpegB64 = out.toString('base64');
  } catch (e) {
    log.warn(`sharp normalize failed for ${mimetype}: ${e.message}`);
    // If it was already a Claude-safe raster, try the raw bytes; else bail.
    if (mimetype === 'image/jpeg' || mimetype === 'image/png' || mimetype === 'image/webp') {
      jpegB64 = buffer.toString('base64');
    } else {
      return { text: '', draft: null, error: 'Could not process image. Upload a JPG, PNG, or PDF.' };
    }
  }
  const raw = await askClaudeWithImageJSON(
    buildSystemPrompt(),
    'Extract the expense fields from this receipt/invoice image and return JSON only.',
    jpegB64,
    'image/jpeg',
    { maxTokens: 1200, tenantSlug: 'fga-internal' },
  );
  return { text: '', draft: sanitizeDraft(raw) };
}

/**
 * Main entry point.
 * @param {{buffer: Buffer, mimetype: string, filename?: string}} file
 */
async function extractInternalExpenseFromInvoice(file) {
  const { buffer, mimetype } = file || {};
  if (!buffer || !mimetype) {
    return { ok: false, draft: emptyDraft(), raw_text: '', extraction_status: 'failed', error: 'No file provided' };
  }

  try {
    if (mimetype === 'application/pdf') {
      const { text, draft } = await extractFromPdfText(buffer);
      if (draft) {
        return { ok: true, draft, raw_text: text, confidence: draft.confidence, extraction_status: 'extracted' };
      }
      // Scanned PDF (no usable text layer) — manual entry fallback.
      return {
        ok: false, draft: emptyDraft(), raw_text: text, confidence: 0,
        extraction_status: 'manual',
        error: 'This PDF has no readable text layer (likely a scan). Enter the details manually.',
      };
    }

    if (VISION_MIME.has(mimetype)) {
      const { draft, error } = await extractFromImage(buffer, mimetype);
      if (draft) {
        return { ok: true, draft, raw_text: '', confidence: draft.confidence, extraction_status: 'extracted' };
      }
      return { ok: false, draft: emptyDraft(), raw_text: '', confidence: 0, extraction_status: 'failed', error: error || 'Image extraction failed' };
    }

    return { ok: false, draft: emptyDraft(), raw_text: '', extraction_status: 'failed', error: `Unsupported file type: ${mimetype}` };
  } catch (err) {
    log.warn(`extraction failed: ${err.message}`);
    return { ok: false, draft: emptyDraft(), raw_text: '', confidence: 0, extraction_status: 'failed', error: 'Automatic extraction failed. Enter the details manually.' };
  }
}

module.exports = {
  extractInternalExpenseFromInvoice,
  // Exported for unit tests:
  sanitizeDraft,
  emptyDraft,
  CATEGORIES,
  EXPENSE_TYPES,
  PAYMENT_STATUSES,
  RECURRENCE,
  DOC_TYPES,
};
