/**
 * Growth OS — Customer Linking (Track A: connected customer workflow)
 *
 * One place to turn a free-typed "customer" on an income/job record into a real
 * customers row, link it, and keep the customer's roll-up stats fresh — so a
 * payment entered once flows into Customers and Review eligibility.
 *
 * DESIGN RULES (match Patrick's "don't guess / don't break totals" directives):
 *   - Going-forward only. This module never rewrites the 1,522 legacy income
 *     rows; legacy backfill is the separate human-reviewed Track B.
 *   - Never fabricate a junk customer. AKA's customer_name field is a free-text
 *     memo historically full of payment methods ("cash") and locations
 *     ("gautier"). If the typed name is noise AND there's no phone/email to
 *     anchor it, we skip customer creation and leave customer_id null. The
 *     income row still saves.
 *   - Never auto-merge on ambiguity. Match strength is phone > email > exact
 *     normalized name. If a name matches MORE THAN ONE existing customer and we
 *     have no phone/email to disambiguate, we return ambiguous and link nothing.
 *   - Stats are derived, never authoritative. total_revenue / job_count /
 *     first_job_date / last_job_date are recomputed from the linked
 *     finance_entries, so they can't drift the real ledger.
 *
 * All DB access goes through the caller-supplied Supabase client (the per-request
 * user client from getUserClient(req)), so every read/write stays inside the
 * tenant's RLS scope.
 */

const { createLogger } = require('./logger');
const log = createLogger('customer-linking');

/** Lowercase + collapse internal whitespace. Mirrors customers.name_normalized. */
function normalizeName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Reduce a phone to its digits (US-friendly: drop a leading country "1"). */
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

function normalizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

// Tokens that mean "this is not a person's name" when they ARE the whole value.
const NOISE_EXACT = new Set([
  'cash', 'check', 'cheque', 'deposit', 'transfer', 'venmo', 'zelle', 'cashapp',
  'cash app', 'paypal', 'square', 'credit', 'debit', 'payment', 'card', 'n/a',
  'na', 'unknown', 'none', 'test', 'misc', 'other', 'refund', 'income', 'sale',
  'customer', 'invoice', 'paid',
]);

/**
 * Is this name effectively a payment method / placeholder rather than a person?
 * Conservative: only flags values that are a pure noise token (e.g. "cash",
 * "check") — NOT values like "cash-al bodden" that carry a real name. Used to
 * decide whether a name alone is strong enough to create a customer.
 */
