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

module.exports = { buildDedupeKey, validateForApproval, isLowConfidence };
