/**
 * Growth OS — Internal Expense validation & dedupe helpers (pure functions).
 * Kept dependency-free so they can be unit-tested in isolation.
 */

/** Build a stable fingerprint used to detect obvious duplicate uploads. */
function buildDedupeKey(row) {
  const vendor = (row.vendor_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const docnum = (row.document_number || '').toLowerCase().trim();
  const date = row.expense_date || '';
  const total = row.total_amount != null ? Number(row.total_amount).toFixed(2) : '';
  if (!vendor && !docnum && !total) return null;
  return [vendor, docnum, date, total].join('|');
}

/**
 * Validate a draft prior to APPROVAL. Returns { ok, errors: string[] }.
 * Required: vendor_name, total_amount (numeric), expense_date (plausible).
 */
function validateForApproval(row) {
  const errors = [];

  if (!row.vendor_name || !String(row.vendor_name).trim()) {
    errors.push('Vendor name is required before approval.');
  }

  const total = row.total_amount;
  if (total === null || total === undefined || total === '') {
    errors.push('Total amount is required before approval.');
  } else if (!Number.isFinite(Number(total))) {
    errors.push('Total amount must be a number.');
  } else if (Number(total) < 0) {
    errors.push('Total amount cannot be negative.');
  }

  if (!row.expense_date) {
    errors.push('Expense date is required before approval.');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.expense_date))) {
    errors.push('Expense date must be in YYYY-MM-DD format.');
  } else {
    const d = new Date(row.expense_date + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) {
      errors.push('Expense date is not a valid date.');
    } else {
      // Not implausibly far in the future (allow small clock skew: 2 days).
      const maxFuture = Date.now() + 2 * 24 * 60 * 60 * 1000;
      if (d.getTime() > maxFuture) {
        errors.push('Expense date is too far in the future.');
      }
      // Not absurdly old.
      if (d.getUTCFullYear() < 2015) {
        errors.push('Expense date is implausibly old.');
      }
    }
  }

  // If line items exist, sanity-check that they roughly sum to subtotal/total.
  if (Array.isArray(row.line_items) && row.line_items.length > 0) {
    const liSum = row.line_items.reduce((s, li) => s + (Number(li.amount) || 0), 0);
    const target = Number(row.subtotal_amount) || Number(row.total_amount) || 0;
    if (target > 0 && liSum > 0) {
      const diff = Math.abs(liSum - target);
      const tolerance = Math.max(0.5, target * 0.05); // 5% or 50c, whichever larger
      if (diff > tolerance) {
        errors.push(`Line items ($${liSum.toFixed(2)}) do not sum to the subtotal/total ($${target.toFixed(2)}).`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** True when confidence is low enough to visually flag "Needs Review". */
function isLowConfidence(confidence) {
  const c = Number(confidence);
  return Number.isFinite(c) && c < 0.6;
}

// ---------------------------------------------------------------------------
// Boundary sanitizers — AI/OCR output is untrusted text. These coerce raw
// extracted fields into values the Postgres column types accept, returning
// null when a value can't be safely cast (so the draft falls back to manual
// entry instead of failing the whole insert).
// ---------------------------------------------------------------------------

/** Coerce a value to a 'YYYY-MM-DD' string the DATE column accepts, else null. */
function toNullableDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let iso = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    iso = s;
  } else {
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) iso = parsed.toISOString().slice(0, 10);
  }
  if (!iso) return null;
  const check = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(check.getTime())) return null;
  // Reject calendar roll-over (e.g. 2026-02-30 -> Mar 2): require exact round-trip.
  return check.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Strip currency symbols/commas and coerce to a number the NUMERIC column accepts, else null. */
function toNullableAmount(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Normalize AI confidence into [0, 0.999] so it fits NUMERIC(4,3); handles 0-100 scales. */
function normalizeConfidence(v) {
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 1) n = n / 100; // many models report 0-100
  if (n < 0) n = 0;
  if (n > 0.999) n = 0.999; // NUMERIC(4,3) ceiling
  return Math.round(n * 1000) / 1000;
}

module.exports = {
  buildDedupeKey,
  validateForApproval,
  isLowConfidence,
  toNullableDate,
  toNullableAmount,
  normalizeConfidence,
};