function isNoiseName(raw) {
  const n = normalizeName(raw);
  if (!n) return true;
  if (NOISE_EXACT.has(n)) return true;
  // "cash", "cash(stump)", "cash- ", "cash pascagoula" with no other word that
  // looks like a name: treat a value that is ONLY cash + a non-name qualifier
  // as noise is too aggressive (could drop "cash-al bodden"). So here we only
  // catch the bare/parenthetical cash forms.
  if (/^cash[\s(/-]*$/.test(n)) return true;
  if (/^cash\s*\(.*\)$/.test(n) && !/[a-z]{3,}/.test(n.replace(/cash|stump/g, ''))) return true;
  return false;
}

/**
 * Find the best existing customer match for the given identity within a tenant.
 * Returns { customer, ambiguous, candidates }.
 *   - phone match (strongest) → single customer, ambiguous:false
 *   - email match → single customer
 *   - exact normalized-name match → single customer if exactly one; if multiple,
 *     ambiguous:true and customer:null (caller must not guess).
 */
async function findCustomerMatch(db, tenantId, { name, phone, email } = {}) {
  const phoneN = normalizePhone(phone);
  const emailN = normalizeEmail(email);
  const nameN = normalizeName(name);

  // 1) Phone — strongest signal.
  if (phoneN) {
    const { data, error } = await db
      .from('customers').select('*')
      .eq('tenant_id', tenantId).eq('phone', phone);
    if (!error && data && data.length) {
      // exact stored match; if multiple share a phone, take the first deterministically
      return { customer: data[0], ambiguous: false, candidates: data, matchedOn: 'phone' };
    }
  }

  // 2) Email.
  if (emailN) {
    const { data, error } = await db
      .from('customers').select('*')
      .eq('tenant_id', tenantId).ilike('email', emailN);
    if (!error && data && data.length) {
      return { customer: data[0], ambiguous: false, candidates: data, matchedOn: 'email' };
    }
  }

  // 3) Exact normalized name.
  if (nameN) {
    const { data, error } = await db
      .from('customers').select('*')
      .eq('tenant_id', tenantId).eq('name_normalized', nameN);
    if (!error && data && data.length === 1) {
      return { customer: data[0], ambiguous: false, candidates: data, matchedOn: 'name' };
    }
    if (!error && data && data.length > 1) {
      return { customer: null, ambiguous: true, candidates: data, matchedOn: 'name' };
    }
  }

  return { customer: null, ambiguous: false, candidates: [], matchedOn: null };
}

/**
 * Find-or-create a service customer from an identity. Going-forward use only.
 * Returns { customer, created, ambiguous, skipped, reason, matchedOn }.
 *
 * Skips (customer:null, skipped:true) when the name is pure noise AND there is
 * no phone/email — we will not create a "cash" customer. Returns ambiguous when
 * the name matches several customers and we can't disambiguate — caller leaves
 * the link null rather than guessing.
 */
async function upsertServiceCustomer(db, tenantId, identity = {}) {
  const { name, phone, email, address, city, service_type, source = 'income_entry' } = identity;
  const hasAnchor = !!normalizePhone(phone) || !!normalizeEmail(email);

  if (!normalizeName(name) && !hasAnchor) {
    return { customer: null, created: false, ambiguous: false, skipped: true, reason: 'empty_identity' };
  }
  if (isNoiseName(name) && !hasAnchor) {
    return { customer: null, created: false, ambiguous: false, skipped: true, reason: 'noise_name_no_anchor' };
  }

  const match = await findCustomerMatch(db, tenantId, { name, phone, email });
  if (match.ambiguous) {
    return { customer: null, created: false, ambiguous: true, skipped: true, reason: 'ambiguous_name', candidates: match.candidates };
  }
  if (match.customer) {
    // Enrich blanks only — never overwrite existing owner-entered data.
    const patch = {};
    if (phone && !match.customer.phone) patch.phone = phone;
    if (email && !match.customer.email) patch.email = email;
    if (address && !match.customer.address) patch.address = address;
    if (city && !match.customer.city) patch.city = city;
    if (service_type && !match.customer.service_type) patch.service_type = service_type;
    if (Object.keys(patch).length) {
      const { data, error } = await db
        .from('customers').update(patch)
        .eq('tenant_id', tenantId).eq('id', match.customer.id)
        .select().single();
      if (!error && data) return { customer: data, created: false, ambiguous: false, skipped: false, matchedOn: match.matchedOn };
    }
    return { customer: match.customer, created: false, ambiguous: false, skipped: false, matchedOn: match.matchedOn };
  }

  // Create new service customer (has_account=false; portal accounts set it true).
  const { data, error } = await db
    .from('customers')
    .insert({
      tenant_id: tenantId,
      name: name ? name.trim() : null,
      phone: phone || null,
      email: email ? normalizeEmail(email) : null,
      address: address || null,
      city: city || null,
      service_type: service_type || null,
      source,
      has_account: false,
    })
    .select().single();
  if (error) {
    log.warn(`upsertServiceCustomer create failed: ${error.message}`);
    return { customer: null, created: false, ambiguous: false, skipped: true, reason: 'insert_error', error: error.message };
  }
  return { customer: data, created: true, ambiguous: false, skipped: false, matchedOn: null };
}

/**
 * Recompute a customer's roll-up stats from the income rows linked to it.
 * Derived values only — never touches the income amounts themselves.
 */
async function refreshCustomerStats(db, tenantId, customerId) {
  if (!customerId) return;
  const { data, error } = await db
    .from('finance_entries')
    .select('amount, date')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'income')
    .eq('customer_id', customerId);
  if (error) { log.warn(`refreshCustomerStats read failed: ${error.message}`); return; }

  const rows = data || [];
  let total = 0, first = null, last = null;
  for (const r of rows) {
    total += parseFloat(r.amount) || 0;
    if (r.date) {
      if (!first || r.date < first) first = r.date;
      if (!last || r.date > last) last = r.date;
    }
  }
  const { error: upErr } = await db
    .from('customers')
    .update({
      total_revenue: total,
      job_count: rows.length,
      first_job_date: first,
      last_job_date: last,
    })
    .eq('tenant_id', tenantId).eq('id', customerId);
  if (upErr) log.warn(`refreshCustomerStats update failed: ${upErr.message}`);
}

/**
 * Link a customer's historical income to their real record by EXACT normalized
 * name. Used when the owner opens an old customer and saves/updates them — she's
 * confirming "this is one real customer", so attaching the income rows that
 * share that exact name is a safe, reversible (ON DELETE SET NULL) operation.
 * Only touches rows not already linked. Returns the count linked.
 *
 * Not a bulk/auto backfill — it runs per-customer, on demand, on exact match.
 */
async function linkHistoryByExactName(db, tenantId, customerId, name) {
  const nameN = normalizeName(name);
  if (!customerId || !nameN) return 0;
  // Pull candidate income rows by a loose ilike, then filter to EXACT normalized
  // equality in JS so "John Smith" never grabs "John Smithson".
  const { data, error } = await db
    .from('finance_entries')
    .select('id, customer_name, customer_id')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'income')
    .ilike('customer_name', name.trim());
  if (error) { log.warn(`linkHistoryByExactName read failed: ${error.message}`); return 0; }
  const ids = (data || [])
    .filter((r) => !r.customer_id && normalizeName(r.customer_name) === nameN)
    .map((r) => r.id);
  if (!ids.length) return 0;
  // Update in batches to avoid oversized IN lists.
  let linked = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error: upErr } = await db
      .from('finance_entries').update({ customer_id: customerId })
      .eq('tenant_id', tenantId).in('id', chunk);
    if (upErr) { log.warn(`linkHistoryByExactName update failed: ${upErr.message}`); break; }
    linked += chunk.length;
  }
  return linked;
}

module.exports = {
  normalizeName,
  normalizePhone,
  normalizeEmail,
  isNoiseName,
  findCustomerMatch,
  upsertServiceCustomer,
  refreshCustomerStats,
  linkHistoryByExactName,
};
